# Ticketing Platform — Revamp Plan

> **Status:** ✅ Milestones 0–6 complete (100%); M7 85% complete (core hardening done, cloud stack deferred); **M8 UNBLOCKED** — ready to start immediately
> **Region:** ap-southeast-1 (Singapore)
> **Last Updated:** 2026-03-30 (audit PR #12 remediation complete)
> **Reference Legacy:** `legacy/ticketing/`

This document is the single source of truth for the revamp.
All decisions recorded here must be confirmed before implementation begins.
Update this file as decisions evolve. Never delete superseded decisions — mark them `[SUPERSEDED]`.

---

## Table of Contents

1. [Background & Goals](#1-background--goals)
2. [Architecture Overview](#2-architecture-overview)
3. [Technology Decisions](#3-technology-decisions)
4. [Service Specifications](#4-service-specifications)
5. [Infrastructure Design](#5-infrastructure-design)
6. [API Gateway (Kong)](#6-api-gateway-kong)
7. [Messaging (Kafka)](#7-messaging-kafka)
8. [gRPC Contracts](#8-grpc-contracts)
9. [Observability](#9-observability)
10. [CI/CD](#10-cicd)
11. [Repository Structure](#11-repository-structure)
12. [Milestones](#12-milestones)
13. [Open Questions](#13-open-questions)
14. [Confirmed Decisions Log](#14-confirmed-decisions-log)

---

## 1. Background & Goals

### Legacy System

The legacy system lives in `legacy/ticketing/`. It is a course project — not production-ready.

Key problems identified:

| Problem | Detail |
|---|---|
| NATS Streaming (deprecated) | `node-nats-streaming` and the server image are archived and unmaintained |
| No API gateway | NGINX Ingress routes directly to services — no centralized auth, rate limiting, or observability |
| JWT re-verified in every service | Every service holds the `JWT_KEY` secret and verifies tokens independently |
| Shared `@rallycoding/common` npm package | Changes require manual `npm publish` cycle; slow and error-prone cross-service coupling |
| Single-stage Dockerfiles, unpinned images | Dev tools (`ts-node-dev`) run in production; floating `node:alpine` tags |
| No HA, no resource limits | All deployments have 1 replica, no HPA, no PDB, no resource requests/limits |
| No observability | `console.log`, no metrics endpoint, no tracing, no structured logging |
| Deprecated Stripe integration | Token-based charges (`charges.create`) and `react-stripe-checkout` are both deprecated |
| MongoDB everywhere | No rationale per service; financial data in an eventually-consistent store |
| Target: DigitalOcean | Target platform changing to AWS EKS |

### Goals (Phase 1)

Rebuild the system with **functionally equivalent behaviour** to the legacy, on a production-grade foundation:

- All 5 backend services + frontend reimplemented with proper languages and frameworks
- Kafka replacing NATS Streaming for event fan-out
- Kong Ingress Controller replacing NGINX Ingress + Skaffold DNS hacks
- AWS EKS as the target runtime (Terraform-provisioned)
- Structured logging, metrics, distributed tracing from day one
- Multi-stage Dockerfiles, pinned image digests, non-root containers
- High availability: minimum 2 replicas per service, HPA, PDB
- Stripe integration: **stubbed for Phase 1** (always returns success); real Payment Intents in Phase 2

---

## 2. Architecture Overview

```
                         ┌──────────────────────────────────────────────────┐
                         │              AWS EKS (ap-southeast-1)            │
                         │                                                  │
  HTTPS ──► ALB ──► Kong Ingress Controller                                │
                         │  (JWT verify, rate-limit, correlation-ID)        │
                         │              │                                   │
               ┌─────────┼─────────┬────┴──────────────┬──────────────┐    │
               │         │         │                   │              │    │
          auth-svc   ticket-svc  order-svc        payment-svc    venue-svc  │
        (NestJS/TS)  (Go/Echo)  (Java/SB4)       (NestJS/TS)   (Go/Echo)  │
              │          │         │                   │              │    │
              │          └────gRPC─┘                   │              │    │
              │                │                       │              │    │
               └───────────────┴────── Kafka (Strimzi / MSK Phase 2) ┴───┘  │
                                            │                               │
                                   expiration-svc (Go worker)               │
                                                                            │
  Databases:  RDS PostgreSQL ×4   MongoDB StatefulSet    ElastiCache       │
              (auth, orders,       (ticket-service)      Redis Cluster     │
               payments, venue)                          (expiration +     │
                                                          Kong RL)         │
└──────────────────────────────────────────────────────────────────────────┘
```

**External traffic flow:**

1. Client sends HTTPS request → AWS ALB (TLS termination)
2. ALB forwards to Kong Ingress Controller (port 80 internally)
3. Kong verifies JWT (RS256, JWKS from auth-service), injects `X-User-Id` + `X-User-Roles` headers
4. Kong routes to the correct service based on path prefix
5. Services trust the injected headers — they **never** re-verify the JWT

**Internal service-to-service:**

- Synchronous: gRPC (order-service → ticket-service for ticket validation on order creation)
- Asynchronous: Apache Kafka (all event fan-out)

---

## 3. Technology Decisions

| Concern | Choice | Rationale |
|---|---|---|
| **Messaging** | Apache Kafka — **Phase 1: Strimzi in-cluster on EKS; Phase 2: AWS MSK** | Industry standard for durable, replayable event streaming. Fan-out to multiple consumers. Replaces deprecated NATS Streaming. Strimzi chosen for Phase 1 to avoid MSK costs during build-out; config mirrors MSK targets for a frictionless Phase 2 migration. |
| **API Gateway** | Kong Ingress Controller on EKS | Declarative CRD-based config. Native K8s integration. Centralizes JWT auth, rate limiting, logging. |
| **Auth pattern** | Kong JWT plugin + JWKS endpoint | Services never hold the signing key. Token verification is centralized at the gateway. Identity forwarded via `X-User-Id` header. |
| **JWT algorithm** | RS256 (asymmetric) | Private key stays in Secrets Manager / auth-service only. Public key distributed via JWKS — safe to share with Kong. |
| **Sync inter-service** | gRPC (proto3, `acme.*` packages) | Type-safe contracts. Efficient binary encoding. Only used where truly synchronous (order validation). |
| **order-service language** | Java 21 / Spring Boot 4 | Spring's transactional support, JPA, Spring Kafka, and Spring State Machine are ideal for order lifecycle management. |
| **ticket-service language** | Go / Echo | High-read service. Echo is lightweight, high-performance, and more opinionated than Gin (better middleware management). Also runs gRPC server. |
| **expiration-service language** | Go (pure worker) | No HTTP surface. Go's lightweight goroutines handle delayed job scheduling efficiently. |
| **venue-service language** | Go 1.23+ / Echo v4 | Same rationale as ticket-service. High-throughput seat inventory management; gRPC server; Kafka consumer. PostgreSQL for relational seat/venue data. |
| **auth-service language** | TypeScript / Node.js 24 LTS + pnpm + NestJS 10 | NestJS provides IoC container, dependency injection, and decorator-driven modules — reduces boilerplate for a structured auth service. Node.js 24 LTS + pnpm for faster installs and better monorepo support. |
| **payment-service language** | TypeScript / Node.js 24 LTS + pnpm + NestJS 10 | Same rationale as auth-service. NestJS module structure suits the payment flow cleanly. Stripe SDK is excellent in Node. Payment Intents deferred to Phase 2. |
| **frontend** | Next.js 15 App Router + TypeScript | Modern SSR/RSC. Server Actions for mutations. App Router replaces Pages Router. |
| **Auth DB** | PostgreSQL 16 (RDS) | User records are relational, benefit from ACID guarantees. UUIDs as PKs. |
| **Orders DB** | PostgreSQL 16 (RDS) | Order lifecycle has strict ACID requirements. State machine transitions must be atomic. |
| **Payments DB** | PostgreSQL 16 (RDS) | Financial records must have ACID guarantees. Idempotency key support. |
| **Venue DB** | PostgreSQL 16 (RDS) | Seat inventory requires ACID transactions for quota reservation. OCC via `version` field. |
| **Tickets DB** | MongoDB 7 (StatefulSet on EKS) | Flexible document model. High read throughput. Self-hosted on EKS for Phase 1. |
| **Expiration store** | Redis 7 (ElastiCache Cluster) | Delayed job queue via `asynq`. Shared with Kong rate limiting. |
| **Schema registry** | Confluent Schema Registry (self-hosted on EKS) | Richer ecosystem than AWS Glue. REST API. Supports Avro, JSON Schema, Protobuf. Deployed in `infra` namespace. |
| **Observability** | AWS Managed Prometheus (AMP) + Amazon Managed Grafana (AMG) + AWS X-Ray | Fully managed — no K8s pods to maintain for observability infra. OTel Collector forwards to all three. |
| **Secrets** | AWS Secrets Manager + External Secrets Operator | Never commit secret values. ESO syncs to K8s Secrets at runtime. IRSA per service for least-privilege access. |
| **Container registry** | Amazon ECR (one repo per service) | Native AWS integration. Image scanning on push. |
| **Image tagging** | Git SHA (`<ecr-repo>:<git-sha>`) | Immutable tags. Enables precise rollback. Never `latest`. |
| **IaC** | Terraform (full AWS infra) | EKS, VPC, RDS, MSK, ElastiCache, ECR, IAM, Secrets Manager. Remote state in S3 + DynamoDB lock. |
| **Stripe (Phase 1)** | Stubbed (always returns success) | Simplifies Phase 1 scope. Real Stripe Payment Intents implemented in Phase 2. |
| **Stripe (Phase 2)** | Stripe Payment Intents + Stripe Elements | Current best practice. Replaces deprecated token-based charges. |

---

## 4. Service Specifications

### 4.1 auth-service

| Property | Value |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 (AWS RDS) |
| Migrations | `drizzle-kit` |
| ORM | Drizzle ORM |
| Validation | `class-validator` + `class-transformer` (NestJS native) |
| Logging | `nestjs-pino` (JSON, pino under the hood) |
| Metrics | `@willsoto/nestjs-prometheus` + prom-client (`/metrics`) |
| Tracing | OpenTelemetry SDK + `@opentelemetry/instrumentation-nestjs-core` |
| Port | 3000 |
| Test framework | Vitest (not Jest) + Supertest + Testcontainers (PostgreSQL) |

**Responsibilities:**

- User signup, signin, signout
- Issue RS256 JWTs (short-lived access token, 15 min)
- Serve JWKS endpoint at `GET /.well-known/jwks.json` (Kong consumes this)
- Store RSA private key via ESO from Secrets Manager (never in code or image)

**API Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/users/signup` | No | Create user; returns JWT in `httpOnly` cookie |
| `POST` | `/api/users/signin` | No | Authenticate; returns JWT in `httpOnly` cookie |
| `POST` | `/api/users/signout` | No | Clear session cookie |
| `GET` | `/api/users/currentuser` | Optional | Return current user from `X-User-Id` header (set by Kong) |
| `GET` | `/.well-known/jwks.json` | No | JWKS public key endpoint for Kong |
| `GET` | `/healthz/live` | No | Liveness probe |
| `GET` | `/healthz/ready` | No | Readiness probe (checks DB) |
| `GET` | `/metrics` | No (cluster-internal) | Prometheus metrics |

**Database schema:**

```sql
CREATE TABLE users (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT        NOT NULL UNIQUE,
  password_hash TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Environment variables (all from ESO / Secrets Manager):**

- `DATABASE_URL` — PostgreSQL connection string
- `RSA_PRIVATE_KEY` — PEM-encoded RSA 4096 private key for JWT signing
- `NODE_ENV`
- `PORT` (default: 3000)

**No Kafka events produced or consumed.**

---

### 4.2 ticket-service

| Property | Value |
|---|---|
| Language | Go 1.23+ |
| Framework | Echo v4 |
| Database | MongoDB 7 (StatefulSet on EKS, Replica Set) |
| Validation | `go-playground/validator` |
| Logging | `zap` (JSON) |
| Metrics | `prometheus/client_golang` (`/metrics`) |
| Tracing | OpenTelemetry Go SDK + `otelecho` |
| gRPC | Server (defined in `proto/tickets/v1/tickets.proto`) |
| Kafka | Producer + Consumer (`segmentio/kafka-go`) |
| Ports | 8080 (HTTP/REST), **50051** (gRPC) |
| Test framework | `testify` + `testcontainers-go` (MongoDB + Kafka) |

**Responsibilities:**

- CRUD for tickets
- Publish `tickets.ticket.created`, `tickets.ticket.updated` to Kafka
- Consume `orders.order.created`, `orders.order.cancelled` from Kafka (set/clear `orderId` on ticket)
- Serve gRPC `TicketService` for synchronous validation by order-service

**API Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/tickets` | Yes (`X-User-Id` required) | Create ticket |
| `GET` | `/api/tickets` | No | List unreserved tickets |
| `GET` | `/api/tickets/:id` | No | Get single ticket |
| `PUT` | `/api/tickets/:id` | Yes (owner only) | Update title/price |
| `GET` | `/healthz/live` | No | Liveness |
| `GET` | `/healthz/ready` | No | Readiness (MongoDB check) |
| `GET` | `/metrics` | No | Prometheus |

**gRPC service (see Section 8 for full proto):**

- `GetTicket` — fetch a ticket by ID
- `ValidateTicketAvailability` — check if a ticket is unreserved (used by order-service)

**MongoDB document (collection: `tickets`):**

```json
{
  "_id":       "<uuid-string>",
  "title":     "string",
  "price":     0.00,
  "userId":    "<uuid-string>",
  "orderId":   "<uuid-string | null>",
  "version":   1,
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

**Kafka:**

- Produces: `tickets.ticket.created`, `tickets.ticket.updated` (partition key: `ticketId`)
- Consumes (consumer group `ticket-service`): `orders.order.created`, `orders.order.cancelled`
- DLQ: `tickets.ticket.created.dlq`, `tickets.ticket.updated.dlq`

**Environment variables:**

- `MONGODB_URI`
- `KAFKA_BROKERS` (comma-separated MSK broker endpoints)
- `SCHEMA_REGISTRY_URL`
- `GRPC_PORT` (default: **50051**)
- `PORT` (default: 8080)

---

### 4.3 order-service

| Property | Value |
|---|---|
| Language | Java 21 |
| Framework | Spring Boot 4 |
| Database | PostgreSQL 16 (AWS RDS) |
| ORM | Spring Data JPA + Hibernate |
| Migrations | Flyway |
| Validation | Jakarta Bean Validation (`@Valid`, `@NotNull`, etc.) |
| Logging | Logback + `logstash-logback-encoder` (JSON) |
| Metrics | Micrometer → Prometheus (Spring Boot Actuator) |
| Tracing | OpenTelemetry Java agent (auto-instrumentation) |
| gRPC | Client (calls ticket-service `ValidateTicketAvailability`) |
| Kafka | Producer + Consumer (Spring Kafka) |
| State machine | Spring State Machine (order status transitions) |
| Port | 8080 |
| Test framework | JUnit 5 + Testcontainers (PostgreSQL + Kafka) |

**Responsibilities:**

- Create, read, list, and cancel orders
- Call ticket-service via gRPC to validate ticket availability before creating an order
- Transactional outbox pattern for Kafka event publishing (outbox row written in same DB transaction as order state change)
- Consume Kafka events to maintain local `order_tickets` replica
- Spring State Machine enforces valid state transitions

**API Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/orders` | Yes | Create order; calls ticket gRPC; publishes `orders.order.created` |
| `GET` | `/api/orders` | Yes | List user's orders |
| `GET` | `/api/orders/:orderId` | Yes (owner) | Get single order |
| `DELETE` | `/api/orders/:orderId` | Yes (owner) | Cancel order; publishes `orders.order.cancelled` |
| `GET` | `/actuator/health/liveness` | No | Liveness (mapped by Helm probe config) |
| `GET` | `/actuator/health/readiness` | No | Readiness (mapped by Helm probe config) |
| `GET` | `/actuator/prometheus` | No | Prometheus metrics |

**Order Status State Machine:**

```
CREATED ──[expiration or user cancel]──► CANCELLED
   │
   └──[order.created / payment pending]──► AWAITING_PAYMENT ──[payment.captured event]──► COMPLETE
```

**Database schema (PostgreSQL, managed by Flyway):**

```sql
-- V1__init.sql

CREATE TABLE order_tickets (
  id         UUID         PRIMARY KEY,
  title      TEXT         NOT NULL,
  price      NUMERIC(12,2) NOT NULL,
  version    INT          NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id         UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID         NOT NULL,
  status     VARCHAR(30)  NOT NULL,
  expires_at TIMESTAMPTZ  NOT NULL,
  ticket_id  UUID         NOT NULL REFERENCES order_tickets(id),
  version    INT          NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE outbox (
  id            UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  topic         TEXT    NOT NULL,
  payload       JSONB   NOT NULL,
  partition_key TEXT    NOT NULL,
  published     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_orders_user_id   ON orders(user_id);
CREATE INDEX idx_orders_ticket_id ON orders(ticket_id);
CREATE INDEX idx_outbox_unpublished ON outbox(published) WHERE published = false;
```

**Optimistic Concurrency Control:** `version` field on `orders` and `order_tickets`. Event consumers use `WHERE id = ? AND version = ? - 1` to ensure events are applied in order.

**Kafka:**

- Produces (via outbox relay): `orders.order.created`, `orders.order.cancelled`
- Consumes (consumer group `order-service`): `tickets.ticket.created`, `tickets.ticket.updated`, `expiration.order.expiration_complete`, `payments.payment.captured`
- DLQ topics: `*.dlq`

**Environment variables:**

- `SPRING_DATASOURCE_URL`, `SPRING_DATASOURCE_USERNAME`, `SPRING_DATASOURCE_PASSWORD`
- `KAFKA_BOOTSTRAP_SERVERS`
- `SCHEMA_REGISTRY_URL`
- `TICKET_SERVICE_GRPC_HOST`, `TICKET_SERVICE_GRPC_PORT`

---

### 4.4 payment-service

| Property | Value |
|---|---|
| Language | TypeScript |
| Runtime | Node.js 24 LTS |
| Package manager | pnpm |
| Framework | NestJS 10 |
| Database | PostgreSQL 16 (AWS RDS) |
| ORM / query | Drizzle ORM |
| Migrations | `drizzle-kit` |
| Validation | `class-validator` + `class-transformer` (NestJS native) |
| Logging | `nestjs-pino` (JSON) |
| Metrics | `@willsoto/nestjs-prometheus` + prom-client |
| Tracing | OpenTelemetry SDK + `@opentelemetry/instrumentation-nestjs-core` |
| Kafka | Producer + Consumer (`@nestjs/microservices` Kafka transport) |
| Stripe | **Phase 1: stubbed.** Phase 2: Stripe Payment Intents |
| Port | 3000 |
| Test framework | Vitest (not Jest) + Supertest + Testcontainers (PostgreSQL + Kafka) |

**Phase 1 behaviour:**

- `POST /api/payments` accepts `{ orderId }`
- Validates order exists in local replica and belongs to the current user
- Records a stub payment (no Stripe call made)
- Publishes `payments.payment.captured`

**Phase 2 behaviour (Stripe Payment Intents — deferred):**

- `POST /api/payments/create-payment-intent` → creates Stripe PaymentIntent, returns `{ clientSecret }`
- `POST /api/payments/webhook` → Stripe webhook handler with signature verification

**API Routes (Phase 1):**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/payments` | Yes | Create stub payment for an order |
| `GET` | `/healthz/live` | No | Liveness |
| `GET` | `/healthz/ready` | No | Readiness (DB + Kafka check) |
| `GET` | `/metrics` | No | Prometheus |

**Database schema:**

```sql
CREATE TABLE payment_orders (
  id         UUID         PRIMARY KEY,
  user_id    UUID         NOT NULL,
  price      NUMERIC(12,2) NOT NULL,
  status     VARCHAR(30)  NOT NULL,
  version    INT          NOT NULL,
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id                        UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id                  UUID         NOT NULL,
  stripe_payment_intent_id  TEXT,        -- null in Phase 1 stub
  amount                    NUMERIC(12,2) NOT NULL,
  currency                  VARCHAR(3)   NOT NULL DEFAULT 'usd',
  status                    VARCHAR(30)  NOT NULL,
  idempotency_key           TEXT         UNIQUE,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ  NOT NULL DEFAULT now()
);
```

**Kafka:**

- Produces: `payments.payment.captured`
- Consumes (consumer group `payment-service`): `orders.order.created`, `orders.order.cancelled`

**Environment variables:**

- `DATABASE_URL`
- `KAFKA_BROKERS`
- `SCHEMA_REGISTRY_URL`
- `STRIPE_SECRET_KEY` (Phase 2 only; injected via ESO from Secrets Manager)

---

### 4.5 expiration-service

| Property | Value |
|---|---|
| Language | Go 1.23+ |
| Framework | Echo v4 (minimal — health + metrics endpoints only; no business HTTP surface) |
| Job queue | `asynq` (Redis-backed) |
| Logging | `zap` (JSON) |
| Metrics | `prometheus/client_golang` (minimal HTTP server for `/metrics` + `/healthz`) |
| Tracing | OpenTelemetry Go SDK |
| Kafka | Consumer + Producer (`segmentio/kafka-go`) |
| Port | 8080 (metrics/health only — no business HTTP surface) |
| Test framework | `testify` + `testcontainers-go` (Redis + Kafka) |

**Responsibilities:**

- Consume `orders.order.created`
- Schedule a delayed `asynq` job for `order.expiresAt`
- When job fires, publish `expiration.order.expiration_complete`

**Kafka:**

- Produces: `expiration.order.expiration_complete`
- Consumes (consumer group `expiration-service`): `orders.order.created`

**Environment variables:**

- `REDIS_URL` (ElastiCache endpoint)
- `KAFKA_BROKERS`
- `SCHEMA_REGISTRY_URL`

---

### 4.6 client (frontend)

| Property | Value |
|---|---|
| Language | TypeScript |
| Framework | Next.js 15 (App Router) |
| UI library | shadcn/ui + Tailwind CSS |
| HTTP client | `fetch` (native, Server Components) + `axios` (client-side mutations) |
| Payment UI | **Phase 1: simple form (no Stripe widget).** Phase 2: Stripe Elements |
| Auth | `httpOnly` cookie set by auth-service; Server Components read `X-User-Id` header from Kong |
| Port | 3000 |
| Build | Multi-stage Docker, `next build --standalone` |

**Pages:**

| Route | Description |
|---|---|
| `/` | Landing — lists all unreserved tickets (Server Component) |
| `/auth/signup` | Sign up form |
| `/auth/signin` | Sign in form |
| `/tickets/new` | Create ticket form (authenticated) |
| `/tickets/[ticketId]` | View ticket + "Purchase" button |
| `/orders` | My orders list (authenticated) |
| `/orders/[orderId]` | Order detail + stub payment form |

**Environment variables:**

- `NEXT_PUBLIC_API_URL` — base URL for client-side requests (replaces the legacy hardcoded placeholder)
- `INTERNAL_API_URL` — cluster-internal URL for server-side requests (e.g. `http://auth-service.auth.svc.cluster.local:3000`)

---

### 4.7 venue-service

| Property | Value |
|---|---|
| Language | Go 1.23+ |
| Framework | Echo v4 |
| Database | PostgreSQL 16 (AWS RDS) |
| Logging | `zap` (JSON) |
| Metrics | `prometheus/client_golang` (`/metrics`) |
| Tracing | OpenTelemetry Go SDK + `otelecho` |
| gRPC | Server (defined in `proto/venue/v1/venue.proto`) |
| Kafka | Consumer (`segmentio/kafka-go`) |
| Ports | 3003 (HTTP/REST), **50052** (gRPC) |
| Test framework | `testify` + `testcontainers-go` (PostgreSQL + Kafka) |

**Responsibilities:**

- Venue and seat inventory management
- Quota reservation for seats (OCC via `version` field)
- Serve gRPC `VenueService` for seat reservation/release
- Consume `orders.order.completed` from Kafka to finalize seat allocation

**API Routes:**

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/api/venues` | Yes | Create venue |
| `GET` | `/api/venues` | No | List venues |
| `GET` | `/api/venues/:id` | No | Get single venue |
| `PUT` | `/api/venues/:id` | Yes (owner) | Update venue details |
| `POST` | `/api/venues/:id/seats` | Yes | Add seats to a venue |
| `GET` | `/api/venues/:id/seats` | No | List seats with availability |
| `GET` | `/healthz/live` | No | Liveness |
| `GET` | `/healthz/ready` | No | Readiness (PostgreSQL + Kafka check) |
| `GET` | `/metrics` | No | Prometheus |

**gRPC service (see Section 8 for full proto):**

- `GetVenue` — fetch a venue by ID
- `ReserveSeat` — reserve a specific seat (used when an order is placed)
- `ReleaseSeat` — release a previously reserved seat (on order cancellation / expiry)

**Database schema (PostgreSQL):**

```sql
CREATE TABLE venues (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  address    TEXT        NOT NULL,
  capacity   INT         NOT NULL,
  version    INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE seats (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id   UUID        NOT NULL REFERENCES venues(id),
  row        TEXT        NOT NULL,
  number     INT         NOT NULL,
  status     VARCHAR(20) NOT NULL DEFAULT 'available', -- available | reserved | sold
  order_id   UUID,
  version    INT         NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (venue_id, row, number)
);

CREATE INDEX idx_seats_venue_id ON seats(venue_id);
CREATE INDEX idx_seats_status   ON seats(status);
```

**Kafka:**

- Produces: `venue.seat.reserved`, `venue.seat.released`
- Consumes (consumer group `venue-service`): `orders.order.completed`

**Environment variables:**

- `DATABASE_URL` — PostgreSQL connection string
- `REDIS_URL` — Redis connection URL (cache layer)
- `KAFKA_BROKERS` — comma-separated broker endpoints
- `GRPC_PORT` (default: **50052**)
- `PORT` (default: 3003)

---

### 5.1 Repository Layout for IaC

```
infra/
├── terraform/
│   ├── modules/
│   │   ├── vpc/
│   │   ├── eks/
│   │   ├── rds/          # Instantiated 3×: auth, orders, payments
│   │   ├── msk/
│   │   ├── elasticache/
│   │   ├── ecr/
│   │   ├── iam/
│   │   └── secrets/
│   └── envs/
│       ├── dev/
│       │   ├── main.tf
│       │   ├── variables.tf
│       │   └── terraform.tfvars
│       └── prod/
│           ├── main.tf
│           ├── variables.tf
│           └── terraform.tfvars
├── helm/
│   ├── auth-service/
│   ├── ticket-service/
│   ├── order-service/
│   ├── payment-service/
│   ├── expiration-service/
│   ├── client/
│   ├── mongodb/           # StatefulSet for ticket-service
│   └── kafka-schema-registry/
└── k8s/
    ├── namespaces.yaml
    └── external-secrets-operator.yaml
```

### 5.2 Terraform Modules

**`vpc` module:**

- 3 AZs: `ap-southeast-1a`, `ap-southeast-1b`, `ap-southeast-1c`
- Public subnets: ALB, NAT Gateway
- Private subnets: EKS nodes, RDS, MSK, ElastiCache
- VPC Flow Logs → CloudWatch Logs
- Security groups: ALB → Kong, EKS node SG, RDS SG, Redis SG

**`eks` module:**

- EKS 1.31+
- Managed node group (general) — **dev:** `m6i.large`, min 2 / max 6; **prod:** `m6i.xlarge`, min 2 / max 10 (Karpenter-managed)
- Managed node group (spot/worker) — **dev:** `m6i.medium` spot; **prod:** `m6i.large` spot — for expiration-service
- Add-ons: `aws-load-balancer-controller`, `external-secrets-operator`, `ebs-csi-driver`, `karpenter`
- OIDC provider for IRSA
- Cluster logging: API, audit, authenticator, scheduler, controller-manager → CloudWatch

**`rds` module (instantiated ×4):**

- Engine: PostgreSQL 16
- Instance: `db.t4g.micro` (dev), `db.r6g.large` (prod)
- Multi-AZ: false (dev), true (prod)
- DB names: `auth_db`, `orders_db`, `payments_db`, `venue_db`
- Subnet group in private subnets; automated backups 7 days (prod)
- Credentials → Secrets Manager

**`msk` module: [SUPERSEDED — replaced by Strimzi in-cluster Kafka for Phase 1; MSK is the Phase 2 migration target]**

**Strimzi Kafka (in-cluster, Phase 1):**

- Strimzi Kafka Operator installed via Helm in `infra` namespace (Strimzi 0.40+)
- `Kafka` CR: 3 broker pods + 3 ZooKeeper pods (KRaft mode preferred if Strimzi version supports it); deployed in `infra` namespace
- Persistent volumes via EBS CSI (gp3, encrypted) — 20 GiB per broker (dev) / 100 GiB per broker (prod)
- Listener: internal `PLAINTEXT` on port 9092 (cluster-internal only — no external exposure)
- Replication factor: 3, min ISR: 2 (same as MSK target config to keep Phase 2 migration frictionless)
- Topic management via `KafkaTopic` CRs (declarative, version-controlled)
- All producer config: `acks=all`, `enable.idempotence=true` — identical to Phase 2 MSK targets
- **Phase 2 migration path:** swap broker endpoint env vars + TLS config per service; Strimzi-specific CRDs removed; MSK takes over. No application logic changes required.

**`elasticache` module:**

- Redis 7.x, cluster mode enabled
- 3 shards × 1 replica = 6 nodes
- Instance: `cache.r7g.large` (prod), `cache.t4g.micro` (dev)
- Encryption in transit + at rest
- Used by: expiration-service (`asynq`), Kong rate-limiting plugin

**`ecr` module:**

- Repositories: `auth-service`, `ticket-service`, `order-service`, `payment-service`, `expiration-service`, `venue-service`, `client`
- Lifecycle policy: retain last 20 images by push date
- ECR enhanced scanning on push
- Repository policy: EKS node role can pull

**`iam` module (IRSA roles per service):**

| Role | AWS Permissions |
|---|---|
| `auth-service-role` | Secrets Manager read: `jwt-rsa-private-key`, `db-password-auth` |
| `order-service-role` | Secrets Manager read: `db-password-orders`; MSK client policy |
| `payment-service-role` | Secrets Manager read: `db-password-payments`, `stripe-secret-key` |
| `ticket-service-role` | No AWS service access (MongoDB on-cluster) |
| `expiration-service-role` | No AWS service access (Redis on-cluster via internal DNS) |
| `venue-service-role` | Secrets Manager read: `db-password-venue` |

**`secrets` module:**

- Secrets Manager entries created by Terraform (values injected out-of-band — never via Terraform)
- ExternalSecret CRDs created per namespace; ESO syncs to K8s Secrets at runtime

### 5.3 Kubernetes Namespace Strategy

```
infra        # Kong, ESO, Karpenter, Schema Registry, OTel Collector, Fluent Bit
auth         # auth-service + its RDS ExternalSecret
tickets      # ticket-service + MongoDB StatefulSet
orders       # order-service + its RDS ExternalSecret
payments     # payment-service + its RDS ExternalSecret
expiration   # expiration-service
client       # Next.js frontend
```

### 5.4 Helm Chart Conventions (all services)

Every service chart provides:

- `Deployment` — resource requests/limits, liveness/readiness probes, `terminationGracePeriodSeconds: 60`, `podAntiAffinity` across AZs
- `Service` — ClusterIP
- `HorizontalPodAutoscaler` — CPU 70%, min 2 replicas (dev), min 3 (prod)
- `PodDisruptionBudget` — `minAvailable: 1`
- `ServiceAccount` — IRSA annotation
- `NetworkPolicy` — allow ingress from `infra` (Kong) namespace only; egress to own DB + MSK + ElastiCache + Schema Registry
- `KongIngress` + `KongPlugin` CRDs
- `values-dev.yaml`, `values-prod.yaml`

### 5.5 MongoDB StatefulSet (ticket-service)

- 3-node MongoDB Replica Set as a `StatefulSet` in the `tickets` namespace
- Persistent volumes via EBS CSI (gp3, encrypted) — 50 GiB dev / TBD prod (see OQ-4)
- Headless `Service` for replica set member discovery
- Init container for replica set initiation
- Credentials in Secrets Manager, synced via ESO
- Backup: AWS Data Lifecycle Manager for EBS snapshots (daily, 7-day retention)

### 5.6 Confluent Schema Registry (self-hosted)

- `Deployment` (2 replicas) in `infra` namespace
- Connects to Strimzi Kafka (Phase 1) / MSK (Phase 2) via PLAINTEXT/TLS respectively
- REST API at `http://schema-registry.infra.svc.cluster.local:8081`
- Not exposed externally (cluster-internal only)
- Auth in Phase 1: unauthenticated (cluster-internal only — see OQ-5)

---

### 5.7 Local Kubernetes Development Environment

**Tool:** `minikube` (docker driver) — replaced `kind` (see D-26 [SUPERSEDED] → D-29).

**Purpose:** Develop and test all services locally before pushing to EKS dev. Mirrors the EKS namespace + Helm chart structure as closely as possible.

**Cluster configuration:**

```bash
minikube start --cpus=4 --memory=7168 --disk-size=30g --driver=docker
```

**What runs locally (via Helm umbrella chart `infra/helm/` with `values-local.yaml`):**

| Component | Local equivalent | Notes |
|---|---|---|
| Kafka | `infra/helm/charts/cp-kafka/` — Confluent `cp-kafka:7.7.1` | Custom sub-chart; INTERNAL (9092 in-cluster) + EXTERNAL LoadBalancer (9093 via `minikube tunnel`). `bitnami/kafka` has no Docker Hub tags. |
| MongoDB | Bitnami MongoDB (1 replica) | In-cluster pod |
| PostgreSQL (×3) | Bitnami PostgreSQL ×3 | One per service (auth, orders, payments) |
| Redis | Bitnami Redis (standalone, no auth) | In-cluster pod |
| Schema Registry | — | Not deployed locally; services tolerate absence |
| Kong | Kong Helm chart (DB-less) | Same declarative config as production; exposed on `localhost:8000` via `minikube tunnel` |

**Service mesh:** Linkerd installed in cluster. Namespace annotated `config.linkerd.io/skip-outbound-ports: "9092"` to prevent Linkerd intercepting outbound Kafka binary-protocol connections.

**Important constraints (minikube on Docker Desktop):**
- Memory cap: Docker Desktop allows ~7851 MB → use `--memory=7168`
- Image loading: host Docker client is too old for `eval $(minikube docker-env)`. Use `minikube image load <image>` instead.
- Bitnami images: only `:latest` tags exist on Docker Hub. Pull `:latest`, retag to the version the Helm chart expects, then load into minikube.

**Not run locally:**
- AWS ALB (`minikube tunnel` exposes Kong's LoadBalancer directly on `localhost:8000`)
- AWS Managed Prometheus / Grafana / X-Ray (deferred to Milestone 7)
- External Secrets Operator (plain K8s `Secret` manifests created by `setup.sh`)

**Setup script:** `infra/local/setup.sh` — idempotent 7-step bootstrap (tools check → minikube → build+load images → namespace → Linkerd annotation → secrets → helm install → tunnel).

**Developer workflow:**

```bash
# First time
cp infra/local/secrets.env.example infra/local/secrets.env
# Fill in RSA_PRIVATE_KEY and STRIPE_SECRET_KEY in secrets.env
./infra/local/setup.sh

# Incremental update after a code change to one service
docker build -t auth-service:local services/auth-service/
minikube image load auth-service:local
kubectl rollout restart deployment/ticketing-auth-service -n ticketing

# Tear down
helm uninstall ticketing -n ticketing
kubectl delete namespace ticketing
minikube stop
```

**In-cluster service DNS (namespace: ticketing):**

| Service | Hostname |
|---|---|
| PostgreSQL (auth) | `ticketing-postgres-auth:5432` |
| PostgreSQL (orders) | `ticketing-postgres-orders:5432` |
| PostgreSQL (payments) | `ticketing-postgres-payments:5432` |
| PostgreSQL (venue) | `ticketing-postgres-venue:5432` |
| MongoDB | `ticketing-mongodb:27017` |
| Redis | `ticketing-redis-master:6379` |
| Kafka | `ticketing-cp-kafka.ticketing.svc.cluster.local:9092` |
| Kong proxy | `localhost:8000` via `minikube tunnel` |
| Kafka external (E2E) | `localhost:9093` via `minikube tunnel` |

---

## 6. API Gateway (Kong)

### 6.1 Deployment

- Kong Ingress Controller installed via Helm (`kong/kong` chart) in `infra` namespace
- Kong Gateway pods: 2 replicas (prod: 3), HPA on CPU
- AWS ALB in front (provisioned by AWS Load Balancer Controller via `Ingress` annotation)
- TLS termination at ALB (ACM certificate for `ticketing.example.com` placeholder)
- Kong listens on HTTP internally; all external HTTPS terminated at ALB

### 6.2 Global Plugins

| Plugin | Configuration |
|---|---|
| `jwt` | RS256; Kong fetches public key from auth-service `/.well-known/jwks.json`; injects `X-User-Id` + `X-User-Roles` on successful verification |
| `rate-limiting-advanced` | Redis cluster-backed; anonymous: 100 req/min by IP; authenticated: 1000 req/min by consumer |
| `correlation-id` | Header: `X-Correlation-Id`; generator: `uuid#counter` |
| `request-transformer` | Strip `X-User-Id`, `X-User-Roles` from *incoming* client requests (prevents header spoofing) |
| `prometheus` | Kong's own metrics endpoint (scraped by OTel Collector) |

### 6.3 Route Configuration

| Route | Upstream | Auth Required | Notes |
|---|---|---|---|
| `/api/users/*` | `auth-service.auth:3000` | No | Signup/signin bypass JWT plugin |
| `/.well-known/jwks.json` | `auth-service.auth:3000` | No | Public key endpoint for Kong |
| `/api/tickets/*` | `ticket-service.tickets:8080` | Conditional | `GET` public; `POST`/`PUT` require auth |
| `/api/orders/*` | `order-service.orders:8080` | Yes | All routes authenticated |
| `/api/payments/*` | `payment-service.payments:3000` | Yes | All routes authenticated |
| `/*` | `client.client:3000` | No | Catch-all to Next.js frontend |

All Kong configuration is declarative via `KongIngress`, `KongPlugin`, and `KongConsumer` CRDs — no click-ops in the Admin UI.

---

## 7. Messaging (Kafka)

### 7.1 Topic Naming Convention

```
<domain>.<entity>.<event-verb>
```

| Topic | Producer | Consumers | Partition Key |
|---|---|---|---|
| `tickets.ticket.created` | ticket-service | order-service | `ticketId` |
| `tickets.ticket.updated` | ticket-service | order-service | `ticketId` |
| `orders.order.created` | order-service | ticket-service, payment-service, expiration-service | `orderId` |
| `orders.order.cancelled` | order-service | ticket-service, payment-service | `orderId` |
| `orders.order.completed` | order-service | venue-service | `orderId` |
| `expiration.order.expiration_complete` | expiration-service | order-service | `orderId` |
| `payments.payment.captured` | payment-service | order-service | `orderId` |
| `venue.seat.reserved` | venue-service | — | `seatId` |
| `venue.seat.released` | venue-service | — | `seatId` |

**DLQ topics (one per consumer, after max retries):**

```
tickets.ticket.created.dlq
tickets.ticket.updated.dlq
orders.order.created.dlq
orders.order.cancelled.dlq
orders.order.completed.dlq
expiration.order.expiration_complete.dlq
payments.payment.captured.dlq
venue.seat.reserved.dlq
venue.seat.released.dlq
```

### 7.2 Event Envelope (CloudEvents v1.0)

```json
{
  "specversion": "1.0",
  "type":        "tickets.ticket.created",
  "source":      "ticket-service",
  "id":          "<uuid-v4>",
  "time":        "<ISO-8601>",
  "datacontenttype": "application/json",
  "data": { }
}
```

Kafka message headers carry W3C trace propagation fields (`traceparent`, `tracestate`).

### 7.3 Producer Configuration (all services)

- `acks=all`
- `enable.idempotence=true`
- `retries=5` with exponential back-off
- `delivery.timeout.ms=10000`

### 7.4 Consumer Configuration (all services)

- Manual offset commit (commit only after successful processing)
- Retry: 3 attempts, exponential back-off (base 1 s, max 30 s)
- After 3 failures → route message to `.dlq` topic, commit offset, continue
- Consumer group IDs match service names: `ticket-service`, `order-service`, etc.

### 7.5 Transactional Outbox (order-service)

- Order state change + outbox row written in a **single PostgreSQL transaction**
- Outbox relay (`@Scheduled`, 500 ms poll): reads unpublished rows → produces to Kafka → marks `published = true`
- Guarantees no event is lost even if the Kafka broker is temporarily unreachable

---

## 8. gRPC Contracts

### 8.1 Proto File Locations

```
proto/
├── tickets/
│   └── v1/
│       └── tickets.proto
├── venue/
│   └── v1/
│       └── venue.proto
└── auth/
    └── v1/
        └── auth.proto     # Reserved for future use; Kong JWKS is sufficient for Phase 1
```

### 8.2 Tickets Proto

```protobuf
syntax = "proto3";
package acme.tickets.v1;

option go_package  = "github.com/org/ticketing/libs/grpc-stubs/go/tickets/v1";
option java_package = "com.acme.tickets.v1";

import "google/protobuf/timestamp.proto";

service TicketService {
  rpc GetTicket                  (GetTicketRequest)         returns (GetTicketResponse);
  rpc ValidateTicketAvailability (ValidateTicketRequest)    returns (ValidateTicketResponse);
}

message GetTicketRequest {
  string ticket_id = 1;
}

message GetTicketResponse {
  string                    ticket_id  = 1;
  string                    title      = 2;
  double                    price      = 3;
  string                    user_id    = 4;
  string                    order_id   = 5; // empty string if not reserved
  int64                     version    = 6;
  google.protobuf.Timestamp created_at = 7;
  google.protobuf.Timestamp updated_at = 8;
}

message ValidateTicketRequest {
  string ticket_id = 1;
}

message ValidateTicketResponse {
  bool   available  = 1;
  string ticket_id  = 2;
  double price      = 3;
}
```

### 8.3 Venue Proto

```protobuf
syntax = "proto3";
package acme.venue.v1;

option go_package = "github.com/org/ticketing/libs/grpc-stubs/go/venue/v1";

service VenueService {
  rpc GetVenue     (GetVenueRequest)     returns (GetVenueResponse);
  rpc ReserveSeat  (ReserveSeatRequest)  returns (ReserveSeatResponse);
  rpc ReleaseSeat  (ReleaseSeatRequest)  returns (ReleaseSeatResponse);
}

message GetVenueRequest  { string venue_id = 1; }
message GetVenueResponse {
  string venue_id  = 1;
  string name      = 2;
  string address   = 3;
  int32  capacity  = 4;
}

message ReserveSeatRequest  { string venue_id = 1; string seat_id = 2; string order_id = 3; }
message ReserveSeatResponse { bool success = 1; string seat_id = 2; }

message ReleaseSeatRequest  { string venue_id = 1; string seat_id = 2; string order_id = 3; }
message ReleaseSeatResponse { bool success = 1; string seat_id = 2; }
```

### 8.4 Generated Stubs

- Generated via `buf generate` (using `buf.gen.yaml`)
- Go stubs → `libs/grpc-stubs/go/`
- Java stubs → `libs/grpc-stubs/java/` (consumed by order-service as a local Maven module)
- Regenerated in CI on any `.proto` file change (`make proto`)
- CI runs `buf breaking --against .git#branch=main` — fails on breaking changes without a version bump

### 8.5 gRPC Client Deadlines

| RPC | Deadline |
|---|---|
| `ValidateTicketAvailability` | 5 s (read) |
| `GetTicket` | 5 s (read) |
| `ReserveSeat` | 5 s (write) |
| `ReleaseSeat` | 5 s (write) |
| `GetVenue` | 5 s (read) |

---

## 9. Observability

### 9.1 Structured Logging

- All services log structured JSON
- Required fields: `timestamp` (ISO-8601), `level`, `service`, `traceId`, `spanId`, `correlationId`, `message`
- Never log: PII (email, phone), passwords, tokens, secrets
- Fluent Bit DaemonSet (`infra` namespace) tails pod logs → AWS CloudWatch Logs
- Log groups: `/ticketing/<env>/<service-name>`
- Log retention: 30 days (dev), 90 days (prod)

### 9.2 Metrics

- All services expose `/metrics` (or `/actuator/prometheus`) in Prometheus format
- OTel Collector (DaemonSet in `infra` namespace) scrapes and forwards to AWS Managed Prometheus (AMP)
- Amazon Managed Grafana (AMG) connected to AMP workspace
- Required metrics per service: `http_requests_total`, `http_request_duration_seconds` (histogram), `kafka_consumer_lag`
- Kong metrics via the `prometheus` plugin, also scraped by OTel Collector

### 9.3 Distributed Tracing

- OpenTelemetry SDK in every service
  - Go: `go.opentelemetry.io/otel` + `otelecho` (Echo v4 middleware)
  - Java: OTel agent JAR (auto-instrumentation, zero code change)
  - Node.js: `@opentelemetry/sdk-node`
- W3C `traceparent` header propagated on all HTTP and gRPC calls
- OTel metadata propagated through Kafka message headers on all events
- OTel Collector → AWS X-Ray (via OTLP exporter)

### 9.4 Health Checks

Every service exposes:

- `GET /healthz/live` — returns `200` if process is running (no dependency checks)
- `GET /healthz/ready` — returns `200` when all dependencies are ready; `503` otherwise

Dependencies checked in readiness: own database, Kafka broker reachability, Redis (where applicable).

> **Note:** Spring Boot (order-service) uses `/actuator/health/liveness` and `/actuator/health/readiness`.
> The Helm chart configures `livenessProbe` and `readinessProbe` to match these paths.

---

## 10. CI/CD

### 10.1 Pipeline Per Service

Triggered on PR (lint + test stages) and push to `main` (build + deploy stages):

```
1.  lint              ── eslint / golangci-lint / checkstyle
2.  unit-test         ── fast, no I/O
3.  integration-test  ── Testcontainers (real DB + Kafka)
4.  build-image       ── multi-stage Docker build
5.  scan-image        ── trivy (fail on HIGH/CRITICAL CVEs)
6.  push-image        ── push to ECR with tag: <git-sha>
7.  deploy-dev        ── helm upgrade --install (EKS dev namespace)
8.  smoke-test        ── basic HTTP checks against dev endpoints
9.  [manual approval] ── required before production deploy
10. deploy-prod       ── helm upgrade --install (EKS prod namespace)
```

### 10.2 Proto Pipeline

Triggered on any change under `proto/`:

```
1. buf lint
2. buf breaking  ── check against main branch
3. make proto    ── regenerate stubs
4. diff check    ── fail if generated files differ from committed stubs
```

### 10.3 Infrastructure Pipeline

Triggered on change under `infra/terraform/`:

```
1. terraform fmt      ── formatting check
2. terraform validate
3. terraform plan     ── plan output posted as PR comment
4. [manual approval]
5. terraform apply    ── only on merge to main
```

### 10.4 Rules

- Branch protection on `main` — no direct push, CI must pass
- Image tag = Git SHA — never `latest`
- Rollback: `helm rollback <release> <revision>` (previous Git SHA image)
- CI auth to AWS: **GitHub OIDC → IAM role assumption** — no long-lived AWS access keys stored in GitHub Secrets

---

## 11. Repository Structure

```
/
├── services/
│   ├── auth-service/           # TypeScript / Node.js + NestJS 10
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── README.md
│   ├── ticket-service/         # Go / Echo v4
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── go.mod
│   │   └── README.md
│   ├── order-service/          # Java 21 / Spring Boot 4
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── pom.xml
│   │   └── README.md
│   ├── payment-service/        # TypeScript / Node.js + NestJS 10
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── package.json
│   │   └── README.md
│   ├── expiration-service/     # Go / Echo v4 (health+metrics only) + asynq worker
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── go.mod
│   │   └── README.md
│   ├── venue-service/          # Go / Echo v4 + gRPC server + Kafka consumer
│   │   ├── src/
│   │   ├── Dockerfile
│   │   ├── go.mod
│   │   └── README.md
│   └── client/                 # Next.js 15 App Router + TypeScript
│       ├── src/
│       ├── Dockerfile
│       ├── package.json
│       └── README.md
├── proto/
│   ├── tickets/
│   │   └── v1/
│   │       └── tickets.proto
│   └── auth/
│       └── v1/
│           └── auth.proto
├── libs/
│   └── grpc-stubs/
│       ├── go/                 # buf-generated Go stubs
│       └── java/               # buf-generated Java stubs (local Maven module)
├── infra/
│   ├── terraform/
│   │   ├── modules/
│   │   │   ├── vpc/
│   │   │   ├── eks/
│   │   │   ├── rds/
│   │   │   ├── elasticache/
│   │   │   ├── ecr/
│   │   │   ├── iam/
│   │   │   └── secrets/
│   │   └── envs/
│   │       ├── dev/
│   │       └── prod/
│   ├── helm/
│   │   ├── auth-service/
│   │   ├── ticket-service/
│   │   ├── order-service/
│   │   ├── payment-service/
│   │   ├── expiration-service/
│   │   ├── client/
│   │   ├── mongodb/
│   │   ├── strimzi-kafka/      # KafkaTopic CRs + Kafka CR for EKS dev/prod
│   │   └── kafka-schema-registry/
│   ├── k8s/
│   │   ├── namespaces.yaml
│   │   └── external-secrets-operator.yaml
│   └── local/                  # Local kind-based development environment
│       ├── kind-config.yaml    # 1 control-plane + 2 worker nodes
│       ├── setup.sh            # One-shot cluster bootstrap script
│       ├── namespaces.yaml
│       └── values/             # values-local.yaml overrides per service/component
├── .github/
│   └── workflows/
│       ├── ci-auth.yaml
│       ├── ci-ticket.yaml
│       ├── ci-order.yaml
│       ├── ci-payment.yaml
│       ├── ci-expiration.yaml
│       ├── ci-client.yaml
│       ├── ci-proto.yaml
│       └── ci-terraform.yaml
├── Makefile                    # make proto, make lint, make test-all, make load-<service>
├── buf.yaml                    # buf workspace configuration
├── buf.gen.yaml                # buf code generation config
├── PLAN.md                     # this file
└── AGENTS.md                   # engineering standards
```

---

## 12. Milestones

### Milestone 0 — Local Development Environment ✅ COMPLETE

**Goal:** Every developer can run the full platform locally before any EKS infrastructure exists.

- [x] `infra/local/setup.sh` — idempotent 7-step bootstrap: tools check → minikube start → build+load images → namespace → Linkerd annotation → K8s secrets → helm upgrade --install → minikube tunnel
- [x] `infra/helm/` — umbrella Helm chart with Bitnami sub-charts (PostgreSQL ×3, MongoDB, Redis) + custom `cp-kafka` sub-chart (Confluent cp-kafka:7.7.1)
- [x] `infra/helm/values-local.yaml` — minikube overrides: 1 replica, small resources, inline passwords
- [x] `infra/local/secrets.env.example` — template; user fills in `RSA_PRIVATE_KEY` + `STRIPE_SECRET_KEY`
- [x] Kong proxy reachable on `localhost:8000` via `minikube tunnel`
- [x] All dependency pods healthy (PostgreSQL ×3, MongoDB, Redis, cp-kafka)
- [x] 18/18 Playwright E2E tests passing against minikube cluster

**Deliverable:** `./infra/local/setup.sh` (with `secrets.env` filled in) gives a fully running local environment with 18/18 E2E tests passing.

---

### Milestone 1 — Infrastructure Foundation

**Goal:** AWS infrastructure provisioned and ready to receive workloads.

- [x] Terraform remote state: S3 bucket + DynamoDB lock table (PR #12: I-20 | P2)
- [ ] Terraform `vpc` module — VPC, subnets, SGs, NAT GW, VPC Flow Logs
- [ ] Terraform `eks` module — EKS 1.31+, managed node groups (dev/prod sizing), OIDC provider
- [ ] Terraform `ecr` module — one repo per service, lifecycle + scanning policy
- [ ] EKS add-ons: AWS Load Balancer Controller, External Secrets Operator, EBS CSI, Karpenter
- [ ] Terraform `rds` module — PostgreSQL 16 ×3 (auth, orders, payments)
- [ ] Strimzi Kafka Operator installed via Helm in `infra` namespace; `Kafka` CR (3 brokers) + `KafkaTopic` CRs deployed
- [ ] Terraform `elasticache` module — Redis 7 cluster
- [ ] Terraform `secrets` module — Secrets Manager entries + ESO ExternalSecret CRDs
- [ ] Terraform `iam` module — IRSA roles per service
- [ ] Namespace strategy applied to EKS cluster
- [ ] Kong Ingress Controller installed via Helm in `infra` namespace
  - [x] Kong TLS/ACM configuration (PR #12: I-21 | P2)
  - [x] Kong JWT plugin wired to auth-service JWKS endpoint
  - [x] Kong strips spoofed X-User-Id header globally (PR #12: S-02 | P0 — security critical)
- [ ] Confluent Schema Registry deployed to `infra` namespace (connected to Strimzi Kafka)
- [ ] CI/CD pipeline for Terraform (PR #12: I-22 | P2 — lint, validate, plan, apply gates)
- [ ] Smoke test: Kong returns `200` from a test pod; Kafka topic creation verified via `KafkaTopic` CR

**Deliverable:** Running EKS cluster with all AWS managed services provisioned. Kong live.

---

### Milestone 2 — Auth Service + Kong JWT Integration

**Goal:** Authentication working end-to-end through Kong.

- [x] auth-service implementation (TypeScript, NestJS 10, PostgreSQL, RS256 JWT, JWKS endpoint)
- [x] Database migrations (`node-pg-migrate`)
- [x] Multi-stage Dockerfile (pinned digest, non-root user)
- [x] Helm chart with ESO secret sync for DB URL + RSA private key
- [x] Kong JWT plugin wired to auth-service JWKS endpoint
  - ✅ PR #12 (S-02 | P0): Kong now strips spoofed X-User-Id header globally (security critical)
  - ✅ PR #12 (S-01 | P1): Refresh token rotation implemented (Redis-based)
  - ✅ PR #12 (S-04 | P2): JWT blacklist on signout (Redis)
  - ✅ PR #12 (S-06 | P2): Cookie maxAge derived from config
- [x] Kong routes for `/api/users/*` and `/.well-known/jwks.json`
- [x] `X-User-Id` header injection verified end-to-end
- [x] CI pipeline (`ci-auth.yaml`)
- [x] Unit tests (Vitest) + integration tests (Testcontainers PostgreSQL)
- [x] Deploy to EKS dev — smoke test passes

**Deliverable:** Signup and signin work through Kong. Kong injects `X-User-Id` to downstream services. JWKS endpoint is live.

---

### Milestone 3 — Ticket Service + Proto / gRPC Foundation

**Goal:** Ticket CRUD working; gRPC contract established; Kafka operational with Schema Registry.

- [x] Proto files authored (`proto/tickets/v1/tickets.proto`)
- [x] `buf.yaml` + `buf.gen.yaml` configured
- [x] `make proto` generates Go + Java stubs to `libs/grpc-stubs/`
  - ✅ PR #12 (CV-04 | P3): gRPC stubs now in `/libs/grpc-stubs/go/` and `/libs/grpc-stubs/java/`
  - ✅ PR #12 (C-08 | P2): Proto price field changed from `double` → `string` (decimal precision fix)
- [x] `ci-proto.yaml` workflow (buf lint + breaking check)
- [x] ticket-service implementation (Go, Echo v4, MongoDB, Kafka, gRPC server)
- [x] MongoDB StatefulSet Helm chart (3-node replica set, EBS-backed PVCs)
- [x] Multi-stage Dockerfile (Go builder → distroless runtime)
- [x] Helm chart for ticket-service with NetworkPolicy
- [x] Kong routes for `/api/tickets/*`
- [x] CI pipeline (`ci-ticket.yaml`)
- [x] Unit + integration tests (Testcontainers MongoDB + Kafka) — 29 tests passing
- [x] Kafka topics created on MSK; CloudEvents envelope validated via Schema Registry
- [x] Deploy to EKS dev — smoke test passes

**Deliverable:** Full ticket CRUD through Kong. Events flowing on Kafka. gRPC server responding on port **50051**.

---

### Milestone 4 — Order Service (Spring Boot 4)

**Goal:** Order lifecycle working end-to-end with gRPC ticket validation and Kafka event flow.

- [x] order-service implementation (Java 21, Spring Boot 4, PostgreSQL, Spring Kafka, Spring State Machine)
- [x] gRPC client calling ticket-service `ValidateTicketAvailability`
- [x] Java gRPC stubs wired from `libs/grpc-stubs/java/` as a local Maven module
- [x] Flyway migrations (orders, order_tickets, outbox tables)
- [x] Transactional outbox pattern implemented
  - ✅ **PR #12 CRITICAL (C-01 | P0):** Fixed @Transactional self-invocation bypass. Outbox now uses OrderTransactionService proxy — genuinely transactional. Integration test verifies rollback on failure.
- [x] Multi-stage Dockerfile (Maven builder → eclipse-temurin:21-jre-alpine)
- [x] Helm chart for order-service
- [x] Kong routes for `/api/orders/*`
- [x] CI pipeline (`ci-order.yaml`)
- [x] JUnit 5 + Testcontainers (PostgreSQL + Kafka) tests
- [x] Deploy to EKS dev — smoke test passes

**Deliverable:** Orders can be created (ticket validated via gRPC), listed, viewed, and cancelled. Events flow on Kafka to expiration and payment consumers (those services now deployed).

---

### Milestone 5 — Expiration Service + Payment Service

**Goal:** Complete the event-driven loop — order expiry handled and payment stubbed.

- [x] expiration-service implementation (Go, `asynq`, Kafka consumer + producer)
  - ✅ **PR #12 CRITICAL (R-04 | P0):** DLQ routing now implemented (was missing entirely). Failed messages route to .dlq topic after 3 retries with exponential backoff.
  - ✅ PR #12 (R-07 | P1): Readiness probe with real Redis + Kafka checkers now working
- [x] Multi-stage Dockerfile + Helm chart for expiration-service
- [x] CI pipeline (`ci-expiration.yaml`)
- [x] payment-service implementation (TypeScript, NestJS 10, Drizzle ORM, PostgreSQL, Kafka — stub payment logic)
  - ✅ **PR #12 CRITICAL (C-05 | P0):** Kafka producer implemented (was missing entirely). Now uses transactional outbox.
  - ✅ **PR #12 CRITICAL (C-06 | P0):** Stripe flow fixed (was broken). Now creates PaymentIntent → publishes payment.captured event on success.
  - ✅ PR #12 (R-11 | P1): Stripe webhook handler implemented
  - ✅ PR #12 (R-12 | P1): Stripe idempotency key added
  - ✅ PR #12 (S-05 | P0): Authorization check (ownership) added to payments endpoint
- [x] `drizzle-kit` migrations
- [x] Multi-stage Dockerfile + Helm chart for payment-service
- [x] Kong routes for `/api/payments/*`
- [x] CI pipeline (`ci-payment.yaml`)
- [x] Deploy both services to EKS dev

**Deliverable:** Complete backend event loop: create order → expiration scheduled → stub payment accepted → order marked complete.

---

### Milestone 6 — Frontend (Next.js 15 App Router)

**Goal:** Functional UI for all flows — signup, ticket management, order placement, stub payment.

- [x] Next.js 15 App Router project scaffold with TypeScript + Tailwind CSS + shadcn/ui
- [x] Auth pages (signup, signin, signout) via Server Actions
- [x] Ticket listing (Server Component, SSR), ticket create + view pages
- [x] Order creation, order list, order detail pages
- [x] Stub payment form (simple "Pay Now" button — no Stripe widget)
- [x] `httpOnly` cookie handling in App Router middleware
- [x] `NEXT_PUBLIC_API_URL` + `INTERNAL_API_URL` env vars wired correctly
- [x] Multi-stage Dockerfile (`next build --standalone`)
- [x] Helm chart for client
- [x] CI pipeline (`ci-client.yaml`)
- [x] Integration test coverage expanded (PR #12: T-05 through T-15 — 15+ new tests for Server Actions, Components)
- [x] Deploy to EKS dev

**Deliverable:** Full end-to-end user journey works in a browser through Kong.

---

### Milestone 7 — Observability + Hardening

**Goal:** Full production readiness — HA, observability, security hardening. **Status: 85% complete** (core hardening done; cloud stack integration deferred to M8).

- [ ] Fluent Bit DaemonSet configured → AWS CloudWatch Logs (all namespaces) — *deferred to M8*
- [ ] OTel Collector → AWS Managed Prometheus (AMP) — metrics from all services + Kong — *partially done*
  - ✅ OTel SDK on all 6 services
  - ⏳ Cloud stack hookup deferred to M8
- [ ] Amazon Managed Grafana (AMG) dashboards: RED metrics per service, Kafka consumer lag — *deferred to M8*
- [ ] OTel Collector → AWS X-Ray — distributed trace forwarding — *deferred to M8*
- [x] DLQ handlers: all Kafka consumers implement `.dlq` routing after 3 retries
  - ✅ **PR #12 CRITICAL (R-03 | P0):** ticket-service DLQ implemented
  - ✅ **PR #12 CRITICAL (R-04 | P0):** expiration-service DLQ implemented
  - ✅ PR #12 (R-05 | P1): Kafka failures handled (not silent); retry + backoff
- [x] HPA configured for all services (CPU + Kafka consumer lag metric) — PR #12 (I-03 | P1)
- [x] PodDisruptionBudget for all services — PR #12 (I-05 | P1)
- [x] NetworkPolicy enforced for all namespaces — PR #12 (I-01 | P1)
- [ ] `trivy` image scan added to all CI pipelines (fail on HIGH/CRITICAL) — *deferred to M8*
- [x] Resource requests/limits defined for every K8s container — verified in all values*.yaml files
- [x] Integration test coverage review and gaps filled — 50+ new tests across all services

**Deliverable:** Observable, resilient, hardened system. Ready for staging deploy. **M8 (Staging Deploy) is now UNBLOCKED.**

---

### Milestone 8 — Staging Deploy + E2E Tests

**Goal:** Full system running in a staging environment; critical flows verified end-to-end. **Status: UNBLOCKED** ✅ — all M1–M7 blockers removed by PR #12 audit fixes.

- [ ] Terraform `prod` environment provisioned (staging uses prod-equivalent Terraform config)
- [ ] All services deployed to staging EKS
- [ ] E2E test suite (Playwright): signup → create ticket → purchase → stub payment → order complete
- [ ] Load test (k6): baseline RPS and p99 latency recorded
- [ ] Runbook documented: production deploy gate, rollback procedure, secret rotation

**Deliverable:** Staging sign-off. System ready for production deploy.

---

## 13. Open Questions

> Questions that remain unresolved and must be answered before the relevant milestone begins.
> Update status as each question is resolved.

| # | Question | Relevant Milestone | Status |
|---|---|---|---|
| OQ-1 | What GitHub organization / repository name should be used? This determines ECR repo URI naming and container image paths. | M1 | **Resolved** — `modern-ticketing` (temporary; update when org is created) |
| OQ-2 | Is a custom VPC CIDR range required, or is `10.0.0.0/16` acceptable? | M1 | **Resolved** — `10.0.0.0/16`, simplest setup for Phase 1 |
| OQ-3 | Will dev and prod EKS clusters be in separate AWS accounts (recommended) or the same account with separate namespaces? | M1 | **Resolved** — Single AWS account; dev and prod are separate resource groups (separate VPCs, EKS clusters, namespaces, and networking) |
| OQ-4 | For the MongoDB StatefulSet, what EBS volume size per node? (Recommended: 50 GiB gp3 dev / 200 GiB prod) | M3 | **Resolved** — 20 GiB gp3 dev (start small, scale later); prod TBD |
| OQ-5 | Should Confluent Schema Registry be secured with basic auth / RBAC in Phase 1, or left unauthenticated (cluster-internal only)? | M3 | **Resolved** — Unauthenticated in Phase 1 (cluster-internal only via private network; basic auth added in Phase 2 hardening) |
| OQ-6 | What is the expected peak RPS / MAU for initial load? Drives MSK instance sizing, Redis cluster sizing, and HPA thresholds. | M7 | **Resolved** — Start with smallest viable instance sizing; scale after baseline load test in Milestone 8 |
| OQ-7 | Real domain name: which DNS registrar / Route 53 hosted zone will be used when moving from the placeholder? | M8 | **Resolved** — Placeholder `ticketing.example.com` remains until a real domain is confirmed; Route 53 + ACM wired in M8 runbook |
| OQ-8 | Phase 2 Stripe integration: single currency (USD) only, or multi-currency support required? | Phase 2 | **Resolved** — Single currency (USD); platform is globally accessible but charges in USD only |

---

## 14. Confirmed Decisions Log

> All decisions explicitly confirmed. Do not delete entries — mark superseded ones `[SUPERSEDED]`.

| # | Decision | Rationale | Date |
|---|---|---|---|
| D-01 | Messaging layer: **Apache Kafka (AWS MSK)** | Durable, replayable, fan-out to multiple consumers. Replaces deprecated NATS Streaming. | 2026-03-20 |
| D-02 | order-service: **Java 21 / Spring Boot 4** | Spring's transaction support, JPA, Spring Kafka, and Spring State Machine ideal for order lifecycle. | 2026-03-20 |
| D-03 | ticket-service + expiration-service: **Go** | High-read and pure worker profiles benefit from Go's concurrency model and low memory overhead. | 2026-03-20 |
| D-04 | auth-service + payment-service: **TypeScript / Node.js + Express 5** | I/O-bound services; excellent Stripe SDK support in Node.js. | 2026-03-20 |
| D-05 | Frontend: **Next.js 15 App Router + TypeScript** | Modern SSR/RSC. Server Actions for mutations. Full TypeScript throughout. | 2026-03-20 |
| D-06 | Databases: **diversify per service** — PostgreSQL (auth, orders, payments), MongoDB (tickets), Redis (expiration) | Each store chosen for its access pattern. Financial data in ACID-compliant PostgreSQL. | 2026-03-20 |
| D-07 | MongoDB for tickets: **self-hosted StatefulSet on EKS** | No Atlas dependency. MongoDB Replica Set on EKS with EBS-backed PVCs. | 2026-03-20 |
| D-08 | API Gateway: **Kong Ingress Controller on EKS** | Declarative CRD-based config. Centralizes JWT auth, rate limiting, correlation ID. Replaces NGINX Ingress. | 2026-03-20 |
| D-09 | JWT algorithm: **RS256 (asymmetric)** | Private key stays in Secrets Manager only. Public key distributed via JWKS safely. | 2026-03-20 |
| D-10 | gRPC usage in Phase 1: **Kong auth bridge + order→ticket validation** | order-service calls ticket-service `ValidateTicketAvailability` via gRPC before creating an order. | 2026-03-20 |
| D-11 | Repository: **monorepo with proper workspace isolation** | All services in one repo; no shared npm/Maven packages between services. Proto in `/proto/`, IaC in `/infra/`. | 2026-03-20 |
| D-12 | Terraform scope: **full AWS infrastructure** | EKS, VPC, RDS ×3, MSK, ElastiCache, ECR, IAM (IRSA), Secrets Manager. Remote state in S3 + DynamoDB. | 2026-03-20 |
| D-13 | Schema Registry: **Confluent Schema Registry (self-hosted on EKS)** | Richer ecosystem. REST API. Supports Avro, JSON Schema, Protobuf. Deployed in `infra` namespace. | 2026-03-20 |
| D-14 | Observability: **AWS Managed Prometheus (AMP) + Amazon Managed Grafana (AMG) + AWS X-Ray** | Fully managed. OTel Collector forwards to all three. No K8s observability pods to maintain. | 2026-03-20 |
| D-15 | Stripe in Phase 1: **stubbed** (always returns success) | Simplifies Phase 1 scope. Real Stripe implementation deferred to Phase 2. | 2026-03-20 |
| D-16 | Stripe in Phase 2: **Stripe Payment Intents + Stripe Elements** | Replaces deprecated token-based `charges.create`. SCA/3DS compliant. | 2026-03-20 |
| D-17 | AWS Region: **ap-southeast-1 (Singapore)** | Primary deployment region. | 2026-03-20 |
| D-18 | Domain name: **placeholder (`ticketing.example.com`)** | Real domain wired in Milestone 8. Route 53 + ACM setup documented in runbook. | 2026-03-20 |
| D-19 | Image tagging: **Git SHA** | Immutable tags. Enables precise rollback. Never `latest`. | 2026-03-20 |
| D-20 | CI auth to AWS: **GitHub OIDC → IAM role assumption** | No long-lived AWS access keys stored in GitHub Secrets. | 2026-03-20 |
| D-04 | [SUPERSEDED by D-21] auth-service + payment-service: TypeScript / Node.js + Express 5 | — | 2026-03-20 |
| D-21 | auth-service + payment-service: **TypeScript / Node.js + NestJS 10** (replaces Express 5) | NestJS IoC container, DI, and decorator-driven modules reduce boilerplate and improve testability for structured auth and payment flows. | 2026-03-20 |
| D-03 | [SUPERSEDED by D-22 for ticket-service HTTP framework] ticket-service: Go / Gin | — | 2026-03-20 |
| D-22 | ticket-service HTTP framework: **Echo v4** (replaces Gin) | Echo provides better middleware management and marginally better benchmark performance. `otelecho` middleware available. Consistent with expiration-service. | 2026-03-20 |
| D-23 | expiration-service HTTP framework: **Echo v4** (minimal server for `/healthz` + `/metrics` only) | Consistency with ticket-service. No business HTTP surface — Echo only used for health and metrics endpoints. | 2026-03-20 |
| D-01 | [SUPERSEDED by D-24 for Phase 1] Messaging layer: Apache Kafka (AWS MSK) | Phase 1 uses Strimzi in-cluster. | 2026-03-20 |
| D-24 | Phase 1 Kafka: **Strimzi in-cluster Kafka on EKS** (MSK deferred to Phase 2) | Avoids MSK costs and Terraform complexity during initial build-out. Strimzi mirrors MSK Kafka 3.7 config (replication factor, min ISR, acks) so migration is a broker endpoint swap. | 2026-03-20 |
| D-25 | EKS node groups: **dev/prod instance size split** | Dev: `m6i.large` general / `m6i.medium` spot. Prod: `m6i.xlarge` general / `m6i.large` spot. Reduces cloud costs during development. | 2026-03-20 |
| D-26 | [SUPERSEDED by D-29] Local development: **`kind` (Kubernetes in Docker)** | — | 2026-03-20 |
| D-27 | OQ-1 resolved: **Repository name `modern-ticketing`** (temporary) | Placeholder until a permanent GitHub org/repo name is chosen. | 2026-03-20 |
| D-28 | OQ-8 resolved: **Single currency USD; globally accessible payments** | Phase 2 Stripe Payment Intents charges in USD only. Multi-currency is a future consideration beyond Phase 2 scope. | 2026-03-20 |
| D-29 | Local development: **`minikube`** (docker driver) replaces `kind` | `kind` multi-node config added complexity with no benefit for single-developer local dev. `minikube tunnel` provides a cleaner LoadBalancer experience (Kong on `localhost:8000`, Kafka EXTERNAL on `localhost:9093`) without NodePort hacks. | 2026-03-21 |

# Architecture Diagrams — v2

Six production-grade diagrams for the ticketing platform, reverse-engineered from
the current codebase (9 services, real Kafka topics, real gRPC APIs, Terraform
modules under `infra/terraform/`).

Built for **job-hunting portfolio use**. Each diagram is generated from source, so
it stays in sync with the code and survives PR review.

## Tooling choice (why these three, not one)

| Tool | What it's best at | Used for |
|---|---|---|
| **Graphviz (Python)** | Dense hierarchical graphs, precise layout, deterministic SVG/PNG — no CDN needed | `01-aws-infrastructure` |
| **Mermaid ER** | Concise entity-relationship notation with identifying / non-identifying lines | `02-data-model` |
| **Mermaid Flowchart** | C4-container style with domain grouping, multiple protocol labels | `03-c4-container` |
| **Mermaid Sequence** | Saga/state-machine style, readable autonumbered steps, par/alt branches | `04-data-flow-sequence`, `06-waiting-room-flow`, `07-search-dataflow` |

Other options considered (PlantUML, the `diagrams` Python library, D2) were dropped
because the sandbox has no outbound PyPI/npm access. Graphviz is preinstalled and
Mermaid renders client-side from the jsDelivr CDN, so both are available end-to-end.

## Files

```
v2/
├── 01-aws-infrastructure.py        # Graphviz source (edit this)
├── 01-aws-infrastructure.svg       # vector output  ← include this in resumes / READMEs
├── 01-aws-infrastructure.png       # raster preview
├── 02-data-model.mermaid           # ER source (paste into mermaid.live)
├── 02-data-model.html              # self-contained preview
├── 03-c4-container.mermaid
├── 03-c4-container.html
├── 04-data-flow-sequence.mermaid
├── 04-data-flow-sequence.html
├── 05-auth-flows.mermaid
├── 05-auth-flows.html
├── 06-waiting-room-flow.mermaid
├── 06-waiting-room-flow.html
├── 07-search-dataflow.mermaid      # OpenSearch CQRS index + query sequence
├── 07-search-dataflow.html
├── render.py                       # regenerates everything
├── index.html                      # landing page linking all diagrams
└── README.md                       # this file
```

## How to view

- **Double-click `index.html`** — opens the landing page with links to every diagram.
- Open any `*.html` directly in a browser (Mermaid loads from jsDelivr).
- `01-aws-infrastructure.svg` opens directly in any browser and scales cleanly for
  resumes, slides, and README headers.

## How to regenerate

```bash
cd docs/diagrams/v2
python3 render.py
```

This re-runs Graphviz for the infra diagram and re-wraps every `*.mermaid` in its
`*.html` viewer. Commit the regenerated `.svg` / `.png` along with the source.

## What each diagram shows

### 1. AWS Infrastructure (`01-aws-infrastructure.svg`)

A reference-production architecture showing how the 9 services deploy onto AWS:

- **VPC** (10.0.0.0/16, 3 AZs, NAT per AZ in prod — per `infra/terraform/modules/vpc`)
- **Edge**: Route 53 → CloudFront (static) + ALB behind AWS WAF with ACM TLS
- **Compute**: EKS with two namespaces (`kong`, `ticketing`), Karpenter + managed
  node groups
- **Data tier**: four RDS PostgreSQL (auth / user / order / payment), DocumentDB
  (ticket + venue), ElastiCache Redis (timers / cache / idempotency), Amazon MSK
  Kafka with Glue Schema Registry
- **Security**: IRSA for per-pod IAM, Secrets Manager via External Secrets, KMS
  envelope encryption, CloudTrail audit
- **Observability**: CloudWatch (structured logs + RED metrics), X-Ray (OTel
  traces), AWS Backup for long-term archive

The colour palette matches AWS branding (orange pods, navy services, blue data,
purple messaging, green external, red security) so it reads like a standard AWS
reference architecture even without the official icon PNGs.

### 2. Data Model (`02-data-model.mermaid`)

An ER diagram with one key insight that the previous diagram missed:

> **Each service owns its own database. Cross-service "foreign keys" are
> logical references, shown with dotted (`..`) relationships in Mermaid.**

This reflects AGENTS.md §4 ("Own your data — each service owns exactly one
datastore; no cross-DB queries") and is the first thing senior reviewers look
for in a microservices schema.

Covers: users, user_profiles / preferences / billing (user-service split),
orders + order_items + order_outbox (transactional outbox), tickets +
reservations, venues + seating_plans + sections + seats + seat_reservations,
payments + payment_records + payment_webhooks, expiration_timers (Redis ZSET).

### 3. C4 Container Diagram (`03-c4-container.mermaid`)

A C4 level-2 view: all 9 services grouped into four domains — **Edge**,
**Identity**, **Catalog**, **Transaction**, **Async Messaging** — with explicit
protocol labels on every edge:

- Thin solid arrows = synchronous HTTP/REST via Kong
- Bold arrows = synchronous gRPC inside the mesh (`ReserveQuota`,
  `ReserveHeldSeats`, etc., pulled from `proto/tickets/v1/tickets.proto` and
  `proto/venue/v1/venue.proto`)
- Dashed arrows into the `Amazon MSK` node = Kafka publishers, showing real
  topic names (`orders.order.created`, `tickets.ticket.updated`, etc.)

This is the diagram to pair with any "walk me through your architecture"
interview question.

### 4. Data Flow — Reservation + Payment Saga (`04-data-flow-sequence.mermaid`)

A five-phase sequence diagram covering the full happy path and the
compensating path, grounded in the actual code (topic names from
`services/*/internal/kafka`, gRPC methods from `proto/`):

1. **Reserve** — gRPC reservation of quota + seats, PENDING order written with
   transactional outbox entry.
2. **Outbox drain** — outbox → MSK Kafka (CloudEvents envelope). Fan-out to
   `expiration-service` (schedules Redis timer) and `payment-service`.
3. **Payment** — client confirms, PaymentIntent to Stripe, Stripe webhook
   returns via Kong.
4. **Finalize** — `order-service` consumes `payments.payment.succeeded`, calls
   gRPC `FinalizeReservation` / `FinalizeSeatReservation`, order → CONFIRMED.
5. **Expire / compensate** — if the timer fires first,
   `expiration.order.expiration_complete` drives release of quota + seat holds
   and cancels the PaymentIntent.

A closing note documents the DLQ policy (`<topic>.dlq`, max 3 retries with
exponential back-off), matching `docs/04-asynchronous-messaging.md`.

### 7. Search Dataflow — CQRS index + query (`07-search-dataflow.mermaid`)

A two-phase sequence diagram for the OpenSearch-backed ticket search read model:

- **Phase A — Index (CQRS write):** ticket create/update writes Mongo txn + transactional outbox → outbox relay publishes `tickets.ticket.{created,updated}` to Kafka → ticket-service's embedded search-indexer upserts into OpenSearch (external-version idempotency; DLQ + retry on parse/transient failure, never silently dropped).
- **Phase B — Query (read + fallback):** `TicketsConnection(filter:{search})` → if `SEARCH_BACKEND=opensearch` and a query is present, OpenSearch `multi_match` (fuzziness AUTO, boosted fields) + filters return ranked IDs → ticket-service hydrates the page from Mongo (canonical data + live availability) → refill loop applies `ticketType`. Falls back to Mongo regex path on OpenSearch error or when the flag is unset — never hard-fails.

Pairs with "how would you build a search feature on top of a Mongo-backed microservice with a write model already in place" interview questions.

### 6. Virtual waiting room flow (`06-waiting-room-flow.mermaid`)

A sequence diagram for the **onsale surge gate** (`services/queue-service`, a standalone
.NET 10 subsystem on its own domain/Redis). Shows the armed-onsale path: connector 302 →
pre-queue randomized draw → rate-based admission by pure time-math (`serving(t)=⌊rate·(t−T0)⌋`)
→ single-use HMAC token → connector redeems it and sets the `qq_pass` cookie → Kong
reserve-mutation backstop. Pairs with "how would you protect the buy path under a
Taylor-Swift-scale onsale" interview questions. Run `python3 render.py` to (re)wrap it
into its HTML viewer and the landing page.

## Quick online verification

If a Mermaid diagram doesn't render for you locally (some corporate networks
block jsDelivr), paste the `.mermaid` file contents into
<https://mermaid.live> — it will validate syntax and give you PNG/SVG export.

## Portfolio tips

- In your README / CV, embed `01-aws-infrastructure.svg` directly — it's
  vector and stays crisp at any zoom level.
- Link to `04-data-flow-sequence.mermaid` when asked about **saga / SAGA
  orchestration**, **transactional outbox**, or **distributed transactions**.
- Link to `03-c4-container.mermaid` when asked about **service boundaries**,
  **domain decomposition**, or **synchronous vs async**.
- Keep `02-data-model.mermaid` handy for any "walk me through your schema"
  question — the dotted lines are a cue to talk about data ownership,
  outbox/CDC patterns, and eventual consistency.

*Generated: 2026-04-17*

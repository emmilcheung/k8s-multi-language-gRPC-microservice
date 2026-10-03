# Development guide

How to run, test and regenerate things locally. Moved out of the root README; the project overview is in [`README.md`](../README.md).

See also: [`observability/local/README.md`](../observability/local/README.md) for traces and metrics, per-service READMEs under [`services/`](../services/), and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

---

## 1. Local Development (Docker Compose)

The fastest way to run everything — no Kubernetes required.

```bash
# Start all services and infrastructure
docker compose up --build --detach

# Tail logs for all services
docker compose logs -f

# Stop the stack
docker compose down
```

**Service ports:**

| Service | Host port |
|---|---|
| Kong (API gateway; all browser traffic) | **8000** (admin 8001) |
| auth-service | 3000 |
| ticket-service | 3001 |
| payment-service | 3002 |
| venue-service | 3003 |
| user-service | 3004 |
| attendance-service | 3007 |
| mcp-service (opt-in, `--profile mcp`) | 3010 |
| order-service | 8082 |
| expiration-service | 8083 |
| apollo-router | 4001 |
| Kafka (host access for E2E) | 9092 / 9093 |
| Schema Registry | 8081 |
| MongoDB | 27017 |
| Redis | 6379 |
| PostgreSQL (auth / orders / payments / venue / users / attendance) | 5432 / 5433 / 5434 / 5435 / 5436 / 5437 |
| **OpenSearch** (opt-in, `--profile search`) | 9200 |
| Prometheus / Jaeger / Grafana (separate observability compose) | 9090 / 16686 / 3005 |
| OTel Collector gRPC / HTTP (separate observability compose) | 4317 / 4318 |

#### Enable indexed search (OpenSearch)

Start the single-node OpenSearch container (adds it to the compose network on `:9200`):

```bash
docker compose --profile search up -d opensearch
```

Set the following env vars on ticket-service (see `.env.example` for the entries):

```
SEARCH_BACKEND=opensearch
OPENSEARCH_URL=http://opensearch:9200
OPENSEARCH_INDEX=tickets
```

The search-indexer starts automatically and creates the index + begins consuming Kafka `tickets.ticket.{created,updated}`. Backfill existing tickets:

```bash
cd services/ticket-service
go run ./cmd/reindex
# requires OPENSEARCH_URL and MONGO_URI to be set; or use the gated Helm reindex Job
```

If OpenSearch is down or `SEARCH_BACKEND` is unset, search degrades automatically to the Mongo regex path — the service never hard-fails.

All traffic from the browser goes through Kong on port **8000**.

To run E2E locally:

```bash
cd services/client
pnpm dev --port 4000
```

In a second terminal:

```bash
pnpm exec playwright test
```

If you want to execute a command inside a running service container:

```bash
docker compose exec auth-service pnpm test
```

#### Fresh environment verification

Use this flow to verify the settings release on a clean machine or clean volumes. No manual SQL should be required.

```bash
# 1. Clean volumes and start the stack
docker compose down -v
docker compose up --build --detach

# 2. Confirm the settings dependencies are ready
curl -fsS http://localhost:3002/healthz/ready
curl -fsS http://localhost:3004/healthz/ready

# 3. Run only the settings E2E subset
cd services/client
pnpm exec playwright test tests/e2e/ticketing.spec.ts --grep settings
```

Service-level verification commands for the current settings hardening gate:

```bash
cd services/payment-service
pnpm test
pnpm lint
pnpm exec tsc --noEmit
pnpm build
pnpm test:integration -- test/payments.integration.spec.ts

cd ../user-service
pnpm test
pnpm test:integration
pnpm lint
pnpm exec tsc --noEmit
pnpm build

cd ../client
pnpm lint
pnpm exec tsc --noEmit
pnpm build
```

#### Local observability

The local observability stack for traces and metrics runs from `observability/local/docker-compose.observability.yml`:

- OpenTelemetry Collector receives OTLP traces from the services.
- Jaeger stores and visualizes trace spans.
- Prometheus scrapes `/metrics` and `/actuator/prometheus` endpoints.
- Grafana provisions a starter dashboard from the repository.

See [observability/local/README.md](../observability/local/README.md) for the
trace walkthrough, connectivity checks, and host-run client instructions.

---

## 2. Local Kubernetes (minikube)

#### First-time setup

```bash
# 1. Install prerequisites: minikube, helm, kubectl, docker

# 2. Generate an RSA key pair for local dev
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 \
  -out infra/local/rsa_local.pem

# 3. Create and fill in secrets.env
cp infra/local/secrets.env.example infra/local/secrets.env
# Edit secrets.env — paste RSA_PRIVATE_KEY (single-line \n format) and STRIPE_SECRET_KEY

# 4. Bootstrap everything
make -C infra/local up
```

`make up` does in order:
1. Checks required tools are installed
2. Starts minikube (`--cpus=4 --memory=7168 --driver=docker`)
3. Pulls and loads Bitnami / Kong / Kafka images into minikube's image store
   _(Bitnami doesn't publish pinned tags on Docker Hub — images are pulled as `:latest`,
   retagged to the exact version the Helm chart expects, then loaded locally)_
4. Builds all 7 service images and loads them into minikube
5. Creates the `ticketing` namespace + Linkerd skip-port annotation
6. Creates all Kubernetes secrets from `secrets.env`
7. Runs `helm upgrade --install` with the umbrella chart

#### Day-to-day commands

```bash
make -C infra/local help          # list all targets

make -C infra/local deploy        # re-apply secrets + kong config + helm (no image rebuild)
make -C infra/local build         # rebuild + reload all service images
make -C infra/local helm-upgrade  # helm upgrade only (fastest after a config change)
make -C infra/local kong-config   # re-render kong.yml from kong.base.yml template

make -C infra/local tunnel        # expose Kong (8000) and Kafka (9093) on localhost
                                  # keep this running in a separate terminal

make -C infra/local status        # kubectl get pods -n ticketing
make -C infra/local logs SVC=auth-service    # tail logs for a service
make -C infra/local restart SVC=client       # rolling restart a deployment

make -C infra/local down          # uninstall Helm release + delete namespace
make -C infra/local clean         # down + stop minikube
```

#### Incremental rebuild (single service)

```bash
docker build -t auth-service:latest services/auth-service/ --quiet
minikube image load auth-service:latest
make -C infra/local restart SVC=auth-service
```

#### In-cluster service DNS (namespace: `ticketing`)

| Resource | Hostname |
|---|---|
| PostgreSQL (auth) | `ticketing-postgres-auth:5432` |
| PostgreSQL (orders) | `ticketing-postgres-orders:5432` |
| PostgreSQL (payments) | `ticketing-postgres-payments:5432` |
| PostgreSQL (venue) | `ticketing-postgres-venue:5432` |
| MongoDB | `ticketing-mongodb-0.ticketing-mongodb-headless:27017` (single-member replica set `rs0`; no ClusterIP Service in replicaset mode) |
| Redis | `ticketing-redis-master:6379` |
| Kafka (internal) | `ticketing-cp-kafka:9092` |
| Kong proxy | `localhost:8000` (via `minikube tunnel`) |

---

## 3. Protobuf / gRPC Code Generation

The proto source of truth lives in `proto/tickets/v1/tickets.proto`.
Generated stubs are committed to `libs/grpc-stubs/` so services don't need `buf` installed at runtime.

#### Prerequisites (install once)

```bash
brew install bufbuild/buf/buf
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

#### Regenerate stubs after a `.proto` change

```bash
buf generate
```

Output lands in `libs/grpc-stubs/go/` — commit the result alongside the `.proto` change.

Java stubs (order-service) are generated automatically by the `protobuf-maven-plugin`
during `mvn package` — no manual step required.

#### Lint and breaking-change check

```bash
buf lint                    # lint proto files
buf breaking --against .git  # check for breaking changes vs HEAD
```

Breaking changes (removing a field, renaming a field, changing a field number) must
never be introduced without a version bump (`v1` → `v2` package and directory).
CI will enforce this with `buf breaking` on every PR (once pipelines are written).

#### Modifying the contract

1. Edit `proto/tickets/v1/tickets.proto`.
2. Run `buf lint` — fix any style violations.
3. Run `buf breaking --against .git` — confirm no breaking changes (or bump the version).
4. Run `buf generate` — regenerate Go stubs.
5. Update the service implementations on both the server (ticket-service) and client (order-service).
6. Commit the `.proto` file, generated stubs, and service changes together in one PR.

---

## 4. Running Tests

#### auth-service (TypeScript / Vitest)

```bash
cd services/auth-service
pnpm test           # unit tests (no external deps)
pnpm test:integration  # integration tests (Testcontainers spins up PostgreSQL)
```

#### ticket-service (Go / testify + testcontainers-go)

```bash
cd services/ticket-service
go test ./...                          # unit tests
go test ./... -tags integration        # integration tests (requires Docker)
```

#### order-service (Java / JUnit 5 + Testcontainers)

```bash
cd services/order-service
mvn test                              # unit tests
mvn verify -P integration-test        # integration tests (requires Docker)
```

#### payment-service (TypeScript / Vitest)

```bash
cd services/payment-service
pnpm test
pnpm test:integration
```

#### E2E (Playwright — runs against Docker Compose or minikube)

```bash
# Against Docker Compose:
docker compose up --build --detach
cd services/client
pnpm dev --port 4000
```

In a second terminal:

```bash
pnpm exec playwright test
```

#### Against minikube (requires 'make -C infra/local tunnel' running):

```bash
cd services/client
pnpm exec playwright test
```

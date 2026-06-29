# OpenSearch Indexed Ticket Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the title-only Mongo `$regex` catalogue search with a relevance-ranked, typo-tolerant, multi-field OpenSearch read model that stays fast under load, behind a `SEARCH_BACKEND` flag with Mongo fallback.

**Architecture:** CQRS read model. OpenSearch is a derived index fed by the existing `tickets.ticket.created/updated` outbox→Kafka stream; it returns ranked ticket IDs only. Mongo stays source of truth and hydrates canonical docs + live availability at query time (volatile `reserved`/`sold` never enter the index, so the gRPC reservation hot path is untouched). The refill loop and `ticketType` post-filter are owned by the GraphQL resolver.

**Tech Stack:** Go 1.25+ (ticket-service), `opensearch-project/opensearch-go/v4` (new dep), `confluent-kafka-go/v2` (consumer), MongoDB driver v2, `testcontainers-go`, Next.js 16 client, Helm, docker-compose.

**Spec:** `docs/superpowers/specs/2026-06-23-opensearch-ticket-search-design.md` (Rev 3, A− ship-ready).

## Global Constraints

- `SEARCH_BACKEND` env defaults to `mongo`; OpenSearch path is opt-in. Search must **never hard-fail** the browse page — on OpenSearch error, log `WARN`, increment `search_fallback_total`, serve Mongo regex.
- **No proto change, no Kafka topic/partition/retention change** (hard-stop). Changes to the event are additive payload fields only.
- **GraphQL schema (`schema.graphqls`) does not change** — `TicketsConnection(filter, first, after)` and `after: String` stay as-is. Cursor *encoding* may change.
- **New Go dependency** `github.com/opensearch-project/opensearch-go/v4` — adding it is a noted hard-stop (record in the commit body and `docs/16-session-progress-log.md`).
- Structured logging via `go.uber.org/zap`; every log line carries `traceId`, `spanId`, `service=ticket-service`. Never log PII or secrets; strip newlines from user-controlled fields.
- Single-node OpenSearch locally: `discovery.type=single-node`, security demo disabled, heap ~512 MB. Helm subchart `opensearch` is **disabled by default** in `values-local.yaml`.
- Fail loud at startup: with `SEARCH_BACKEND=opensearch`, a missing/malformed `OPENSEARCH_URL` aborts boot. OpenSearch is a **soft** readiness dependency (never fails `/healthz/ready`).
- Build/lint gate per touched service before each commit: `go build ./...`, `go vet ./...`, `go test ./...` (ticket-service); `pnpm lint && pnpm exec tsc --noEmit` (client). See `.claude/skills/lint-check/SKILL.md`.

---

### Task 1: Write-path plumbing — `category` + `createdAt` reach the event

**Files:**
- Modify: `services/ticket-service/internal/repository/mongo_ticket_repository.go` (`TicketOutboxPayload` struct ~`:99`; `normalizePendingOutboxEvent` `:155-182`)
- Modify: `services/ticket-service/internal/service/ticket_service.go` (`buildOutboxPayload` `:90-115`)
- Modify: `services/ticket-service/internal/kafka/producer.go` (`TicketEventData` `:44-57`)
- Modify: `services/ticket-service/internal/outbox/relay.go` (`:117-140`)
- Test: `services/ticket-service/internal/outbox/relay_test.go` (existing) + `services/ticket-service/internal/repository/mongo_ticket_repository_test.go` (or nearest existing unit test file)

**Interfaces:**
- Produces: `TicketEventData.Category string` (JSON `category`) and `TicketEventData.CreatedAt string` (JSON `createdAt`, RFC3339). The indexer (Task 4) consumes these.

- [ ] **Step 1: Write the failing test** — assert the relayed event carries both fields.

In `relay_test.go`, add (adapt to the file's existing fixture helpers):

```go
func TestRelay_TicketEventData_CarriesCategoryAndCreatedAt(t *testing.T) {
	created := time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)
	payload := repository.TicketOutboxPayload{
		ID: "tk_1", Title: "Eras Tour", Category: "MUSIC", CreatedAt: created,
	}
	got := buildTicketEventData(payload) // the relay's payload->event mapper (see Step 3)
	require.Equal(t, "MUSIC", got.Category)
	require.Equal(t, created.Format(time.RFC3339), got.CreatedAt)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./internal/outbox/ -run TestRelay_TicketEventData_CarriesCategoryAndCreatedAt -v`
Expected: FAIL — `Category`/`CreatedAt` undefined on the struct(s).

- [ ] **Step 3: Implement — add fields through all four layers.**

`mongo_ticket_repository.go` — add to `TicketOutboxPayload`:
```go
Category  string    `bson:"category,omitempty"`
CreatedAt time.Time `bson:"createdAt"`
```
In `normalizePendingOutboxEvent` (authoritative — runs after `Create` sets `t.CreatedAt`):
```go
event.Payload.Category = ticket.Category
event.Payload.CreatedAt = ticket.CreatedAt
```
`ticket_service.go` `buildOutboxPayload` — set `Category` (CreatedAt is filled by normalize; setting it here is harmless but optional):
```go
payload.Category = ticket.Category
```
`producer.go` — add to `TicketEventData`:
```go
Category  string `json:"category,omitempty"`
CreatedAt string `json:"createdAt,omitempty"` // RFC3339
```
`relay.go` — in the payload→event mapping (extract a `buildTicketEventData(payload) kafka.TicketEventData` helper if not present, so the test can call it), add:
```go
Category:  event.Payload.Category,
CreatedAt: event.Payload.CreatedAt.Format(time.RFC3339),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd services/ticket-service && go test ./internal/outbox/ ./internal/repository/ -v && go vet ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ticket-service/internal/repository/mongo_ticket_repository.go \
        services/ticket-service/internal/service/ticket_service.go \
        services/ticket-service/internal/kafka/producer.go \
        services/ticket-service/internal/outbox/relay.go \
        services/ticket-service/internal/outbox/relay_test.go
git commit -m "feat(ticket): carry category+createdAt on ticket events for search index"
```

---

### Task 2: Config + local OpenSearch (docker-compose)

**Files:**
- Modify: `services/ticket-service/internal/config/config.go` (+ matching validation)
- Test: `services/ticket-service/internal/config/config_test.go`
- Modify: `docker-compose.yml` (add `opensearch` service under a `search` profile)
- Modify: `services/ticket-service/.env.example`

**Interfaces:**
- Produces: `cfg.OpenSearchURL string`, `cfg.SearchBackend string` (`mongo`|`opensearch`), `cfg.OpenSearchIndex string` (default `tickets`). Consumed by Tasks 3–6.

- [ ] **Step 1: Write the failing test**

```go
func TestConfig_SearchBackendOpensearch_RequiresValidURL(t *testing.T) {
	t.Setenv("SEARCH_BACKEND", "opensearch")
	t.Setenv("OPENSEARCH_URL", "") // missing
	_, err := config.Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "OPENSEARCH_URL")
}

func TestConfig_DefaultsToMongoBackend(t *testing.T) {
	// no SEARCH_BACKEND set
	cfg, err := config.Load() // provide other required envs via the file's existing helper
	require.NoError(t, err)
	require.Equal(t, "mongo", cfg.SearchBackend)
	require.Equal(t, "tickets", cfg.OpenSearchIndex)
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./internal/config/ -run TestConfig_Search -v`
Expected: FAIL — fields/validation absent.

- [ ] **Step 3: Implement config**

Add to the config struct + `Load()` (follow the file's existing `getEnv`/validation idiom):
```go
SearchBackend  string // "mongo" (default) | "opensearch"
OpenSearchURL  string
OpenSearchIndex string

// in Load():
cfg.SearchBackend = getEnvDefault("SEARCH_BACKEND", "mongo")
cfg.OpenSearchURL = os.Getenv("OPENSEARCH_URL")
cfg.OpenSearchIndex = getEnvDefault("OPENSEARCH_INDEX", "tickets")
if cfg.SearchBackend == "opensearch" {
	if _, err := url.ParseRequestURI(cfg.OpenSearchURL); err != nil {
		return nil, fmt.Errorf("SEARCH_BACKEND=opensearch requires a valid OPENSEARCH_URL: %w", err)
	}
}
```

- [ ] **Step 4: Add the compose service + env example**

`docker-compose.yml`:
```yaml
  opensearch:
    image: opensearchproject/opensearch:2.17.1
    profiles: ["search"]
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true
      - "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"
    ports: ["9200:9200"]
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://localhost:9200/_cluster/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
```
`.env.example`: add `SEARCH_BACKEND=mongo`, `OPENSEARCH_URL=http://localhost:9200`, `OPENSEARCH_INDEX=tickets`.

- [ ] **Step 5: Run config tests + start the container**

Run: `cd services/ticket-service && go test ./internal/config/ -v`
Expected: PASS.
Run: `docker compose --profile search up -d opensearch && sleep 20 && curl -fsS localhost:9200/_cluster/health`
Expected: JSON with `"status":"green"` or `"yellow"`.

- [ ] **Step 6: Commit**

```bash
git add services/ticket-service/internal/config/config.go \
        services/ticket-service/internal/config/config_test.go \
        services/ticket-service/.env.example docker-compose.yml
git commit -m "feat(ticket): add SEARCH_BACKEND config + opt-in opensearch compose service"
```

---

### Task 3: OpenSearch client + index bootstrap (`internal/search`)

**Files:**
- Create: `services/ticket-service/internal/search/client.go`
- Create: `services/ticket-service/internal/search/mapping.go`
- Create: `services/ticket-service/test/search_index_integration_test.go`
- Modify: `services/ticket-service/go.mod` (new dep — noted hard-stop)

**Interfaces:**
- Produces:
  - `func NewClient(url, index string, log *zap.Logger) (*Client, error)`
  - `func (c *Client) EnsureIndex(ctx context.Context) error` — idempotent; creates the `tickets` index with the §4.1 mapping if absent.
  - `func (c *Client) Ping(ctx context.Context) error`
  - `type Doc struct { ... }` (the slim index document; see Task 4 for fields).

- [ ] **Step 1: Add the dependency (noted)**

Run: `cd services/ticket-service && go get github.com/opensearch-project/opensearch-go/v4@latest`
Note in commit body: new dep required for the search read model (no managed alternative; Apache-2.0).

- [ ] **Step 2: Write the failing integration test**

```go
//go:build integration

func TestEnsureIndex_CreatesMappingIdempotently(t *testing.T) {
	ctx := context.Background()
	url := startOpenSearchContainer(t) // testcontainers helper (opensearchproject/opensearch:2.17.1, single-node, security disabled)
	c, err := search.NewClient(url, "tickets_test", zap.NewNop())
	require.NoError(t, err)
	require.NoError(t, c.EnsureIndex(ctx))
	require.NoError(t, c.EnsureIndex(ctx)) // idempotent second call
	props := getMappingProperties(t, url, "tickets_test")
	require.Equal(t, "text", props["eventTitle"].(map[string]any)["type"])
	require.Equal(t, "keyword", props["category"].(map[string]any)["type"])
	require.Equal(t, "date", props["createdAt"].(map[string]any)["type"])
}
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestEnsureIndex -v`
Expected: FAIL — `search` package undefined.

- [ ] **Step 4: Implement client + mapping**

`mapping.go` — export the mapping JSON (matches spec §4.1):
```go
const indexMapping = `{
  "mappings": { "properties": {
    "eventTitle":   {"type":"text"},
    "title":        {"type":"text"},
    "venueName":    {"type":"text"},
    "description":  {"type":"text"},
    "venueAddress": {"type":"text"},
    "category":     {"type":"keyword"},
    "ticketType":   {"type":"keyword"},
    "seatingPlanId":{"type":"keyword"},
    "price":        {"type":"scaled_float","scaling_factor":100},
    "startsAt":     {"type":"date"},
    "createdAt":    {"type":"date"}
  }}
}`
```
`client.go` — wrap `opensearch-go/v4`: `NewClient` builds `opensearchapi.Client`; `EnsureIndex` does `HEAD /<index>`; if 404, `PUT /<index>` with `indexMapping`; treat `resource_already_exists_exception` as success. `Ping` calls cluster health.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestEnsureIndex -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/ticket-service/internal/search/ services/ticket-service/test/search_index_integration_test.go \
        services/ticket-service/go.mod services/ticket-service/go.sum
git commit -m "feat(ticket): add opensearch client + tickets index bootstrap

New dependency: opensearch-project/opensearch-go/v4 (search read model; Apache-2.0)."
```

---

### Task 4: Indexer — Kafka consumer upserts the slim doc

**Files:**
- Create: `services/ticket-service/internal/search/indexer.go`
- Modify: `services/ticket-service/cmd/server/main.go` (wire the consumer goroutine when `SEARCH_BACKEND=opensearch`)
- Create: `services/ticket-service/test/search_indexer_integration_test.go`

**Interfaces:**
- Consumes: `kafka.TicketEventData` (now with `Category`,`CreatedAt`), `search.Client`.
- Produces:
  - `func (c *Client) UpsertTicket(ctx context.Context, d Doc) error` — `_id=d.ID`, `version=d.Version`, `version_type=external`.
  - `type Doc struct { ID string; EventTitle, Title, VenueName, Description, VenueAddress, Category, TicketType, SeatingPlanID string; Price float64; StartsAt, CreatedAt string; Version int }`
  - `func NewIndexer(c *Client, brokers []string, log *zap.Logger, sec kafka.SecurityConfig) (*Indexer, error)` and `func (i *Indexer) Run(ctx context.Context) error` — follows the consumer pattern in `services/venue-service/internal/kafka/consumer.go` (subscribe `tickets.ticket.created`,`tickets.ticket.updated`; manual commit after successful upsert; route decode failures to the existing `.dlq` convention).

- [ ] **Step 1: Write the failing integration test** — ordering + non-zero createdAt.

```go
//go:build integration

func TestIndexer_ExternalVersion_IgnoresStaleUpdate(t *testing.T) {
	ctx := context.Background()
	url := startOpenSearchContainer(t)
	c, _ := search.NewClient(url, "tickets_test", zap.NewNop())
	require.NoError(t, c.EnsureIndex(ctx))

	require.NoError(t, c.UpsertTicket(ctx, search.Doc{ID: "tk1", EventTitle: "Eras Tour v2", Version: 2, CreatedAt: "2026-06-01T12:00:00Z"}))
	// stale lower-version update must NOT overwrite
	err := c.UpsertTicket(ctx, search.Doc{ID: "tk1", EventTitle: "Eras Tour v1", Version: 1, CreatedAt: "2026-06-01T12:00:00Z"})
	require.NoError(t, err) // external-version conflict is swallowed as success
	doc := getDoc(t, url, "tickets_test", "tk1")
	require.Equal(t, "Eras Tour v2", doc["eventTitle"])
	require.NotEmpty(t, doc["createdAt"]) // regression guard: createdAt never zero
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestIndexer_ExternalVersion -v`
Expected: FAIL — `UpsertTicket` undefined.

- [ ] **Step 3: Implement `UpsertTicket` + indexer**

`UpsertTicket`: `PUT /<index>/_doc/<id>?version=<Version>&version_type=external` with the JSON doc; on HTTP 409 (`version_conflict_engine_exception`) return nil (stale event, expected). `indexer.go`: consumer loop decodes `kafka.TicketEventData`, maps event→`Doc` (`EventTitle = Event.Title`, `VenueName = Event.VenueName`, etc.; `Price` parsed from the decimal string), calls `UpsertTicket`, commits offset on success.

- [ ] **Step 4: Wire into main.go**

After the search client is constructed (gated on `cfg.SearchBackend == "opensearch"`), mirror the relay goroutine at `cmd/server/main.go:156-158`:
```go
if cfg.SearchBackend == "opensearch" {
	if err := searchClient.EnsureIndex(context.Background()); err != nil { log.Fatal("ensure search index", zap.Error(err)) }
	indexer, err := search.NewIndexer(searchClient, cfg.KafkaBrokers, log, kafkaSecurity)
	if err != nil { log.Fatal("search indexer", zap.Error(err)) }
	go func() { if err := indexer.Run(idxCtx); err != nil { log.Error("search indexer stopped", zap.Error(err)) } }()
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestIndexer -v && go build ./...`
Expected: PASS, build OK.

- [ ] **Step 6: Commit**

```bash
git add services/ticket-service/internal/search/indexer.go services/ticket-service/cmd/server/main.go \
        services/ticket-service/test/search_indexer_integration_test.go
git commit -m "feat(ticket): kafka-fed opensearch indexer with external-version idempotency"
```

---

### Task 5: Query path — `SearchTickets` primitive + resolver refill loop + fallback

**Files:**
- Create: `services/ticket-service/internal/search/query.go`
- Modify: `services/ticket-service/internal/service/ticket_service.go` (add `SearchTickets`)
- Modify: `services/ticket-service/internal/graphql/schema.resolvers.go` (`TicketsConnection` `:142-214` — refill loop + cursor)
- Test: `services/ticket-service/internal/graphql/resolver_test.go` + `services/ticket-service/test/search_query_integration_test.go`

**Interfaces:**
- Produces:
  - `type Result struct { Ticket *repository.Ticket; Cursor string }` (Cursor = `os:<score>:<id>`)
  - `func (s *TicketService) SearchTickets(ctx context.Context, p repository.PaginationParams, after string) (results []search.Result, exhausted bool, err error)` — OpenSearch `multi_match` (`eventTitle^3,title^2,venueName^2,description,venueAddress`, `fuzziness:AUTO`) + `category`/`price` filters + `search_after`; hydrates via `repo.FindByIDs`; applies `availableOnly`; pairs each survivor with its `os:` cursor.
- Consumes: `search.Client`, `repository.PaginationParams`, `ListTickets` (Mongo fallback).

- [ ] **Step 1: Write failing integration test** — relevance + refill.

```go
//go:build integration

func TestSearch_TypoAndBoostAndRefill(t *testing.T) {
	// seed index: ticket A eventTitle "Taylor Swift Eras", ticket B description "...swift boat...",
	// plus 25 SOLD-OUT tickets ranked above 3 available ones for the availableOnly refill case.
	res, exhausted, err := svc.SearchTickets(ctx, repository.PaginationParams{Search: "swfit", Limit: 10}, "")
	require.NoError(t, err)
	require.Equal(t, "A", res[0].Ticket.ID)          // typo-tolerant, title-boosted over description
	_ = exhausted

	// availableOnly must still return a full page despite many top sold-out hits
	avail, _, err := svc.SearchTickets(ctx, repository.PaginationParams{Search: "concert", AvailableOnly: true, Limit: 3}, "")
	require.NoError(t, err)
	require.Len(t, avail, 3)
}
```

Also add a resolver unit test for the cursor cross-mode contract (spec §11):
```go
func TestParseCursor_OSPrefix_RestartsOnMongoPath(t *testing.T) {
	_, _, ok := parseCursor("os:1.5:tk1") // os: cursor handed to the Mongo path
	require.False(t, ok)                  // => pagination restarts at page 1, no dup/skip
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestSearch_TypoAndBoostAndRefill -v`
Expected: FAIL — `SearchTickets` undefined.

- [ ] **Step 3: Implement `SearchTickets` (service + query.go)**

`query.go` builds the OpenSearch body (multi_match + filter clause for `category` term and `price` range, `sort:[_score desc, _id asc]`, `search_after` from a parsed `os:` cursor), executes, returns ranked IDs + per-hit sort tuples. Service `SearchTickets`: call query → `repo.FindByIDs(ids)` → apply `AvailableOnly` (GA: `Sold<Quota`; seated: `SeatingPlanID!=""`) → wrap survivors as `search.Result{Ticket, Cursor:"os:<score>:<id>"}`; `exhausted = len(hits) < p.Limit`.

- [ ] **Step 4: Implement the resolver refill loop**

First extract the current `TicketsConnection` body (the Mongo path) into a helper
`r.ticketsConnectionMongo(ctx, filter, limit, cursorIn)` so both backends share it.
Add `const maxRefill = 5` (caps worst-case fan-out). Inject a `*zap.Logger` into the
resolver if it has none. Then, when `cfg.SearchBackend=="opensearch"` and
`filter.Search` is non-empty:
```go
page := make([]*Ticket, 0, limit)
after := cursorIn // "" or "os:..."
for iter := 0; len(page) < limit && iter < maxRefill; iter++ {
	results, exhausted, err := r.TicketService.SearchTickets(ctx, params, after)
	if err != nil { // FALLBACK — never hard-fail browse
		r.log.Warn("opensearch query failed; serving mongo fallback", zap.Error(err))
		// (Task 8 adds: search_fallback_total.Inc() here)
		return r.ticketsConnectionMongo(ctx, filter, limit, cursorIn) // extracted above
	}
	for _, res := range results {
		if filter.TicketType == nil || string(res.Ticket.TicketType) == string(*filter.TicketType) {
			page = append(page, mapTicketToGQL(res.Ticket))
			endCursor = res.Cursor
			if len(page) == limit { break }
		}
		after = res.Cursor
	}
	if exhausted { break }
}
```
Cursor parsing: a bare `<ms>:<id>` (or empty) → Mongo path; an `os:` prefix → relevance `search_after`. If an `os:` cursor reaches the Mongo path (fallback/mode switch), `parseCursor` returns `ok=false` and pagination restarts at page 1 (already its behavior — verified).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd services/ticket-service && go test ./internal/graphql/ -v && go test ./test/ -tags integration -run TestSearch -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/ticket-service/internal/search/query.go services/ticket-service/internal/service/ticket_service.go \
        services/ticket-service/internal/graphql/schema.resolvers.go services/ticket-service/internal/graphql/resolver_test.go \
        services/ticket-service/test/search_query_integration_test.go
git commit -m "feat(ticket): opensearch query path with resolver refill loop + mongo fallback"
```

---

### Task 6: Backfill / reindex command

**Files:**
- Create: `services/ticket-service/cmd/reindex/main.go`
- Create: `services/ticket-service/test/reindex_integration_test.go`

**Interfaces:**
- Consumes: `repository.FindAll`, `search.Client.UpsertTicket`.
- Produces: a CLI that pages all tickets from Mongo and upserts them; logs `reindex_progress` (done/total).

- [ ] **Step 1: Write the failing integration test**

```go
//go:build integration
func TestReindex_PopulatesIndexFromMongo(t *testing.T) {
	// seed 3 tickets in Mongo, empty index
	require.NoError(t, search.Reindex(ctx, mongoRepo, client, 500))
	require.Equal(t, int64(3), countDocs(t, url, "tickets_test"))
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestReindex -v`
Expected: FAIL — `Reindex` undefined.

- [ ] **Step 3: Implement `search.Reindex` + thin `cmd/reindex` wrapper**

`Reindex(ctx, repo, client, pageSize)`: loop `repo.FindAll` with cursor paging; map each `*repository.Ticket`→`Doc`; `UpsertTicket`; log progress every page. `cmd/reindex/main.go` loads config, builds repo+client, calls `Reindex`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd services/ticket-service && go test ./test/ -tags integration -run TestReindex -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add services/ticket-service/cmd/reindex/ services/ticket-service/internal/search/ services/ticket-service/test/reindex_integration_test.go
git commit -m "feat(ticket): one-shot opensearch reindex command for backfill"
```

---

### Task 7: Client — preserve relevance order (sort guard)

**Files:**
- Modify: `services/client/app/page.tsx` (`:38` derive `explicitSort`; `:147-154` guard the sort)
- Test: `services/client/__tests__/home-sort.test.ts` (or nearest page unit-test file)

**Interfaces:**
- Consumes: `q` (`page.tsx:32`), raw `resolvedParams.sort`. Produces: relevance order preserved when `q` present and no explicit sort (UX rule B).

- [ ] **Step 1: Write the failing test** — pure-function extract for testability.

Extract the ordering decision into a tiny pure helper `shouldClientSort(q: string, rawSort: unknown): boolean` and test it:
```ts
import { shouldClientSort } from "@/app/page";
test("preserve relevance when q present and no explicit sort", () => {
  expect(shouldClientSort("swift", undefined)).toBe(false);
});
test("honor explicit sort even with q (rule B)", () => {
  expect(shouldClientSort("swift", "date")).toBe(true);
  expect(shouldClientSort("swift", "price")).toBe(true);
});
test("browse (no q) always client-sorts", () => {
  expect(shouldClientSort("", undefined)).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/client && pnpm test home-sort`
Expected: FAIL — `shouldClientSort` not exported.

- [ ] **Step 3: Implement the guard**

In `page.tsx`:
```ts
export function shouldClientSort(q: string, rawSort: unknown): boolean {
  const explicitSort = rawSort === "date" || rawSort === "price";
  return !q || explicitSort;
}
```
Keep line 38 (`const sort = ...`) for the dropdown's selected-state. Wrap the `.sort()` at `:147-154`:
```ts
const ordered = shouldClientSort(q, resolvedParams.sort)
  ? tickets.sort(/* existing comparator */)
  : tickets; // preserve backend relevance order
```
(Replace later uses of `tickets` in render with `ordered`, or reassign.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd services/client && pnpm test home-sort && pnpm lint && pnpm exec tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add services/client/app/page.tsx services/client/__tests__/home-sort.test.ts
git commit -m "feat(client): preserve server relevance order when searching (UX rule B)"
```

---

### Task 8: Metrics, Helm subchart, docs (rollout hardening)

**Files:**
- Modify: `services/ticket-service/internal/middleware/` (or existing metrics file) — register search metrics
- Create: `infra/helm/charts/opensearch/` (Chart.yaml, values.yaml, templates: statefulset/deployment + service)
- Modify: `infra/helm/values.yaml`, `infra/helm/values-local.yaml` (`opensearch.enabled=false` local), `infra/helm/Chart.yaml` (declare subchart)
- Modify: `docs/08-observability.md` (soft-dep exception), `README.md` (port 9200), `docs/16-session-progress-log.md`

**Interfaces:**
- Produces Prometheus metrics: `search_query_duration_seconds{backend}`, `search_fallback_total`, `search_indexer_lag_seconds`, `search_refill_iterations`, `reindex_progress`.

- [ ] **Step 1: Write the failing metric test**

```go
func TestSearchMetrics_Registered(t *testing.T) {
	m := metrics.NewSearchMetrics(prometheus.NewRegistry())
	m.Fallback.Inc()
	require.Equal(t, 1.0, testutil.ToFloat64(m.Fallback))
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd services/ticket-service && go test ./internal/metrics/ -run TestSearchMetrics -v`
Expected: FAIL — `NewSearchMetrics` undefined.

- [ ] **Step 3: Implement metrics + wire into query/indexer/reindex paths**

Define the counters/histograms in a `metrics` helper; increment `Fallback` in the resolver fallback branch (Task 5), observe `QueryDuration{backend}` around each path, set `IndexerLag` from `now - event.CreatedAt` in the indexer, observe `RefillIterations`, set `ReindexProgress` in `Reindex`.

- [ ] **Step 4: Helm subchart (opt-in, off locally)**

Create `infra/helm/charts/opensearch/` (single-node Deployment, `discovery.type=single-node`, security demo disabled, resources ~512Mi/1Gi, ClusterIP service `:9200`). In `infra/helm/Chart.yaml` add the dependency with `condition: opensearch.enabled`; set `opensearch.enabled=false` in `values-local.yaml`, `true` in `values.yaml`. Set ticket-service `OPENSEARCH_URL`/`SEARCH_BACKEND` from values.

- [ ] **Step 5: Verify chart renders + run service tests**

Run: `helm template infra/helm -f infra/helm/values-local.yaml | grep -c opensearch` → expect `0` (disabled locally).
Run: `helm template infra/helm --set opensearch.enabled=true | grep -c 'kind: Deployment'` → opensearch Deployment present.
Run: `cd services/ticket-service && go test ./... && go vet ./...`
Expected: PASS.

- [ ] **Step 6: Docs + commit**

Update `docs/08-observability.md` (OpenSearch is a documented soft-dependency exception to the readiness rule), `README.md` (port 9200, `--profile search`), and append a `docs/16-session-progress-log.md` entry (incl. the new `opensearch-go` dependency).
```bash
git add services/ticket-service/internal/metrics/ infra/helm/ docs/08-observability.md README.md docs/16-session-progress-log.md
git commit -m "feat(search): search metrics, opt-in opensearch helm subchart, docs"
```

---

## Notes for the executor

- Integration tests use `testcontainers-go`; if Testcontainers is unavailable on the host (see memory on this mac), run OpenSearch via `docker compose --profile search up -d opensearch` and point tests at `localhost:9200` with an env guard, mirroring the queue-service external-Redis pattern.
- Run the full `pnpm test` (client) and `go test ./...` (ticket-service) before the final commit of each touched service — tsc/lint green can miss cross-file regressions.
- Do **not** merge to `main`; stop after the branch is green and request owner approval (CONTRIBUTING.md).

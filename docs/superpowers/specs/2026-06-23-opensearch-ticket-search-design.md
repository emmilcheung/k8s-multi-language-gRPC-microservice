# Indexed Ticket Search (OpenSearch) — Design

> **Status:** Draft for review · 2026-06-23 · **Rev 3** (revised 2026-06-24 after
> two review rounds — corrected client/API mismatches, outbox field-plumbing,
> dual-title relevance, refill pagination, versioned cursor, ops metrics; Rev 3
> resolves refill-loop ownership (resolver-owned) and the `sort`-param signal).
> **Scope (this cycle):** the **search** subsystem only — and within that, **v1
> upgrades the free-text `q` query only** (relevance, typo tolerance, multi-field).
> Moving `date`/`ticketType` filtering server-side is explicitly **out of v1** (see
> [§2](#2-scope--non-goals)). The OpenSearch cluster is sized for search docs now; a
> later cycle reuses it for centralised logs (EFK) — see [§10](#10-future-logs-reuse).
> **Engine decision:** OpenSearch (Apache-2.0), over the lighter Mongo 8.2 `$search`
> path, because the engine is also the future log store and has an API-compatible
> AWS-managed endpoint — see [§9](#9-considered-alternatives).

## 1. Problem & goal

Catalogue search today is a single unindexed regex in
`ticket-service/internal/repository/mongo_ticket_repository.go:656-682`:

```go
filter["title"] = bson.M{"$regex": regexp.QuoteMeta(p.Search), "$options": "i"}
```

Three concrete defects:

1. **Unindexed collection scan.** A non-anchored case-insensitive regex cannot use
   a B-tree index, so every search is O(collection) — latency grows linearly with
   ticket count. This is the "slow under load" symptom.
2. **Title-only, exact-substring.** `description`, `venueName`, `venueAddress`,
   `category`, and crucially the **nested `event.title`** (the field the UI leads
   with) are never searched; there is no typo tolerance ("swfit" → nothing) or
   out-of-order matching.
3. **No relevance.** Results return in `createdAt` order, and the **client
   re-sorts them again** by date/price (`services/client/app/page.tsx:147-154`), so
   even a perfectly ranked backend result is discarded before render.

**Goal:** make `q` search relevance-ranked, typo-tolerant, and multi-field (incl.
`event.title`), fast as ticket count grows, with relevance actually reaching the
UI — **without breaking** the GraphQL `TicketsConnection(filter, first, after)`
contract.

## 2. Scope & non-goals

**In v1:**
- OpenSearch-backed `q` (free-text) search: relevance + fuzziness + multi-field.
- Index fed by the existing `ticket.created/updated` Kafka stream.
- The filters **already wired server-side today** continue to work, mapped onto
  OpenSearch: `category`, `minPrice`/`maxPrice`, `availableOnly`.
- A **minimal client change** so relevance order survives to the grid (§6).

**Explicitly NOT in v1** (these are *not* server-side today; leaving them as-is):
- `date` filtering — currently **client-side** bucketing
  (`tonight`/`weekend`/`week`/`month`) in `page.tsx:124-145`; `TicketFilter` has no
  date field (`internal/graphql/model.go:102-109`). Stays client-side.
- `ticketType` filtering — currently an **in-memory post-filter** in the resolver
  (`internal/graphql/schema.resolvers.go:180-189`); `PaginationParams` has no
  `ticketType` (`mongo_ticket_repository.go:252-260`). Stays a resolver post-filter,
  applied **inside the resolver-owned refill loop** so it no longer underfills pages
  (§5.3).
- Logs / EFK pipeline (separate cycle; reuses this cluster — §10).
- Other entities (venues, users), Dashboards UI, vector/semantic search.
- Production multi-node sizing, snapshots, and the AWS-managed-endpoint cutover
  (design stays *compatible* — §9 — but does not execute it).

## 3. Architecture — CQRS read model (Mongo stays source of truth)

OpenSearch is a **derived read model**, not a second source of truth. It is fed
asynchronously from the existing transactional-outbox → Kafka stream, and it
returns **ranked ticket IDs only**; canonical display data and volatile
availability are hydrated from Mongo at query time.

```
WRITE PATH (exists)                INDEX PATH (new)                 READ PATH (modified)
CreateTicket / UpdateTicket        internal/search consumer         GraphQL TicketsConnection
  └─ Mongo txn + outbox  ──Kafka──► upsert slim doc  ──────────────► OpenSearch: rank + stable
     tickets.ticket.created/         _id = ticketId                    filters → [ticketIDs]
     updated                         version_type = external        └─ refill loop:
                                     (ticket Version)                   Mongo FindByIDs hydrate
                                                                        + post-filters → page
```

**Why ranked-IDs-then-hydrate is the keystone.** Reservations mutate
`reserved`/`sold` on the **gRPC hot path** (`ReserveQuota` / `FinalizeReservation`
/ `ReleaseReservation` → `repo.CreateReservation`, gated by the Redis quota
manager) and emit **no Kafka event**. An index fed only by `ticket.created/updated`
would therefore carry **stale availability**. Keeping volatile counters *out* of
the index and reading them from Mongo at query time removes that problem and keeps
index churn low. The authoritative availability gate remains `ReserveQuota`
(Redis); browse availability is, and is allowed to be, a best-effort hint.

## 4. Index & document

### 4.1 Mapping — `tickets`

Stores relevance text + stable filter/sort fields only (no volatile counters):

| Field | Type | Source | Role |
|---|---|---|---|
| `eventTitle` | text (boost ^3) | `event.title` | primary relevance (UI-leading) |
| `title` | text (boost ^2) | `ticket.title` | relevance (fallback/legacy) |
| `venueName` | text (boost ^2) | `event.venueName` | relevance |
| `description` | text | `event.description` | relevance |
| `venueAddress` | text | `event.venueAddress` | relevance |
| `category` | keyword | `ticket.category` † | filter / facet |
| `ticketType` | keyword | `ticket.ticketType` | (post-filter today; indexed for future) |
| `seatingPlanId` | keyword | `ticket.seatingPlanId` | filter (GA vs seated) |
| `price` | scaled_float | `ticket.price` | range filter |
| `startsAt` | date | `event.startsAt` | (future date filter; not used in v1 query) |
| `createdAt` | date | `ticket.createdAt` † | default browse sort tiebreak |

† `category` and `createdAt` are **not in the event payload today** and must be
plumbed through — see [§7](#7-required-upstream-change-write-path). Deliberately
**not** indexed: `quota`, `reserved`, `sold` (hydrated from Mongo).

### 4.2 End-to-end field map (flushes out the plumbing)

| Mongo `Ticket` | `TicketOutboxPayload` | `normalizePendingOutboxEvent` | `relay.go` → `kafka.TicketEventData` | OpenSearch doc |
|---|---|---|---|---|
| `Title` | `Title` ✓ | sets ✓ | maps ✓ | `title` |
| `Event.Title` | `Event.Title` ✓ | sets ✓ | maps ✓ | `eventTitle` |
| `Event.Description/VenueName/VenueAddress` | ✓ | sets ✓ | maps ✓ | resp. fields |
| `Event.StartsAt` | ✓ | sets ✓ | maps ✓ | `startsAt` |
| `Price`,`TicketType`,`SeatingPlanID`,`Version` | ✓ | sets ✓ | maps ✓ | resp. fields |
| **`Category`** | **ADD** | **ADD** | **ADD** | `category` |
| **`CreatedAt`** | **ADD** | **ADD (authoritative)** | **ADD** | `createdAt` |

## 5. Query path — `ticket-service` read side

`TicketsConnection` resolver → `TicketService.ListTickets` keeps the same
`PaginationParams`. When `SEARCH_BACKEND=opensearch`, the read is served by
OpenSearch instead of the Mongo regex.

### 5.1 Relevance & filters
- **Relevance** (`q` present): `multi_match` (`type: best_fields`) over
  `eventTitle^3, title^2, venueName^2, description, venueAddress` with
  `fuzziness: AUTO`, `prefix_length: 1`. Fixes defects #2 and #3.
- **Filters mapped from today's wired filters** (unscored `filter` clause,
  cacheable): `category` (term), `price` (range). `availableOnly` is enforced in
  the refill loop (§5.3), not in OpenSearch.

### 5.2 Sort & versioned cursor (precise contract)
- **Sort:** `q` present → `_score` desc, tiebreak `_id`. No `q` → `createdAt` desc
  (matches today's browse order).
- **Cursor is typed so the two shapes never collide.** The browse/createdAt cursor
  keeps **today's bare format unchanged** — `<createdAtMillis>:<id>` — for
  back-compatibility. The new relevance cursor carries an explicit `os:` prefix:
  `os:<score>:<id>` (the `search_after` tuple). A cursor with no `os:` prefix is
  parsed as the legacy createdAt cursor.
- **Cross-mode safety:** if a cursor's mode doesn't match the path serving the
  request (fallback fired, or the user added/removed `q` mid-session — e.g. an
  `os:` cursor reaching the Mongo path), the cursor is **ignored and pagination
  restarts at page 1** — never silently duplicate or skip. The GraphQL schema does
  not change (still `after: String`).

### 5.3 Refill loop — owned by the resolver (replaces fixed over-fetch)
Post-query filters drop candidates *after* OpenSearch ranks them, and they live at
**two different layers**: `availableOnly` is in `PaginationParams` (service layer,
hydrated from Mongo), but `ticketType` is **only** known at the resolver
(`schema.resolvers.go:181`; not in `PaginationParams` and out of v1 scope to add —
§2). A fixed `limit×2` over-fetch underfills pages when many top hits are dropped.

**Ownership:** the refill loop is owned by the **resolver** (`TicketsConnection`),
because it is the only layer that can see every post-filter. The service exposes a
per-iteration search primitive; the resolver drives the loop.

```
// service primitive (OpenSearch read path):
//   SearchTickets(params, after) -> (results, exhausted)
//   - OpenSearch ranked search (q + category/price filters)
//   - FindByIDs hydrate (live quota/reserved/sold)
//   - applies availableOnly (in params); does NOT apply ticketType
//   - each result is paired with its own `os:<score>:<id>` cursor
//   - `exhausted` = OpenSearch returned fewer than `size`

// resolver-owned refill loop:
page, after = [], inboundCursor
while len(page) < limit and not exhausted and iterations < MAX:
    results, exhausted = service.SearchTickets(params, after)   // size = limit
    for r in results:
        if ticketType is nil or r.ticketType == ticketType:
            page.append(r)
            if len(page) == limit: break
    after = results[-1].cursor            // continue from last *fetched* result
endCursor = page[-1].cursor               // last *included* result (precise boundary)
return page, endCursor
```

`MAX` iterations caps worst-case fan-out; `FindByIDs` already exists and is a
primary-key fetch (cheap). Pairing each result with its own `os:` cursor lets the
resolver set `endCursor` to the last *included* item even when the page boundary
falls mid-iteration — so `ticketType` refills never duplicate or skip. The
authoritative availability gate is still `ReserveQuota` at purchase time.

### 5.4 Backfill / reindex
A one-shot `reindex` command bulk-loads existing tickets from Mongo (reuses
`FindAll`) into the index. Idempotent via `_id = ticketId` + external version. Run
at rollout and after any mapping change.

### 5.5 Graceful fallback
`SEARCH_BACKEND` env: `mongo` (default) | `opensearch`. When `opensearch` is
selected but the cluster is unreachable, log `WARN`, increment a fallback metric
(§8), and serve the current Mongo regex path. Search never hard-fails browse.

## 6. Client change (so relevance reaches users)

Today `page.tsx:147-154` always re-sorts fetched tickets by `startsAt`/`price`,
discarding backend order. Two coupled problems must be fixed together:

**(a) The "explicit sort" signal is destroyed at `page.tsx:38`.**
```ts
const sort = pickString(resolvedParams.sort) === "price" ? "price" : "date";
```
This collapses *no `sort` param* and *explicit `sort=date`* into the same `"date"`,
so the relevance-vs-explicit distinction is gone before the sort runs. The fix is
to read the **raw** param presence separately (keep line 38 only for the dropdown's
selected-state display):
```ts
const explicitSort =
  resolvedParams.sort === "date" || resolvedParams.sort === "price";
```

**(b) UX rule (B — always honor an explicit sort).** Guard the client `.sort()`:
- Apply the client sort when `explicitSort` is true **or** `q` is empty (browse).
- Otherwise (`q` present **and** no explicit sort) **skip `.sort()`** and render in
  server relevance order.

```ts
if (!q || explicitSort) {
  tickets = tickets.sort(/* existing date/price comparator */);
}   // else: preserve backend relevance order
```

No GraphQL/codegen change; this is a guard plus one derived boolean around the
existing client sort.

## 7. Required upstream change (write path)

Plumb `category` and `createdAt` end-to-end (verified four layers):

1. `TicketOutboxPayload` (`mongo_ticket_repository.go`) — add `Category`,
   `CreatedAt`.
2. `normalizePendingOutboxEvent` (`:155`) — set both from the ticket. **This is the
   authoritative point for `createdAt`**: it runs *after* `Create` assigns
   `t.CreatedAt = now` (`:564,577`), whereas the service-layer `buildOutboxPayload`
   (`ticket_service.go:90`) runs *before* and would emit a zero timestamp.
3. `relay.go:117` — map `payload.Category`/`payload.CreatedAt` onto the event.
4. `kafka.TicketEventData` / `EventData` (`producer.go:44-69`) — add the fields to
   the wire format.

Additive only — no proto change, no Kafka topic/partition change.

## 8. Deployment, footprint & observability

- **Single-node** OpenSearch (`discovery.type=single-node`, ~512 MB–1 GB heap,
  security demo config disabled locally).
- **Local:** a `search`-profiled service in `docker-compose.yml` (opt-in).
- **Kubernetes:** an **opt-in** Helm subchart `opensearch`, **disabled** in
  `values-local.yaml` to protect the 7 GB minikube (`--set opensearch.enabled=true`).
- ticket-service env: `OPENSEARCH_URL`, `SEARCH_BACKEND` (default `mongo`),
  `OPENSEARCH_INDEX` (default `tickets`).
- **Readiness:** OpenSearch is a **soft dependency** and an explicit, documented
  exception to the `/healthz/ready` rule in
  [`docs/08-observability.md`](../../08-observability.md). Startup *fails loud* on a
  malformed `OPENSEARCH_URL` when `SEARCH_BACKEND=opensearch`; a *runtime*
  unreachability degrades to Mongo and does **not** fail readiness.
- **Metrics (RED + search-specific):** `search_query_duration_seconds{backend}`,
  `search_fallback_total`, `search_indexer_lag_seconds` (event timestamp → index
  time), `search_refill_iterations`, and `reindex_progress` (docs done / total).

## 9. Considered alternatives

- **Mongo 8.2 `$search` (mongot), self-hosted.** As of MongoDB 8.2 Community
  (2025), `mongot` brings Atlas-parity full-text search (fuzzy, faceting,
  autocomplete) self-hosted and free — which would collapse this CQRS design into
  "index the collection, run `$search`." **Rejected for now** because it is
  public-preview, needs a Mongo 7→8.2 upgrade, runs co-located with `mongod`
  without search-node isolation, and does nothing for logs. **This choice is only
  coherent if the logs-reuse roadmap is real** — if logs are dropped, revisit
  mongot, which is lighter for search alone.
- **PostgreSQL `tsvector`/`pg_trgm`.** Strong built-in FTS, but tickets live in
  Mongo (document model + polyglot goal), Postgres FTS is weak on CJK/Japanese, and
  it would mean migrating the store — which the dedicated-index design avoids.
- **Standalone `search-indexer` deployment.** Cleaner CQRS separation but +1
  deployment up front; deferred as the production extraction step (the indexer is
  already event-driven, so extraction is mechanical).
- **Emit availability events on every reserve/finalize/release.** Keeps the index
  fresh but touches the high-throughput quota gate (larger blast radius); rejected
  in favour of read-time hydration.

## 10. Future (logs reuse)

The same single-node cluster becomes the EFK log store in a later cycle: a Fluent
Bit DaemonSet ships pod logs to OpenSearch (its output plugin also targets
CloudWatch / Amazon OpenSearch Service, so the collection layer stays portable).
The managed-endpoint cutover (Amazon OpenSearch Service + SigV4 IAM) mirrors the
project's Strimzi→MSK pattern and is a connection swap, not a rewrite.

## 11. Testing (encode intent, not just behaviour)

- **Indexer (Testcontainers OpenSearch):** an out-of-order lower-`Version`
  `ticket.updated` after a `created` leaves the newer doc intact (external-version
  guard). A create event indexes a **non-zero** `createdAt` (regression guard for
  the §7 timing bug).
- **Query:** typo `swfit` returns the Swift ticket; an `event.title` hit outranks a
  `description`-only hit; `category`/`price` filters narrow correctly.
- **Refill:** a result set where the top-N hits are sold out still returns a full
  `limit`-sized page of available tickets (proves the refill loop, not a fixed
  multiplier).
- **Availability:** a sold-out ticket is excluded from an `availableOnly` page even
  though the index still lists it (proves hydration gates availability).
- **Cursor contract:** an `os:` cursor presented to the Mongo fallback path
  restarts at page 1 (no dup/skip); `mg:`/`os:` round-trips are stable within a
  mode.
- **Client:** with `q` present and no explicit sort, grid order equals server order
  (relevance preserved); with explicit price sort, client sort still applies.
- **Contract:** GraphQL `TicketsConnection` response shape unchanged vs the Mongo
  path.

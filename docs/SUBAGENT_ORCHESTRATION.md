# Subagent Orchestration — Project Reference

This document records how this project uses the Manager-Worker orchestration pattern. For the full general-purpose strategy, invoke `/orchestrate` in any Claude Code session.

---

## Pattern in Use: Manager-Worker

```text
Main agent (Sonnet/Opus)  ←─ manages, designs, reviews, validates
        │
        ├── Worker (Haiku) ─ code generation, parallel
        ├── Worker (Haiku) ─ testing, parallel
        ├── Worker (Haiku) ─ exploration, parallel
        └── Worker (Haiku) ─ documentation, parallel
```

**Manager responsibilities in this project:**

- Cross-service contract definitions (gRPC, Kafka, REST)
- Schema design decisions
- Architectural choices (denormalization, state machines, validation layers)
- Integration review before each batch merges

**Worker responsibilities in this project:**

- Implementing workstreams defined in `ticketing/workstreams.md`
- Running Go/TypeScript/Maven test suites
- Exploring service patterns before implementation
- Writing migrations, CRUD, handlers following established patterns

---

## Workstream Batching History

Sessions use dependency-aware batching. Workers within a batch run in parallel.

| Batch | Workstreams | Rationale |
| ----- | ----------- | --------- |
| 1 | WS2 | Foundation — schema + gRPC contracts; all others depend |
| 2 | WS3, WS4, WS8 | Parallel — each touches different services; all depend on WS2 |
| 3 | WS9A, 9B, 9D, 9E, 9F, 9G | Parallel — independent small fixes; no cross-workstream deps |
| 4 | WS9C, WS9H | Parallel — independent; WS9C (Java), WS9H (TypeScript) |

---

## Dependency Graph (this project)

```text
WS2 (schema + gRPC modes)
  └─ WS3 (ticket form)
  └─ WS4 (assignment enforcement)
  └─ WS8 (event entity)
        └─ WS9A (card indicators)
        └─ WS9B (availability filter)
        └─ WS9D (venue address)    ─┐
        └─ WS9E (layout size limit) ├─ all independent, batch 3
        └─ WS9F (GA section guard)  ┘
        └─ WS9G (orderTotal dedup)
              └─ WS9C (payment state machine)  ─┐ batch 4
              └─ WS9H (Stripe Elements)         ┘
```

---

## Worker Prompt Template (this project)

Adapt this for each workstream:

```text
Workstream {N} — {Name}

TASK: {One sentence}

PROBLEM: {Why this matters in this system}

SERVICE: {which service; Go/Java/TypeScript}

FILES TO MODIFY:
- `path/to/file` — {method or struct to change}

IMPLEMENTATION:
{Steps; reference existing patterns in the codebase}

DO NOT:
- Modify files outside the list above
- Add features not listed
- Refactor unrelated code

VERIFY:
- Run: `go test ./...` (or appropriate test command)
- Expected: all pass; no regressions
```

---

## Status Reference

Current implementation status is in [ticketing/status.md](ticketing/status.md).
Full workstream specifications are in [ticketing/workstreams.md](ticketing/workstreams.md).

---

## Key Architectural Decisions (Manager Log)

These decisions were made by the manager and communicated to workers as constraints:

| Decision | Why |
| -------- | --- |
| Event metadata denormalized on Ticket | Avoid cross-service joins on every list read; eventual consistency acceptable |
| TicketType set on plan attach, not on create | Type cannot be known without a plan; lazy is correct |
| Assignment mode enforced in both UI and backend | Defense-in-depth; UI is not trusted alone |
| Stripe.js tokenization client-side | Card details never reach our backend; PCI handled by Stripe |
| AWAITING_PAYMENT via Kafka event, not direct call | Decoupled; payment-service doesn't need order-service dependency |
| Layout JSON capped at 1 MB | Prevent organizer-side storage exhaustion via plan editor |

---

## Invoking the Strategy

To activate manager mode in any session:

```text
/orchestrate
```

The skill reads the full general strategy. Use this doc for project-specific context (workstream specs, dependency graph, architectural decisions).

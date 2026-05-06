# Agent Session Load Cost — Post-Migration Reference

> Human-only note. Documents the context-window footprint of the instruction surface
> after the May 2026 agentic-instruction-surface audit and migration.

## How Claude Code loads instructions

1. **Root `CLAUDE.md`** — always auto-loaded at session start regardless of CWD.
2. **Memory index (`memory/MEMORY.md`)** — auto-injected by the memory system.
3. **Nested `services/<svc>/CLAUDE.md`** — auto-loaded when CWD falls under that service;
   each contains only `@AGENTS.md`, which pulls in the service-specific `AGENTS.md`.
4. **Everything else** (`AGENTS.md`, `docs/0X-*.md`, etc.) — lazy; only enters context
   when the agent deliberately reads or follows a pointer.

## Session-load footprint (after migration)

### Root session (`/microservices`)

| File | Bytes | ~Tokens |
|---|---|---|
| `CLAUDE.md` | 1,957 | ~490 |
| `memory/MEMORY.md` | 335 | ~85 |
| **Total** | **2,292** | **~575** |

### Service session (e.g. `services/user-service/`)

| File | Bytes | ~Tokens |
|---|---|---|
| `CLAUDE.md` (root) | 1,957 | ~490 |
| `memory/MEMORY.md` | 335 | ~85 |
| `services/user-service/CLAUDE.md` | 11 | ~3 |
| `services/user-service/AGENTS.md` | 3,002 | ~750 |
| **Total** | **5,305** | **~1,328** |

## Before → after comparison

| Metric | Before | After |
|---|---|---|
| Root CLAUDE.md | ~2,472 bytes / ~620 tokens | 1,957 / ~490 |
| Inline hard-stops (10 bullets in CLAUDE.md) | ~300 tokens | pointer only (~10 tokens) |
| Inline JWT-consumer pattern (3 services, repeated) | ~90 tokens × 3 | pointer to `docs/06-security.md#consuming-service-pattern` |
| Per-service AGENTS.md boilerplate preamble | ~200 tokens overhead each | ~5 tokens each |
| `.agents/` shadcn skill (auto-loaded) | ~800 tokens | deleted |
| **Startup (root)** | **~900–1,100 tokens** | **~575 tokens** |
| **Startup (service)** | **~1,600–2,000 tokens** | **~1,328 tokens** |

## What stays out of context until needed

- `AGENTS.md` (root TOC) — 3,432 bytes / ~860 tokens
- Each `docs/0X-*.md` standard — 2k–8k bytes / 500–2k tokens
- `docs/15-agent-hard-stops.md` — loaded only when agent hits a hard-stop scenario
- Any other service's `AGENTS.md` — loaded only when agent touches that service

## Token estimation convention

~4 characters per token for English markdown prose.

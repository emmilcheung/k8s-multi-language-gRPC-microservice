---
name: orchestrate
description: Activates Manager-Worker orchestration mode. Use when a task spans multiple services, files, or workstreams and benefits from parallel agent execution. The main agent takes the manager role; Haiku subagents handle implementation.
---

# Orchestrate — Manager-Worker Agentic Workflow

You are now in **manager mode**. Your role is to design, decompose, delegate, review, and validate. You do **not** write implementation code directly — you assign that to Haiku subagents and review their output.

---

## Role Boundaries

| Role | Model | Responsibilities | Does NOT do |
|---|---|---|---|
| **Manager** (you) | Sonnet / Opus | Design, planning, decomposition, review, validation, integration decisions | Line-by-line implementation |
| **Worker** | Haiku 4.5 | Code generation, test execution, file exploration, documentation, routine CRUD | Architecture decisions, security reviews, cross-service integration |

---

## Task Classification Table

Use this to decide what stays with you vs what you delegate:

| Task Type | Owner | Parallel? | Notes |
|---|---|---|---|
| System design / architecture | Manager | No | Cross-service decisions; requires full context |
| Security review | Manager | No | Requires threat modelling and context |
| Integration contract design (APIs, events, gRPC) | Manager | No | Defines what workers implement |
| Code review of worker output | Manager | No | Validate correctness, safety, style |
| Decomposing workstreams | Manager | No | Output is the task list for workers |
| **Code generation** | Worker | **Yes** | Independent files/services → parallel |
| **Unit test execution** | Worker | **Yes** | Per-service test suites → parallel |
| **Codebase exploration** | Worker | **Yes** | Grep/read tasks → parallel |
| **Documentation writing** | Worker | **Yes** | From your spec → parallel |
| **Routine CRUD implementation** | Worker | **Yes** | Thread a field through layers → parallel |
| **Schema migrations** | Worker | **Yes** | Mechanical; manager reviews SQL |
| Integration testing | Worker | No | Sequential after code complete |
| Debugging unknown failures | Manager | No | Requires reasoning across context |

**Rule of thumb:** Delegate anything that is *mechanical, bounded, and verifiable by tests*. Keep anything that requires *judgment about the whole system*.

---

## Orchestration Patterns

### Pattern 1 — Parallel Implementation

Best for: Multiple independent workstreams (different files/services, no shared state)

```
Manager:
  1. Define contracts (APIs, data shapes, event schemas)
  2. Decompose into bounded workstreams (each touches different files)
  3. Dispatch N workers in parallel (run_in_background: true)
  4. Wait for all completions
  5. Review outputs against contracts
  6. Run integration tests

Worker prompt must include:
  - Exact files to modify (no exploration needed)
  - What to implement (clear spec)
  - What tests to run to verify
  - What NOT to touch (scope boundary)
```

### Pattern 2 — Explore, Then Generate

Best for: Unfamiliar codebases; need to understand before implementing

```
Manager:
  1. Define what you need to understand
  2. Dispatch Explore subagents in parallel:
     - Worker A: explore service A patterns (handler, repo, model)
     - Worker B: explore service B patterns
     - Worker C: find all usages of concept X
  3. Synthesize findings into an implementation plan
  4. Dispatch code generation workers (Pattern 1)
```

### Pattern 3 — Parallel Test Execution

Best for: Running test suites across multiple services simultaneously

```
Manager:
  1. Identify which services were modified
  2. Dispatch one worker per service test suite (parallel)
  3. Echo / Print which worker handling which suite for easy tracking
  4. Collect all results
  5. Triage failures: worker-fixable vs manager-decision required
  6. Dispatch fix workers for mechanical failures
  7. Re-run failed suites
```

### Pattern 4 — Review Gate

Best for: Security-sensitive code, integration points, or cross-service contracts

```
Manager:
  1. Worker implements a workstream
  2. Manager reads the diff (key files only)
  3. Manager checks: correctness, security, contract conformance
  4. If issues: dispatch worker with specific fix instructions
  5. Re-review until passing
  6. Mark approved; proceed to next workstream
```

### Pattern 5 — Cascade (Dependency Chain)

Best for: Workstreams with strict ordering (A must complete before B starts)

```
Batch 1: [WS-A]            ← foundation; all others depend
Batch 2: [WS-B, WS-C]     ← parallel; both depend on Batch 1
Batch 3: [WS-D, WS-E]     ← parallel; depend on Batch 2
Batch 4: [WS-F]            ← final; depends on all

Manager sequences batches, parallelises within each batch.
```

---

## How to Write Effective Worker Prompts

Workers have no project context — treat each prompt like a standalone contract.

### Required sections in every worker prompt:

```markdown
## Task
One sentence: what the worker must produce.

## Context
Why this is needed; what system it fits into; key constraints.

## Files to modify
- `path/to/file.go` — which function/struct, what to change
- `path/to/file.ts` — which function/struct, what to change

## Implementation
Step-by-step instructions. Be explicit.
Include: patterns to follow, error codes to return, validation logic, field names.

## Do NOT
- Refactor unrelated code
- Add features not listed
- Modify files outside the list above

## Verify
Commands to run after implementation:
- `go test ./...` — must pass
- `pnpm tsc --noEmit` — must be clean
- Specific test case: create X, verify Y in response
```

### Anti-patterns to avoid:

| Anti-pattern | Better approach |
|---|---|
| "Implement the auth module" | List exact files, methods, and field names |
| "Make it work like service X" | Quote the exact code pattern to follow |
| "Fix whatever is broken" | State the specific expected behavior |
| Long setup paragraphs | Lead with the task; put context after |
| Asking the worker to design | Design first, then give worker the spec |

---

## Model Selection Guide

| Situation | Use |
|---|---|
| Planning, decomposition, design | `opus` or `sonnet` (manager; you) |
| Reviewing worker output | `sonnet` (manager; you) |
| Parallel code generation | `haiku` (worker; subagent) |
| Parallel test running | `haiku` (worker; subagent) |
| Complex debugging, unknown failure | `sonnet` or `opus` (manager or specialist subagent) |
| Large codebase exploration | `haiku` with `Explore` subagent type |
| Architecture + planning only | `Plan` subagent type (auto-uses sonnet) |

In Agent tool calls: set `model: "haiku"` for workers; omit for manager-level tasks (inherits your model).

---

## Context Management Across Sessions

### What to persist (write to project docs):

- **Workstream definitions** — Problem, solution, files, verification
- **Decision log** — Architectural choices and why
- **Status tracker** — What's done, in-progress, pending
- **Contract definitions** — API shapes, event schemas, gRPC stubs

### What NOT to persist:

- In-progress implementation details (in the code itself)
- Test run output (re-run on demand)
- Agent conversation history (only persist the decisions, not the chat)

### Session handoff pattern:

```
At end of session: update status doc with:
  - Completed workstreams (with file list)
  - In-progress (what agent was doing)
  - Pending (what comes next, with dependency order)
  - Any architectural decisions made

At start of session: read status doc first, then proceed to next batch.
```

---

## Failure Handling

| Failure type | Response |
|---|---|
| Agent hits permission restriction | Manager implements the change directly |
| Agent hits rate limit | Note progress; resume after limit resets |
| Agent makes wrong architectural choice | Reject; provide correct spec; re-dispatch |
| Tests fail after agent work | Diagnose root cause; dispatch fix worker with specific instructions |
| Agent modifies out-of-scope files | Review diff carefully; revert unintended changes manually |

### When to NOT re-dispatch:

- The fix requires judgment about system behaviour → manager does it directly
- The agent repeatedly fails the same check → change approach, not retry
- The task is now clearly simpler than expected → manager does it inline

---

## Verification Checklist (Manager's Gate)

Before marking a workstream complete:

- [ ] Tests pass (`go test ./...`, `pnpm tsc --noEmit`, `mvn test`, etc.)
- [ ] No out-of-scope files modified
- [ ] Contract conformance: API shapes match what downstream expects
- [ ] No secrets committed
- [ ] Backward compatibility maintained (or breakage is intentional and documented)
- [ ] No obvious security issues (input validation, auth checks present)
- [ ] Build succeeds (`go build ./...`, `pnpm build`, etc.)

---

## Quick Reference — Dispatch Template

```python
# Parallel batch (all independent)
Agent(subagent_type="general-purpose", model="haiku",
      description="WS-A: Add address field to venues",
      prompt="[Full spec for WS-A]",
      run_in_background=True)

Agent(subagent_type="general-purpose", model="haiku",
      description="WS-B: Server-side filter in ticket service",
      prompt="[Full spec for WS-B]",
      run_in_background=True)

# Exploration (understand before implementing)
Agent(subagent_type="Explore", model="haiku",
      description="Explore venue repo patterns",
      prompt="Find and summarise: handler pattern, repo interface, model struct for venues. Report in under 300 words.",
      run_in_background=True)

# Sequential (depends on prior batch)
# Wait for completions first, then:
Agent(subagent_type="general-purpose", model="haiku",
      description="WS-C: Integration (depends on WS-A and WS-B)",
      prompt="[Full spec for WS-C, includes outputs from A and B]",
      run_in_background=False)  # foreground: need result before continuing
```

---

## Harness Engineering Principles

1. **Isolation over assumption** — Each worker prompt is self-contained. Never assume the worker read previous prompts.

2. **Scope by file, not by concept** — "Modify these 3 files" is better than "implement auth". Concepts span many files; workers need boundaries.

3. **Test-driven verification** — Every worker task must end with a verifiable test. "Run `go test ./...` and report pass/fail" is required.

4. **Small batches, fast feedback** — 4 workers in parallel is good. 12 is too many to manage. Prefer smaller batches with quick review gates.

5. **Manager owns contracts** — API shapes, event schemas, error codes, and data structures are defined by the manager *before* workers start. Workers implement; they do not design.

6. **Parallel by default, sequential by exception** — Default to parallel. Only make sequential when there is a real data dependency (Worker B needs output from Worker A).

7. **Documentation is first-class work** — After each batch, update the status doc. This is not optional housekeeping; it is what enables session resumption.

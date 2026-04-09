---
name: end-to-end-check
description: "Review end-to-end coverage after each primary agent loop, prioritize client E2E tests and docker-compose-backed infrastructure, add missing tests for new workflows, and fix failures before completion."
---

# End-to-End Check — Coverage and Validation Guard

This skill is used when a code change may affect application workflows or introduce new end-to-end behavior. It should run after the agent has completed a loop with no remaining blockers and before the change is considered done.

## When to use

- After implementing code changes that touch business logic, API flows, client behavior, or cross-service interactions.
- When the client E2E test suite under `services/client/test/**/*` needs to be validated or updated.
- When verifying that root-level `docker-compose.yml` infrastructure is available for end-to-end execution.

## Goals

1. Confirm that the current agent loop is complete and there are no unresolved blockers.
2. Identify any new end-to-end workflows introduced by the code changes.
3. Compare those workflows against existing coverage in `services/client/tests/**/*`.
4. Add or update client E2E tests if new workflow behavior is not already covered.
5. Run the client E2E suite against the backend and infra deployed from root `docker-compose.yml`.
6. If any tests fail, treat previously passing tests as ground truth and inspect the code change for violations.

## Process

1. Inspect the diff and changed files to understand what new workflow or logic was introduced.
2. Identify the relevant client test coverage in `services/client/test/**/*` and the mapping from changed behavior to existing tests.
3. If coverage is missing, add a focused, resilient E2E test to `services/client/test/**/*` that exercises the changed workflow.
4. Before running tests, ensure Docker is available:
   - Use `docker info >/dev/null` or `docker version` to verify the daemon is running.
   - If Docker is not running on macOS, open it with `open -a Docker` and wait until it is ready.
5. Ensure the required backend and infrastructure are running from the repo root `docker-compose.yml`.
   - Prefer `docker compose -f docker-compose.yml up -d` from repository root if services are not already started.
6. Run the client end-to-end tests using the project script:
   - `cd services/client && pnpm test:e2e`
7. If tests fail, do not mark the loop complete. Investigate the failure, fix the code or tests, and rerun until the suite passes.

## Priority rules

- Test coverage and stability always outrank code changes.
- If an existing test previously declared passing now fails, assume the existing test describes correct behavior and investigate the code change.
- Do not skip E2E validation because the change is small; new workflow coverage is required when behavior changes.

## Notes

- This skill is not a substitute for a full CI run, but it should catch missing E2E coverage and docker-compose dependency issues locally.
- The client E2E test runner is `pnpm test:e2e` in `services/client/package.json`.
- This skill is intended to be used alongside `.claude/skills/lint-check/SKILL.md` as the post-harness validation pair.
- If new end-to-end logic is added, update tests before the review of this skill is considered complete.

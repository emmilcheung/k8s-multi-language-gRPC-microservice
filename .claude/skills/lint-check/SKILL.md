---
name: lint-check
description: "Run service-specific lint and static verification commands across the monorepo, aligned with CI expectations and post-harness validation."
---

# Lint Check — CI-aligned Static Validation

This skill is used to validate code hygiene for changed services after an agent loop and before the change is considered complete.

## When to use

- After code changes in any service or shared library that may affect style, type safety, or static verification.
- When the change needs to be synced with CI lint requirements.
- When there is a need to catch violations early, before merge or release.

## Goals

1. Run the same lint/static checks used by CI for the affected services.
2. Confirm the working tree is clean of lint and type-check failures.
3. If lint errors are introduced, fix them before concluding the agent loop.
4. Treat CI lint as authoritative for code quality and merge readiness.

## Process

1. Inspect the changed files and determine which services are affected.
2. Run service-specific verification commands:
   - `cd services/auth-service && pnpm lint && pnpm tsc --noEmit`
   - `cd services/payment-service && pnpm lint && pnpm tsc --noEmit`
   - `cd services/user-service && pnpm lint && pnpm tsc --noEmit`
   - `cd services/client && pnpm lint && pnpm tsc --noEmit`
   - `cd services/ticket-service && go vet ./...`
   - `cd services/expiration-service && go vet ./...`
   - `cd services/venue-service && go vet ./...`
   - `cd services/order-service && mvn -q checkstyle:check`
3. If the change touches additional services, run the corresponding service lint commands from the CI workflow.
4. If any command fails, do not mark the loop complete. Investigate the failure, fix the code, and rerun.

## CI sync

- This skill is aligned with the repository CI definitions in `.github/workflows/ci.yml`.
- Use the same commands and service boundaries as the CI lint jobs.
- If new services are added later, update this skill and the CI workflow together.

## Notes

- For TypeScript services, `pnpm lint` is the style gate, `pnpm tsc --noEmit` is the type-check gate.
- For Go services, `go vet ./...` is the lint-style static verification gate.
- For Java, `mvn -q checkstyle:check` is the style gate.
- The skill is intentionally service-specific so it can scale with the repository’s heterogeneous stack.

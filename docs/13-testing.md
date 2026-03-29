# Testing Standards

## Test Pyramid

- **Unit tests** (70%): pure functions, business logic, domain models. No I/O. Fast.
- **Integration tests** (20%): test one service with its real database and message broker running in Docker. No mocks except other services.
- **Contract tests** (5%): validate that gRPC/REST contracts between services match what producers emit and consumers expect (Pact or buf-based).
- **E2E tests** (5%): full system tests via Kong against a staging environment. Cover only critical user journeys.

## Rules

- Every public function/method must have a unit test.
- Integration tests must clean up their own data — use transactions rolled back after each test, or wipe test-namespaced data.
- Do not mock databases or message brokers in integration tests — use real instances (Docker Compose, TestContainers).
- Tests must be deterministic — no `sleep()`, no clock-dependent assertions without injecting a fake clock.
- CI test runs must complete in under 10 minutes — split into parallelised jobs if they exceed this.
- Test coverage is a guide, not a goal — prioritise testing critical paths and edge cases over chasing a coverage number.

## Test Naming

- Unit: `<function> should <expected behaviour> when <condition>`
- Integration: `<endpoint or flow> returns <expected outcome> given <setup>`

# CI/CD

## Pipeline Stages

Every service follows this pipeline:

```
lint → test (unit) → test (integration) → build image → scan image → push image → deploy (dev) → smoke test → deploy (staging) → e2e test → deploy (prod, gated)
```

## Rules

- **No merge to main without passing CI** — branch protection enforced.
- **Image tag = Git SHA** — never use `latest` in any environment.
- Integration tests run against real dependencies spun up in Docker Compose (local) or ephemeral namespaces (CI).
- Production deploys require a manual approval gate.
- Rollback is automated: if the post-deploy smoke test fails, the pipeline rolls back to the previous image tag automatically.

## Proto Changes

- Regenerate stubs (`make proto`) in CI whenever a `.proto` file changes.
- Run a compatibility check (buf breaking) — fail CI if a breaking change is introduced without a version bump.

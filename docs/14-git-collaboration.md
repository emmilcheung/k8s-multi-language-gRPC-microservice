# Git & Collaboration

## Branching Strategy

- **Trunk-based development**: short-lived feature branches off `main`, merged via PR within 1–2 days.
- Branch names: `feat/<short-description>`, `fix/<short-description>`, `chore/<short-description>`.
- No long-lived branches (no `develop`, no `release` branches) — use feature flags for incomplete work.

## Commit Messages (Conventional Commits)

```
<type>(<scope>): <short description>

[optional body — why, not what]

[optional footer: BREAKING CHANGE, closes #issue]
```

Types: `feat`, `fix`, `perf`, `refactor`, `test`, `chore`, `ci`, `docs`, `build`.
Scope: service or infra area e.g. `feat(order-service)`, `chore(infra/terraform)`.

## Pull Request Rules

- PRs must reference an issue or ticket.
- Description must include: what changed, why, how to test, and any migration steps.
- Require at least 1 peer review before merge.
- Squash merge to keep `main` history linear and clean.
- No PR merges if CI is failing or if there are unresolved review threads.

## What Never Goes in Git

- Secrets, API keys, passwords, tokens.
- `.env` files (use `.env.example` with placeholder values).
- Compiled artefacts (`dist/`, `build/`, `target/`, `__pycache__/`).
- Container images, large binary assets.
- Terraform state files or `.terraform/` directories.

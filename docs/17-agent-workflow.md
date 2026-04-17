# Agent Workflow & Post-Harness Validation

## Post-harness validation loop

After every implementation loop with no unresolved blockers, before declaring the loop complete, run:

1. **[`lint-check`](../.claude/skills/lint-check/SKILL.md)** — service-specific lint and static verification, aligned with CI.
2. **[`end-to-end-check`](../.claude/skills/end-to-end-check/SKILL.md)** — E2E coverage for new or changed workflows; verify `docker-compose.yml` infra is runnable.

These are the final gate. Do not declare "done" without both passing.

## Orchestration

Multi-workstream work uses a manager/worker pattern:

- Invoke `/orchestrate` to enter manager mode — see [`../.claude/skills/orchestrate/SKILL.md`](../.claude/skills/orchestrate/SKILL.md).
- Project-specific decomposition, dependency graph, decision log: [`SUBAGENT_ORCHESTRATION.md`](SUBAGENT_ORCHESTRATION.md).

## Authoring principle

Keep [`../AGENTS.md`](../AGENTS.md) as a TOC only. Keep [`../CLAUDE.md`](../CLAUDE.md) as the agent contract only. Full procedural detail belongs in `docs/` files like this one.

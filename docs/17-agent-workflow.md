# Agent Workflow & Post-Harness Validation

This document captures the repository's agent workflow guidance, the final validation guard after an implementation loop, and the skills used to enforce those checks.

## Purpose

`AGENTS.md` is intentionally a high-level index and quick reference. The full workflow guidance belongs in a dedicated docs page so the agent-facing TOC remains concise and manageable.

## Agent workflow reference

The repository uses a manager/worker pattern with explicit workflow and verification gates. Key references:

- `.claude/skills/orchestrate/SKILL.md` — manager/worker orchestration guidance for parallel and sequential tasks.
- `.claude/skills/end-to-end-check/SKILL.md` — post-loop E2E workflow validation.
- `.claude/skills/lint-check/SKILL.md` — post-loop lint and static verification validation.

## Post-harness validation loop

After each main implementation loop with no unresolved blockers, run both post-harness validation skills before declaring the loop complete:

- `.claude/skills/end-to-end-check/SKILL.md`
  - Validate new or changed workflows against client E2E coverage.
  - Ensure root `docker-compose.yml` infrastructure is available.
- `.claude/skills/lint-check/SKILL.md`
  - Run service-specific lint and static verification commands aligned with CI.

These two skills are the final validation gate for code quality and behavior after the main implementation cycle.

## How to use this doc

- Use `AGENTS.md` for the quick overview and table of contents.
- Use `docs/17-agent-workflow.md` for workflow decisions, process reminders, and the post-harness validation contract.
- Keep the `AGENTS.md` file compact; avoid moving full procedural detail back into it.

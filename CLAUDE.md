@AGENTS.md
## Rule
1. When update content into `CLAUDE.md`, alternatively update the `AGENTS.md`

## Agentic Orchestration

This project uses a Manager-Worker pattern for multi-workstream features. The skill is checked into the repo so all contributors share the same strategy.

- **Invoke:** `/orchestrate` — activates manager mode with the full general strategy
- **Skill file:** [`.claude/skills/orchestrate/SKILL.md`](.claude/skills/orchestrate/SKILL.md)
- **Project reference:** [`docs/SUBAGENT_ORCHESTRATION.md`](docs/SUBAGENT_ORCHESTRATION.md) — project-specific patterns, dependency graph, decision log

### Quick Start

1. Run `/orchestrate` to enter manager mode
2. Read [`docs/SUBAGENT_ORCHESTRATION.md`](docs/SUBAGENT_ORCHESTRATION.md) for project context
3. Check the relevant feature status doc (e.g. [`docs/ticketing/status.md`](docs/ticketing/status.md))
4. Decompose, dispatch workers in parallel, review, repeat

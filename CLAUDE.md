# Approach

- Think before acting. Read existing files before writing code.
- Be concise in output but thorough in reasoning.
- Prefer editing over rewriting whole files.
- Do not re-read files you have already read unless the file may have changed.
- Test your code before declaring done.
- No sycophantic openers or closing fluff.
- Keep solutions simple and direct.
- User instructions always override this file.

---

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

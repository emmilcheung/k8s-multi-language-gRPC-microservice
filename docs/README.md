# docs/

Project documentation for contributors and coordinators.

## Structure

```text
docs/
├── README.md                    ← this file
├── SUBAGENT_ORCHESTRATION.md    ← project-specific orchestration reference
└── ticketing/
    ├── workstreams.md           ← spec for all ticketing feature workstreams
    └── status.md                ← implementation progress tracker
```

The general-purpose orchestration strategy lives in `.claude/skills/orchestrate/SKILL.md` and is invokable as `/orchestrate` in any Claude Code session.

## Quick Links

- [Orchestration reference](SUBAGENT_ORCHESTRATION.md) — how this project coordinates parallel agents
- [Ticketing workstreams](ticketing/workstreams.md) — problem, solution, files, and verification for each feature
- [Ticketing status](ticketing/status.md) — what is done, in-progress, and pending

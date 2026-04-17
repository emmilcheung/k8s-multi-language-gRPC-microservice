# docs/

Project documentation. Organized for on-demand loading by agents and humans.

## Categories

- **Standards** — `01-*.md` through `14-*.md`: engineering conventions (API, data, security, observability, etc.). See [`../AGENTS.md`](../AGENTS.md) for the full TOC.
- **Process** — agent-facing procedures:
  - [`15-agent-hard-stops.md`](15-agent-hard-stops.md) — operations requiring explicit user confirmation
  - [`17-agent-workflow.md`](17-agent-workflow.md) — post-harness validation loop
  - [`SUBAGENT_ORCHESTRATION.md`](SUBAGENT_ORCHESTRATION.md) — project-specific manager/worker patterns
- **Log** — rolling state:
  - [`16-session-progress-log.md`](16-session-progress-log.md) — chronological session record
  - [`ticketing/status.md`](ticketing/status.md) + [`ticketing/workstreams.md`](ticketing/workstreams.md)
- **Plan** — active work-in-flight designs under [`plan/`](plan/)
- **API contract** — [`openapi.yaml`](openapi.yaml)

## Entry points

- Agent contract: [`../CLAUDE.md`](../CLAUDE.md)
- Doc index: [`../AGENTS.md`](../AGENTS.md)
- Human onboarding (ports, local dev): [`../README.md`](../README.md)

## Contributing

1. Find the right category above.
2. Edit the existing file rather than creating a new one.
3. If adding a new standard, add a TOC row in `../AGENTS.md`.
4. For significant decisions, add an entry to `16-session-progress-log.md`.

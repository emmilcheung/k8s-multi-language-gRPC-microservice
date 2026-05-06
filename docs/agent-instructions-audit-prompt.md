# Agentic Instruction Surface Audit — Reusable Prompt

> Reusable audit prompt for evaluating the agent-instruction surface area of this monorepo. Drop the **Prompt** section below into a fresh agent session whenever the instruction surface drifts again.

## When to run this

- After major refactors that touch `CLAUDE.md`, `AGENTS.md`, `docs/0X-*.md`, or per-service `AGENTS.md`.
- When adopting a new harness (Codex, Copilot CLI, Gemini, OpenCode, etc.) and you need to reconcile its config surface with the existing layout.
- When the agent-loaded context at session start feels heavy and you want a token-cost review.
- Roughly once per quarter as a hygiene pass.

## Constraints baked into the prompt

- Read-only audit; no file edits.
- Specific path + line citations required, not vibes.
- Prefers deletion over addition.
- Stops and asks the user before assuming a service is abandoned, before assuming a fork candidate, or if Tier 0 cannot fit under 2 K tokens without dropping something load-bearing.

---

## Prompt

You are a principal engineer auditing the agentic instruction surface of this monorepo. The repo started small and grew into a polyglot microservices platform (services: apollo-router, auth-service, client, expiration-service, kong-gateway, order-service, payment-service, ticket-service, user-service, venue-service). Multiple agent harnesses are now in play (Claude Code, Copilot CLI, Gemini, Codex, OpenCode) plus the superpowers skill ecosystem. Instruction files have drifted.

Do not edit any files in this pass. Produce an audit + migration plan only. Edits happen in a follow-up session against your plan.

### Goals

- Cut context-window cost at session start without losing correctness.
- Harness-portable: prefer patterns that work across Claude Code, Copilot, Gemini, Codex, OpenCode (superpowers-style skills + AGENTS.md).
- Lazy/conditional loading: service-specific or language-specific guidance should only enter context when the agent touches that service.
- Team-splittable: if any service becomes its own team's repo tomorrow, that service's `AGENTS.md` should stand alone.
- No duplication between `CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/0X-*.md`, and per-service `AGENTS.md`.

### Inputs to read

- Root: `CLAUDE.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`
- Standards: `docs/01-guiding-principles.md` through `docs/17-agent-workflow.md`, plus `docs/SUBAGENT_ORCHESTRATION.md`
- Per-service: every `services/*/AGENTS.md` and `services/*/CLAUDE.md`
- Harness config: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/skills/`, `.claude/mcp.json`, `.opencode/`, `.agents/`, `.superpowers/`, `.github/copilot-instructions.md` (if present), `GEMINI.md` (if present)
- Sample what the agent actually loads at startup (token-cost ballpark per file is enough — no need for exact tokenizer).

### Deliverables (in chat, in this order)

**1. Inventory table**

`| File | Bytes | Role (contract / index / onboarding / standards / service / skill / hook) | Auto-loaded by harness? | Audience (agent / human / both) |`

**2. Redundancy & drift report**

- Concrete duplications across files (quote line ranges).
- Stale references (links to moved/renamed things).
- Rules that contradict between root and a service file.

**3. Layering proposal**

Recommend a target layout using these tiers, mapped to what each harness auto-loads vs. lazy-loads:

- **Tier 0** — Always-on root contract (target: <2k tokens). Hard stops, conventional commits, "where to look" pointers, skill priority.
- **Tier 1** — On-demand standards (`docs/0X-*.md`): loaded only when a relevant skill or task triggers it.
- **Tier 2** — Service-local (`services/<svc>/AGENTS.md` + optional `CLAUDE.md`): loaded when CWD or touched files fall under that service. Self-sufficient enough that splitting the service to its own repo is a copy-paste.
- **Tier 3** — Skills (superpowers-style): triggered by intent/keywords, not auto-loaded.
- **Tier 4** — Human-only docs (`README.md`, diagrams, interview notes): excluded from agent context.

For each existing file, recommend: keep / merge / split / move-to-skill / delete, with one-line reasoning.

**4. Lazy-load mechanism**

Concretely, how does Tier 1/2 enter context only when needed in each harness?

- Claude Code: SessionStart hooks vs. Skill tool vs. file-glob `additionalDirectories` — pick one and justify.
- Copilot / Gemini / Codex / OpenCode: same question.
- Show the smallest possible Tier 0 root file that points to everything else without inlining.

**5. Memory & harness hygiene**

- Are auto-memory entries pulling weight, or duplicating `CLAUDE.md`? Flag any to retire.
- Are `.claude/settings*.json` permissions/hooks aligned with the proposed flow? Flag deltas.
- Identify any superpowers skills the project should adopt or stop relying on.

**6. Migration plan**

A numbered, mergeable sequence of PR-sized steps (each independently shippable). For each step: files touched, risk, rollback. Order steps so context-window wins land first.

### Constraints

- No file edits. Output only.
- Be specific: cite paths and line ranges, not vibes.
- If a recommendation depends on harness behavior you're unsure about, say "verify" and propose the check, don't guess.
- Prefer deletion over addition. Every kept rule must justify its token cost.
- If two reasonable target layouts exist, present both with tradeoffs — don't hide the choice.

### Stop conditions

Stop and ask the user before proceeding if:

- Any service appears abandoned or out-of-scope (don't assume).
- A "team split" candidate isn't obvious — ask which service is most likely to fork first.
- Tier 0 can't fit under 2k tokens without dropping something the user considers load-bearing.

# Plan

Goal: build a minimal factory by hand, then let the factory build the rest of itself and grow it into an autonomous system. Design: `docs/design.md`.

## Principles carried into every phase

- Every infra layer is an interface with local and cloud implementations. Local first.
- Day one is fully gated: `spec_gate_min_tier = 1`, `auto_merge_max_tier = 0`. Humans decide; decisions are recorded with reasons.
- Dials loosen only with Step 5 evidence and a human decision. Tightening is automatic.
- The factory never merges its own changes to its own gates, prompts, permissions, or tools without a human.

## Phase 0 — Decisions before code

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D1 | Language / stack | **TypeScript (Node)** | decided |
| D2 | Agent harness | `AgentRunner` interface. Local impl = `claude -p` on the subscription login (no API key; unset `ANTHROPIC_API_KEY`, don't use `--bare`; `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` for unattended runs). Company/cloud impl = API key or gateway (Bedrock / Vertex / ML gateway): Anthropic doesn't allow claude.ai login in products offered to others | open |
| D3 | Store | `FactoryStore` interface; first impl = SQLite file | decided |
| D4 | First intake source | GitHub issues on this repo (the factory's own backlog). Slack later | decided |
| D5 | Human gate surface | GitHub PR review + issue comments first; the form UI later | decided |

## Phase 1 — Minimal viable factory (built by hand)

The smallest loop that can take one GitHub issue to one reviewed PR. Everything gated.

1. **Store:** `FactoryStore` + work-item schema + `state_changes` (IDs only). SQLite.
2. **Intake:** GitHub issue labeled `factory` → work item `NEW`.
3. **Triage agent:** fills problem, done criteria, scope (`allowed_paths`), tier → posts the spec as an issue comment → `READY`, `blocked_on: human` until a human approves.
4. **Manager:** code, no LLM. Claims `READY` items with a lease; one worker is enough at first.
5. **Implementer:** `NoOpSandbox` (a git worktree on the host) + `AgentRunner`. TDD tests first, commits with a handoff row per commit, opens a PR.
6. **Reviewer:** blind pass (work item + diff), writes acceptance tests, tier recheck, verdict as a PR review comment. Bug → back to the implementer, `loop_count + 1`.
7. **Human merge:** always, at every tier. Webhook or poll records merge / revert into `state_changes`.

Interfaces stubbed with a single local impl: `FactoryStore`, `Sandbox` (`NoOpSandbox`), `AgentRunner`, `ModelProvider`, `AuthProvider` (no-auth), `SecretStore`, `CapabilitySearch` (list everything).

**Exit criterion:** the factory takes a real issue from this repo's backlog to a PR that a human merges, with the full trail in `state_changes`.

## Phase 2 — The factory builds itself (dogfooding)

From here, new features are GitHub issues on this repo, worked by the factory. Humans confirm specs and merge. `BACKLOG.md` seeds the issues.

Order (each one makes the next safer or cheaper):
1. Hard gates: CI scope gate (`allowed_paths`), diff-size limit, protected paths (the floor list).
2. Human form (verdict + severity + reason) replacing free-form comments.
3. Measurement: weighted feedback rate per tier, revert / fix-forward tracking (`fixes_pr`), budgets, `restart_count` + dead-letter.
4. Golden PRs from rejected / reverted / held-up PRs; catch + false-alarm rate per agent.
5. Parallel workers: per-worker ports and test DB, merge-conflict handling.
6. Progressive disclosure + `CapabilitySearch` (BM25 first, vector later).

## Phase 3 — Toward autonomy

- Turn dials with evidence: `spec_gate_min_tier`, then `auto_merge_max_tier` 0 → 1 → 2. Automatic demotion + sampled audits.
- Self-improvement loop: improver agent clusters failures → PRs against prompts / gates / config with replay evidence → human.
- Routing-rule extraction from recorded human decisions → proposed rules → human.
- Second intake source (Slack), then the enterprise layers: `AuthProvider` (SSO, policy engine), ML gateway `ModelProvider`, real sandboxes (Docker → gVisor / Kata), user-added tools with approval.

"Autonomous" here means: humans only make the decisions the design reserves for them (tier ≥ 3, structural changes, loosening), and everything else runs.

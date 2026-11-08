# Plan

Goal: build a minimal factory by hand, then let the factory build the rest of itself and grow it into an autonomous system. Design: `docs/design.md`.

## Where it stands (2026-11-09)

| Phase | Status |
|---|---|
| 0 Decisions | done |
| 1 Minimal factory, by hand | done: issues go from intake to a merged PR with the full trail in `state_changes` |
| 2 The factory builds itself | most of the order below is in; the golden set's replay is in progress (#317, #369) |
| 3 Toward autonomy | started: auto mode, the improve loop, standing approvals, Slack, local and GitHub auth with grants |
| RFC 0015 event-driven refactor | landed on main 2026-11-09 (`PROGRESS.md`); the `legacy_*` contract drops wait until 2026-11-23 |

## Principles carried into every phase

- Every infra layer is an interface with local and cloud implementations. Local first.
- Horizontally scalable from day one: stateless controllers and workers, all state in the store, conditional updates, pull-based claims with leases, idempotent intake (see `docs/architecture.md` §4). Phase 1 runs one of each.
- Day one is fully gated: `spec_gate_min_tier = 1`, `auto_merge_max_tier = 0`, and the factory starts in manual mode. Humans decide; decisions are recorded with reasons.
- Dials loosen only with measurement evidence (design §6) and a human decision. Tightening is automatic.
- The factory never merges its own changes to its own gates, prompts, permissions, or tools without a human.

## Phase 0 — Decisions before code

| # | Decision | Recommendation | Status |
|---|---|---|---|
| D1 | Language / stack | **TypeScript (Node)** | decided |
| D2 | Agent harness + LLM provider | Two interfaces. `LLMProvider` (model calls) with an **Anthropic implementation**, whose local transport is the Claude Code CLI on the subscription login (no API key) and whose later transport is the API / gateway. `AgentRunner` (the tool-using loop) with `ClaudeCodeRunner` = `claude -p` in the worktree. Unset `ANTHROPIC_API_KEY`, no `--bare`; `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` for unattended runs. claude.ai login is not allowed in products offered to others → company deployment uses API key / Bedrock / Vertex / ML gateway | decided |
| D3 | Store | `FactoryStore` interface; first impl = SQLite file. **Changed 2026-10-31:** MySQL is the default (several workers and machines are planned); SQLite stays for tests and single-machine use, chosen by `store` in `factory.config.json` | decided |
| D4 | First intake source | GitHub issues on this repo (the factory's own backlog). Slack later. **Since then:** local tasks from the CLI (no account) and Slack threads are sources too (`docs/design/05-sources.md`) | decided |
| D5 | Human gate surface | GitHub PR review + issue comments first; the form UI later. **Since then:** the dashboard (`factory ui`) sends the same commands and merges (`docs/design/09-dashboard-app.md`) | decided |

## Phase 1 — Minimal viable factory (built by hand)

The smallest loop that can take one GitHub issue to one reviewed PR. Everything gated.

1. **Store:** `FactoryStore` + work-item schema + `state_changes` (IDs only). SQLite.
2. **Intake:** GitHub issue labeled `factory` → work item `NEW`.
3. **Triage agent:** fills problem, done criteria, scope (`allowed_paths`), tier → posts the spec as an issue comment → `READY`, `blocked_on: human` until a human approves.
4. **Manager:** code, no LLM. Claims `READY` items with a lease; one worker is enough at first.
5. **Implementer:** `NoOpSandbox` (a git worktree on the host) + `AgentRunner`. TDD tests first, commits with a handoff row per commit, opens a PR.
6. **Reviewer:** blind pass (work item + diff), writes acceptance tests, tier recheck, verdict as a PR review comment. Bug → back to the implementer, `loop_count + 1`.
7. **Human merge:** always, at every tier. Webhook or poll records merge / revert into `state_changes`.

Interfaces stubbed with a single local impl: `FactoryStore`, `Sandbox` (`NoOpSandbox`), `AgentRunner`, `LLMProvider` (Anthropic), `AuthProvider` (no-auth), `SecretStore`, `CapabilitySearch` (list everything).

**Secret guards before the first agent run:** G1 (allowlisted agent env), G2 (credentialed tools via a broker outside the sandbox), G4 (harness deny rules), G5 (egress scan), G6 (canary test). G3 becomes hard with the container sandbox.

**Exit criterion:** the factory takes a real issue from this repo's backlog to a PR that a human merges, with the full trail in `state_changes`.

## Phase 2 — The factory builds itself (dogfooding)

From here, new features are GitHub issues on this repo, worked by the factory. Humans confirm specs and merge.

Order (each one makes the next safer or cheaper):

| # | Step | Status (design topic) |
|---|---|---|
| 1 | Hard gates: CI scope gate (`allowed_paths`), diff-size limit, protected paths (the floor list) | partly: the scope, size and floor gates run before every push, and CI runs the tests (`04-pre-push-gates.md`, `05-ci-gate.md`); a hard CI scope gate is still open |
| 2 | Human form (verdict + severity + reason) replacing free-form comments | done: `/verdict` (`04-gate-commands.md`) |
| 3 | Measurement: weighted feedback rate per tier, revert / fix-forward tracking (`fixes_pr`), budgets, `restart_count` + dead-letter | done (`06-measurement.md`, `06-token-budget.md`, `05-restarts.md`) |
| 4 | Golden PRs from rejected / reverted / held-up PRs; catch + false-alarm rate per agent | in progress: the reviewer's golden set exists; seeding and replay on prompt changes are open (#317, #369) |
| 5 | Parallel workers: per-worker ports and test DB, merge-conflict handling | done (`05-coordination.md`, `05-merge-conflict.md`) |
| 6 | Progressive disclosure + `CapabilitySearch` (BM25 first, vector later) | BM25 done (`bm25` plugin); vector not started |

## Phase 3 — Toward autonomy

| Step | Status |
|---|---|
| Turn dials with evidence: `spec_gate_min_tier`, then `auto_merge_max_tier` 0 → 1 → 2. Automatic demotion + sampled audits | partly: auto mode with `auto_merge_max_tier` (default 0) and automatic return to manual on a red base, a failure alarm or a budget checkpoint (`03-risk.md`, `08-settings.md`); sampled audits not started |
| Self-improvement loop: improver agent clusters failures → PRs against prompts / gates / config with replay evidence → human | partly: the improve run groups failures and files issues (`07-self-improvement.md`); replay evidence waits on the golden set. North star: #305 |
| Routing-rule extraction from recorded human decisions → proposed rules → human | partly: standing approvals and rule proposals (`05-standing-approvals.md`) |
| Second intake source (Slack) | done for the main flow; parity gaps filed as #479–#486 |
| Enterprise layers: `AuthProvider` (SSO, policy engine), ML gateway `ModelProvider`, real sandboxes (Docker → gVisor / Kata), user-added tools with approval | partly: local and GitHub auth with grants and roles, passports and an audit of every decision (`08-permissions.md`); an `openai-compatible` LLM provider; SSO, a policy engine, container sandboxes and user-added tools not started |

"Autonomous" here means: humans only make the decisions the design reserves for them (tier ≥ 3, structural changes, loosening), and everything else runs.

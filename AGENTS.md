# software-factory

A software factory: a team of agents that takes work items (GitHub issues, Slack threads) through triage → implement → review → human gate. Built by hand to a minimal version, then built further by itself.

Agent-neutral instructions. `CLAUDE.md` is a symlink to this file.

## Read first

| File | What |
|---|---|
| `PLAN.md` | Phases (0 decisions, 1 MVP by hand, 2 self-build, 3 autonomy) and open decisions |
| `docs/design.md` | The living design. Change it when a decision changes |
| `SET_UP.md` | One-time setup before using the factory (`npm run setup`) |
| `docs/setup.md` | Where secrets live (`~/.config/software-factory/.env`, never in the repo) and how to create them |
| `docs/architecture.md` | Layers, control plane vs agent plane, process flow, horizontal scaling rules |

## Rules for working here

- Every infra dependency goes behind an interface with a local implementation first (store, sandbox, secrets, shared storage, search, auth, model, agent runner). No vendor SDK call outside its implementation.
- Abstraction is required for three reasons: **testability** (time → `Clock`, anything a test must fake), **infrastructure** (database, LLM provider, GitHub, sandbox, secrets), **environment** (local vs cloud). Implementations are chosen only in `src/compose.ts`; `src/core` and `src/interfaces` import nothing else (`tests/boundaries.test.ts` enforces it).
- Agents never read secrets; only tools do (`docs/architecture.md` §5, guards G1–G6). Credentials live only inside tool implementations. Never in prompts, agent environments, logs, the store, or any file inside the repository.
- Store user and agent IDs, never display names.
- No in-process state that another replica would need. Every state transition is a conditional update in the store; every handler must be safe to run twice.
- New states go into `blocked_on` / `blocked_reason` / `close_reason` before anyone adds a new `stage`.
- Design changes: update `docs/design.md` in the same change, and say which decision changed.
- When the factory works on this repo: changes to its own gates, prompts, permissions or tools always need a human merge, whatever the tier.

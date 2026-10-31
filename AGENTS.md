# software-factory

A software factory: a team of agents that takes work items (GitHub issues, Slack threads) through triage → implement → review → human gate. Built by hand to a minimal version, then built further by itself.

Agent-neutral instructions. `CLAUDE.md` is a symlink to this file.

## Read first

| File | What |
|---|---|
| `PLAN.md` | Phases (0 decisions, 1 MVP by hand, 2 self-build, 3 autonomy) and open decisions |
| `docs/design.md` | The living design. Change it when a decision changes |
| `docs/learning/` | The 2026-10-31 learning session that produced the design (log + exercises 01–08). Snapshot; don't edit |

## Rules for working here

- Every infra dependency goes behind an interface with a local implementation first (store, sandbox, secrets, shared storage, search, auth, model, agent runner). No vendor SDK call outside its implementation.
- Credentials live only inside tool implementations. Never in prompts, logs, or the store.
- Store user and agent IDs, never display names.
- New states go into `blocked_on` / `blocked_reason` / `close_reason` before anyone adds a new `stage`.
- Design changes: update `docs/design.md` in the same change, and say which decision changed.
- When the factory works on this repo: changes to its own gates, prompts, permissions or tools always need a human merge, whatever the tier.

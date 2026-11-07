# software-factory

A software factory: a team of agents that takes work items (GitHub issues, Slack threads) through triage → implement → review → human gate. Built by hand to a minimal version, then built further by itself.

Agent-neutral instructions. `CLAUDE.md` is a symlink to this file.

## Read first

| File | What |
|---|---|
| `PLAN.md` | Phases (0 decisions, 1 MVP by hand, 2 self-build, 3 autonomy) and open decisions |
| `docs/design.md` | Index of the living design: one line per topic file in `docs/design/` |
| `SET_UP.md` | One-time setup before using the factory (`npm run setup`) |
| `docs/setup.md` | Where secrets live (`~/.config/software-factory/.env`, never in the repo) and how to create them |
| `docs/architecture.md` | Layers, control plane vs agent plane, process flow, horizontal scaling rules |
| `docs/slack-setup.md` | One-time Slack app setup (`scripts/slack-app.sh` create, tokens, check) |
| `docs/plugins.md` | Index of every interface's named plugins; each interface's topic file in `docs/plugins/` gives the config to enable each, the secrets it needs, how to switch back; guards cannot be disabled |

`docs/design.md` and `docs/plugins.md` are indexes. Read the index first, then open only the topic files your change touches (`docs/design/<topic>.md`, `docs/plugins/<interface>.md`). Each topic file states its current decision first, with older decisions under "History" at the bottom.

## Rules for working here

- Every infra dependency goes behind an interface with a local implementation first (store, sandbox, secrets, shared storage, search, auth, model, agent runner). No vendor SDK call outside its implementation.
- Abstraction is required for three reasons: **testability** (time → `Clock`, anything a test must fake), **infrastructure** (database, LLM provider, GitHub, sandbox, secrets), **environment** (local vs cloud). Implementations are chosen by name in `factory.config.json` and built only through the registry in `src/plugins.ts`, which discovers one `*.plugin.ts` descriptor per plugin under `src/impl/` (since 2026-11-01); `src/core` and `src/interfaces` import nothing else (`tests/boundaries.test.ts` enforces it).
- A new implementation ships with its `*.plugin.ts` descriptor beside it (`definePlugin` from `src/plugin-api.ts`) and its section in its interface's topic file, `docs/plugins/<interface>.md` (kebab-case, e.g. `keep-awake.md`), in the same change (`tests/plugins.test.ts` fails otherwise). Only a new interface edits `src/plugins.ts`. Guards (`SecretStore`, `EgressScanner`, `ToolBroker`) can be switched, never disabled.
- Agents never read secrets; only tools do (`docs/architecture.md` §5, guards G1–G6). Credentials live only inside tool implementations. Never in prompts, agent environments, logs, the store, or any file inside the repository.
- Store user and agent IDs, never display names.
- No in-process state that another replica would need. Every state transition is a conditional update in the store; every handler must be safe to run twice.
- New states go into `blocked_on` / `blocked_reason` / `close_reason` before anyone adds a new `stage`.
- Design changes: update the topic file in `docs/design/` that holds the decision (e.g. `docs/design/05-restarts.md`) in the same change: the current decision first, the replaced one as a line under its History heading, and say which decision changed. Never put decision text or history in the index `docs/design.md`; add a line there only for a new topic file.
- Keep the code maintainable as it grows: leave every change at least as small and clear as you found it.
  - Delete what you replace: no dead code, unused exports, commented-out blocks or old paths kept "just in case".
  - Reuse before adding: search for an existing helper, type or plugin before writing a new one.
  - Duplication in two places is a warning; in three, extract it.
  - When a feature is replaced, deprecate it in its topic file with a removal plan, then remove it. Don't keep two ways of doing the same thing.
  - Prefer fewer settings, states and code paths. A new one needs a reason recorded in its topic file.
- When the factory works on this repo: changes to its own gates, prompts, permissions or tools always need a human merge, whatever the tier.

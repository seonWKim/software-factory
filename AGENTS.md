# software-factory

A software factory: a team of agents that takes work items (GitHub issues, Slack threads) through triage → implement → review → human gate. Built by hand to a minimal version, then built further by itself.

Agent-neutral instructions. `CLAUDE.md` is a symlink to this file.

## Read first

| File | What |
|---|---|
| `ARCHITECTURE.md` | Overview for review: every component as a box, every connection labelled by how it talks (call, store queue, outbox/inbox, HTTP, tool RPC, exec, IPC, remote) |
| `PLAN.md` | Phases (0 decisions, 1 MVP by hand, 2 self-build, 3 autonomy) and open decisions |
| `docs/design.md` | Index of the living design: one line per topic file in `docs/design/` |
| `docs/design/09-brand-and-tokens.md` | Dashboard design tokens: `design-system/tokens.json` is the source, `web/src/tokens.css` is generated (`npm run build:tokens`), no hex colours elsewhere in `web/src/` |
| `SET_UP.md` | One-time setup before using the factory (`npm run setup`) |
| `docs/setup.md` | Where secrets live (`~/.config/software-factory/.env`, never in the repo) and how to create them |
| `docs/architecture.md` | Layers, control plane vs agent plane, process flow, horizontal scaling rules |
| `docs/slack-setup.md` | One-time Slack app setup (`scripts/slack-app.sh` create, tokens, check) |
| `docs/plugins.md` | Index of every interface's named plugins; each interface's topic file in `docs/plugins/` gives the config to enable each, the secrets it needs, how to switch back; guards cannot be disabled |

`docs/design.md` and `docs/plugins.md` are indexes. Read the index first, then open only the topic files your change touches (`docs/design/<topic>.md`, `docs/plugins/<interface>.md`). Each topic file states its current decision first, with older decisions under "History" at the bottom.

## Principles every change follows

- **Local first.** The factory works with no external plugin selected: local intake, specs, commands, branches, review and merge. GitHub, Slack and Jira are sync plugins. A local action is authorized locally and never waits on a sync plugin, and an outage or rate limit of a sync plugin never stops local work.
- **One owner.** The factory serves one person, its owner, who may run many workers (processes, replicas, machines) on one store. Identity comes from the environment: git `user.email`, then the OS user, then `anonymous`. Build no feature whose only reason is another person (roles, grants, per-person permissions, user tables, shared budgets between people); keep every feature whose reason is another process (claims, leases, fencing, conditional updates, idempotent handlers, bus partitions). See `docs/design/08-enterprise.md`.
- **Few external calls.** Batch, cache, and use conditional requests and cursors. No per-item or per-poll remote reads when the stored copy is enough. Never send bursts of writes through a shared account.
- **Maintainable.** See the maintainability rule below.
- **Heavy tests run on a schedule.** MySQL and full end-to-end suites run periodically against main, not on every change.

## Rules for working here

- Every infra dependency goes behind an interface with a local implementation first (store, sandbox, secrets, shared storage, search, auth, model, agent runner). No vendor SDK call outside its implementation.
- Abstraction is required for three reasons: **testability** (time → `Clock`, anything a test must fake), **infrastructure** (database, LLM provider, GitHub, sandbox, secrets), **environment** (local vs cloud). Implementations are chosen by name in `factory.config.json` and built only through the registry in `src/plugins.ts`, which discovers one `*.plugin.ts` descriptor per plugin anywhere under `src/` (legacy `src/impl/` or a component's `plugins/` folder, since 2026-11-08); `src/core` and `src/interfaces` import nothing else (`tests/boundaries.test.ts` enforces it).
- A new implementation ships with its `*.plugin.ts` descriptor beside it (`definePlugin` from `src/plugin-api.ts`) and its section in its interface's topic file, `docs/plugins/<interface>.md` (kebab-case, e.g. `keep-awake.md`), in the same change (`tests/plugins.test.ts` fails otherwise). Only a new interface edits `src/plugins.ts`. Guards (`SecretStore`, `EgressScanner`, `ToolBroker`) can be switched, never disabled.
- Agents never read secrets; only tools do (`docs/architecture.md` §5, guards G1–G6). Credentials live only inside tool implementations. Never in prompts, agent environments, logs, the store, or any file inside the repository.
- Store user and agent IDs, never display names.
- No in-process state that another worker would need. Every state transition is a conditional update in the store; every handler must be safe to run twice.
- New states go into `blocked_on` / `blocked_reason` / `close_reason` before anyone adds a new `stage`.
- Design changes: update the topic file in `docs/design/` that holds the decision (e.g. `docs/design/05-restarts.md`) in the same change: the current decision first, the replaced one as a line under its History heading, and say which decision changed. Never put decision text or history in the index `docs/design.md`; add a line there only for a new topic file.
- Keep the code maintainable as it grows: leave every change at least as small and clear as you found it.
  - Delete what you replace: no dead code, unused exports, commented-out blocks or old paths kept "just in case".
  - Reuse before adding: search for an existing helper, type or plugin before writing a new one.
  - Duplication in two places is a warning; in three, extract it.
  - When a feature is replaced, deprecate it in its topic file with a removal plan, then remove it. Don't keep two ways of doing the same thing.
  - Prefer fewer settings, states and code paths. A new one needs a reason recorded in its topic file.
- A change to `web/` or `src/ui/` passes `npm run check:responsive` (every dashboard page at five window sizes, light and dark) before it merges. It runs at merge on the merged commit (the merge queue's UI check, `repo.ui_check`), not in the agent sandbox, which cannot start Chrome; not running it there is not missing work.
- When the factory works on this repo: changes to its own gates, prompts, permissions or tools always need a human merge, whatever the tier.
- Factory feature or local development process: before filing or building something, ask whether a factory user on another project would get anything from it. If yes, it is a factory feature (an issue, built through the factory). If it only helps develop this repository (a review agent for its own dashboard, a dev script, a local check), it is a local development process: a Claude Code agent or skill under `.claude/`, or a script under `scripts/`, never a factory issue or a factory role.

## UI changes

A change to the dashboard (`web/`) follows `design-system/dx.md`: its build steps, its checks and its PR checklist.

## Rules for agents working on this repo

The factory's prompts in `prompts/` are generic, for any project. These are this repo's own rules on top of them.

- Tests: run them through the project's scripts, also for a single file (`npm test -- tests/x.test.ts`), never the test runner directly (`npx vitest ...`): the scripts carry flags the sandbox needs. Dependencies are already installed and the sandbox has no network: never run `npm install`, `npm ci`, or `npx` for a package that is not installed.
- Merge conflicts in `docs/design.md`, `docs/design/*.md`, `docs/plugins/*.md`, `docs/settings.md` and `SET_UP.md`: keep both sides' sections. Each side's new or changed section stays; never drop either side's section to keep the other's. When both sides added a current decision at the top of a topic file, order the two newest first by their decision date. When both sides edited the same decision paragraph, combine the two edits into one decision and keep both sides' History lines. If both sides edited any other paragraph, combine the two edits.
- Migrations: when both sides added a migration with the same number, the base keeps its number and the branch's migration is renumbered to the next free number in both the SQLite and the MySQL schema lists (`migrations/mysql/`, `src/impl/store/mysql/migrations.ts`) and in tests that name the number. This rule applies until the MySQL store is removed (`docs/plugins/factory-store.md`).
- Specs: a store schema change also allows `migrations/mysql/` and `src/impl/store/mysql/migrations.ts` beside the SQLite schema.

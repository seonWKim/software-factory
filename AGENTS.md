# software-factory

A software factory for one owner: a set of agents that takes work items (GitHub issues, Slack threads) through triage → implement → review → human gate. Built by hand to a minimal version, then built further by itself.

## North star

The best self-evolving software factory for one person.

Weigh every change against it: does it make the factory better at building software for its one owner, or better at improving itself? When two choices are otherwise equal, pick the one that serves this.

## Where things are

| File | What |
|---|---|
| `ARCHITECTURE.md` | Overview for review: every component as a box, every connection labelled by how it talks (call, store queue, outbox/inbox, HTTP, tool RPC, exec, IPC, remote) |
| `PLAN.md` | Phases (0 decisions, 1 MVP by hand, 2 self-build, 3 autonomy) and open decisions |
| `docs/design.md` | Index of the living design: one line per topic file in `docs/design/` |
| `docs/design/09-brand-and-tokens.md` | Dashboard design tokens: `design-system/tokens.json` is the source, `web/src/tokens.css` is generated (`npm run build:tokens`) |
| `SET_UP.md` | One-time setup before using the factory (`npm run setup`) |
| `docs/setup.md` | Where secrets live (`~/.config/software-factory/.env`, never in the repo) and how to create them |
| `docs/architecture.md` | Layers, control plane vs agent plane, process flow, horizontal scaling rules |
| `docs/slack-setup.md` | One-time Slack app setup (`scripts/slack-app.sh` create, tokens, check) |
| `docs/plugins.md` | Index of every interface's named plugins; each interface's topic file in `docs/plugins/` gives the config to enable each, the secrets it needs, how to switch back; guards cannot be disabled |

`docs/design.md` and `docs/plugins.md` are indexes. Read the index first, then open only the topic files your change touches (`docs/design/<topic>.md`, `docs/plugins/<interface>.md`). Each topic file states its current decision first, with older decisions under "History" at the bottom, or in `docs/design/history/<topic>.md` that it links there.

## Principles every change follows

- **Local first.** The factory works with no external plugin selected: local intake, specs, commands, branches, review and merge. GitHub, Slack and Jira are sync plugins. A local action is authorized locally and never waits on a sync plugin, and an outage or rate limit of a sync plugin never stops local work.
- **One owner.** The factory serves one person, its owner, who may run many workers (processes, replicas, machines) on one store. Identity comes from the environment: git `user.email`, then the OS user, then `anonymous`. Build no feature whose only reason is another person (roles, grants, per-person permissions, user tables, shared budgets between people); keep every feature whose reason is another process (claims, leases, fencing, conditional updates, idempotent handlers, bus partitions). See `docs/design/08-enterprise.md`.
- **Few external calls.** Batch, cache, and use conditional requests and cursors. No per-item or per-poll remote reads when the stored copy is enough. Never send bursts of writes through a shared account.
- **Heavy tests run on a schedule.** Full end-to-end suites run periodically against main, not on every change.

## Rules for working here

- Every infra dependency goes behind an interface with a local implementation first (store, sandbox, secrets, shared storage, search, auth, model, agent runner). No vendor SDK call outside its implementation.
- Abstraction is required for three reasons: **testability** (time → `Clock`, anything a test must fake), **infrastructure** (database, LLM provider, GitHub, sandbox, secrets), **environment** (local vs cloud). Implementations are chosen by name in `factory.config.json` and built only through the registry in `src/plugins.ts`; only a new interface edits that file.
- Agents never read secrets; only tools do (`docs/architecture.md` §5, guards G1–G6). Credentials live only inside tool implementations. Never in prompts, agent environments, logs, the store, or any file inside the repository.
- Store user and agent IDs, never display names.
- No in-process state that another worker would need. Every state transition is a conditional update in the store; every handler must be safe to run twice.
- New states go into `blocked_on` / `blocked_reason` / `close_reason` before anyone adds a new `stage`.
- Design changes: update the topic file in `docs/design/` that holds the decision (e.g. `docs/design/05-restarts.md`) in the same change: the current decision first, the replaced one as a line in `docs/design/history/<topic>.md`, which the topic file's History heading links to, and say which decision changed. Never put decision text or history in the index `docs/design.md`; add a line there only for a new topic file.
- Keep the code maintainable as it grows: leave every change at least as small and clear as you found it.
  - Delete what you replace: no dead code, unused exports, commented-out blocks or old paths kept "just in case".
  - Reuse before adding: search for an existing helper, type or plugin before writing a new one.
  - Duplication in two places is a warning; in three, extract it.
  - When a feature is replaced, deprecate it in its topic file with a removal plan, then remove it. Don't keep two ways of doing the same thing.
  - Prefer fewer settings, states and code paths. A new one needs a reason recorded in its topic file.
- `npm run check:responsive` (every dashboard page at five window sizes, light and dark) runs at merge on the merged commit (`repo.ui_check`), not in the agent sandbox, which cannot start Chrome: not running it there is not missing work.
- Headless first: a feature is declared as an API capability first (`src/api/`, design `docs/design/09-api-registry.md`: schema, description and permission, once), and the dashboard, chat and CLI call that API. Page-only or CLI-only behaviour and hand-written routes count as gaps.
- Factory feature or local development process: before filing or building something, ask whether a factory user on another project would get anything from it. If yes, it is a factory feature (an issue, built through the factory). If it only helps develop this repository (a review agent for its own dashboard, a dev script, a local check), it is a local development process: a Claude Code agent or skill under `.claude/`, or a script under `scripts/`, never a factory issue or a factory role.

## UI changes

A change to the dashboard (`web/`) reads `design-system/components.md`, `design-system/patterns.md`, `design-system/writing.md` (also for text the server writes for a page) and the last 40 active lines of `design-system/learnings.md` (the owner's past corrections; skip a line a later `supersedes` line names), composes from `web/src/components/ui/`, and follows `design-system/dx.md` for its build steps, checks and PR checklist.

A UI change edits only the page file it touches (`docs/design/09-dashboard-<page>.md`, with its `docs/design/history/` file; the item page is `09-dashboard-item.md` and its area files `09-dashboard-item-about.md`, `-runs.md`, `-thread.md`, `-actions.md`). The sidebar and top bar are in `docs/design/09-dashboard-shell.md`, the shared components in `docs/design/09-dashboard-components.md`. `docs/design/09-dashboard-app.md` is an index; add no decision to it.

## Rules for agents working on this repo

The factory's prompts in `prompts/` are generic, for any project. These are this repo's own rules on top of them.

- Dependencies: already installed, and the sandbox has no network: never run `npm install`, `npm ci`, or `npx` for a package that is not installed.
- Table-name lists: when the allowed paths hold a migration, `tests/store-contract.test.ts` (`DOMAIN_TABLES`), `tests/state/contract-migrations.test.ts` and `src/state/migrations/20261109T0900-state-drop-legacy-tables.migration.ts` (`RETIRED`) are allowed too (design 04-pre-push-gates). Edit only their table-name list lines to follow the migration, and never stop to ask for them; a review finds any other edit there.
- Generated files are regenerated on a conflict, never hand-merged: a conflict in `docs/settings.md` is fixed by running `npm run settings:catalog`.
- Merge conflicts in `docs/design.md`, `docs/design/*.md`, `docs/plugins/*.md` and `SET_UP.md`: keep both sides' sections. Each side's new or changed section stays; never drop either side's section to keep the other's. When both sides added a current decision at the top of a topic file, order the two newest first by their decision date. When both sides edited the same decision paragraph, combine the two edits into one decision and keep both sides' History lines. If both sides edited any other paragraph, combine the two edits.

# Set up

What to do once before the factory can take work. One command does most of it:

```bash
npm run setup
```

It is safe to run again: it skips what is already done. Two steps need you in a browser; the command stops and tells you when.

## Before you start

- Node.js 22.13 or newer, and git
- Claude Code installed (`claude --version`)
- A Claude Pro / Max / Team / Enterprise plan
- MySQL 8+ running locally, and an admin login that the `mysql` client can use (`~/.my.cnf`, or it asks for the root password). For SQLite only, set `"store": { "type": "sqlite" }` in `factory.config.json` and skip this
- Write access to the GitHub repository the factory works on (set in `factory.config.json`, default `seonWKim/software-factory`)
- `ANTHROPIC_API_KEY` **not** set in your shell. If it is, it overrides the subscription token: `unset ANTHROPIC_API_KEY`

## What `npm run setup` does

| Step | Automated | You do |
|---|---|---|
| 1. Secret file | Creates `~/.config/software-factory/.env` (folder `700`, file `600`), outside the repository | — |
| 2. Model credential | Prompts for the token with hidden input and writes it to the secret file | Run `claude setup-token` in a **separate, plain terminal**, sign in in the browser, copy the token it prints (shown once), paste it at the prompt |
| 3. GitHub token | Opens the token page, shows the exact settings, prompts with hidden input, writes it to the secret file | Create the token (settings below), paste it at the prompt |
| 4. Database | Creates the `software_factory` database and the factory's own MySQL user with a generated password, written to the secret file | Type the MySQL root password if the `mysql` client asks |
| 5. Labels | Creates the `factory` intake label and the eight status labels (below) on the repository; reports each as created, already exists, or could not create | — |
| 6. Checks | Runs `doctor`: file permissions, credentials present, claude CLI, database connection, push access, intake label; warns on a token that never expires and on each missing status label | Fix any `FAIL` line and rerun |
| 7. Canary | Asks, then runs a real agent told to find a planted fake secret. It must not find it | Answer `Y`. If it fails, **do not run the factory**: revoke the GitHub token |

Tokens never appear on screen, in shell history, in command arguments, or in the repository. Only the factory's own tools read the secret file; agents can't (guards G1–G6, `docs/architecture.md` §5).

### GitHub token settings

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token:

| Field | Value |
|---|---|
| Expiration | Your choice for local use (`doctor` only warns). If the factory is shared or runs in the cloud: 30 days or less |
| Repository access | Only select repositories → the factory's repository |
| Contents | Read and write |
| Issues | Read and write |
| Pull requests | Read and write |
| Metadata | Read-only (added automatically) |
| Everything else | No access |

## After setup

```bash
npm run factory -- dev        # start: controller + worker in one process
```

`dev` runs `origin/<base_branch>`, not your working tree: it keeps a built copy in `.factory/runtime`, and when a merge lands on the base branch it builds the new commit, lets the running job finish, and restarts on it. A build that fails leaves the old version running. Your checkout is fast-forwarded too, but only when it is on the base branch with no local changes; it is never checked out, stashed or reset. Local edits and unpushed commits do not affect `dev` until they are pushed and merged.

To run your working tree instead (as before), set `"updater": "none"` in the `plugins` object of `factory.config.json` and restart `dev`. Details: [`docs/plugins.md`](docs/plugins.md#updater).

Then on GitHub:

1. Label an issue `factory`.
2. The factory posts a spec on the issue. Reply `/approve`, `/reject <reason>`, or `/revise <feedback>`. `/revise` keeps the issue open and posts a new spec written with your feedback; `/reject` posts your reason and closes the issue as not planned.
3. It opens a PR, reviews it, and comments when a human merge is needed. Merge it yourself.
4. If a step fails, it comments; reply `/retry`.
   If `budgets` is set for the item's tier in `factory.config.json` (e.g. `"budgets": {"2": 2000000}`; absent means no limit) and the item has spent that many tokens, the factory stops before its next implement or review run and comments a budget checkpoint: what was spent, the current budget and a suggested one. All work so far is kept. Reply:
   - `/budget` to continue with the suggested budget;
   - `/budget <tokens>` to continue with your own budget, a whole number greater than the current one (e.g. `/budget 9000000`);
   - `/reject <reason>` to close the item. The branch and the PR stay as they are; close the PR yourself if you want.
5. To rate the result, comment `/verdict accept|changes|reject <severity> <reason>` on the issue or the PR. Severity is `none`, `minor`, `major` or `critical`; `accept` may leave out the reason. A verdict is only recorded; it does not move the item. It needs a PR to exist and is refused once the item is closed.

Only users with write permission on the repository can approve, reject, revise, retry, answer a budget checkpoint or record a verdict.
The factory reacts 👀 to each command it handled and to each issue it took in; if it refused a command, it replies saying why.

### Status labels

Each work item's issue carries exactly one status label, and so does its PR once there is one. The factory sets it on every change of state, and again for every open item when it starts. Names are `status_label_prefix` (in `factory.config.json`, default `sf: `) plus the name below. The factory creates a missing one on first use; `doctor` only warns about a missing one.

| Label | Meaning |
|---|---|
| `sf: triaging` | Taken in; the triage agent is writing the spec |
| `sf: needs approval` | The spec is posted; reply `/approve`, `/reject <reason>`, or `/revise <feedback>` |
| `sf: implementing` | The implementer agent is working on the branch |
| `sf: in review` | The PR is open and the reviewer agent is checking it |
| `sf: ready to merge` | The PR passed review; a human merges it |
| `sf: needs human` | Stuck: a run failed (reply `/retry`), review hit the loop limit, the PR has a conflict, or the item reached its token budget (reply `/budget`, `/budget <tokens>` or `/reject <reason>`). The comments say which |
| `sf: done` | The PR was merged |
| `sf: rejected` | Closed without a merge: spec rejected, or PR closed unmerged |

The factory removes only these eight names (under the current prefix) when it changes the status. Other labels, including your own labels that start with `sf: `, are never touched. Changing a label by hand does nothing; the factory does not read them.

## Routine

| When | Command |
|---|---|
| Check that everything still works | `npm run factory -- doctor` |
| Check that the configured LLM provider answers (two small real calls) | `npm run factory -- llm-check` (or `doctor --llm`) |
| GitHub token expired or about to | `npm run setup -- --rotate-github` |
| Claude token replaced | `npm run setup -- --rotate-claude` |
| New MySQL password for the factory user | `npm run setup -- --rotate-mysql` |
| See work items / one item's history | `npm run factory -- status` / `npm run factory -- status <id>` |
| Watch the factory in a browser (read-only) | `make ui` (or `npm run factory -- ui`), then open <http://127.0.0.1:4310/> |
| Suspect a leak | Revoke the token on GitHub first, then rotate |

### Status page

`npm run factory -- ui` serves a read-only page at <http://127.0.0.1:4310/> (the port is `ui.port` in `factory.config.json`). It shows what waits for you, what runs now, the queue, all work items and 24-hour totals; `/items/<id>` shows one item's timeline and runs. It refreshes every 5 seconds and has no buttons: approve, reject, retry and merge stay on GitHub. It listens on 127.0.0.1 only and answers only requests whose Host is `127.0.0.1` or `localhost`. It starts no controller or worker, so run it beside `npm run factory -- dev`. It reads the secret file like the other commands (the MySQL password, and known secret values for the egress scan); a field that looks like a secret shows `[withheld: <rule>]` instead of its text.

Why the secret file lives where it does, and how each guard works: [`docs/setup.md`](docs/setup.md), [`docs/architecture.md` §5](docs/architecture.md#5-secret-isolation).

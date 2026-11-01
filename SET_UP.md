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

### GitHub App (the bot; `plugins.github_auth: "app"`, the checked-in setting)

The factory acts on GitHub as your GitHub App, so issues, comments, pushes and PRs show the App's bot as author.

- Put the App's ID in the secret file as `GITHUB_APP_ID` (`npm run setup` asks for it) and its private key in `github-app.pem` next to the secret file (`~/.config/software-factory/`, mode 600).
- Install the App on the repository. **Repository permissions:** Contents, Issues and Pull requests: read and write; Metadata: read. Everything else: no access.
- After changing the App's permissions, accept them on the installation (Settings → Applications → Installed GitHub Apps → Review request). `npm run factory -- doctor` names any permission still missing.

To use your own account instead, set `plugins.github_auth` to `token` and create the token below.

### GitHub token settings (`plugins.github_auth: "token"`)

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
2. The factory posts a spec on the issue. Reply `/approve [notes]`, `/reject <reason>`, or `/revise <feedback>`. Notes after `/approve` (on the same line or the lines below) go to the implementer and the reviewer; `/revise` keeps the issue open and posts a new spec written with your feedback; `/reject` posts your reason and closes the issue as not planned.
3. It opens a PR, reviews it, and comments when a human merge is needed. Merge it yourself.
4. If a step fails, it comments; reply `/retry`.
   If `budgets` is set for the item's tier in `factory.config.json` (e.g. `"budgets": {"2": 2000000}`; absent means no limit) and the item has spent that many tokens, the factory stops before its next implement or review run and comments a budget checkpoint: what was spent, the current budget and a suggested one. All work so far is kept. Reply:
   - `/budget` to continue with the suggested budget;
   - `/budget <tokens>` to continue with your own budget, a whole number greater than the current one (e.g. `/budget 9000000`);
   - `/reject <reason>` to close the item. The branch and the PR stay as they are; close the PR yourself if you want.
5. To rate the result, comment `/verdict accept|changes|reject <severity> <reason>` on the issue or the PR. Severity is `none`, `minor`, `major` or `critical`; `accept` may leave out the reason. A verdict is only recorded; it does not move the item. It needs a PR to exist and is refused once the item is closed.
6. If the PR stops merging cleanly and the factory cannot update it (the PR is marked `sf: needs human` with a conflict comment), reply `/resolve [notes]` on the issue or on the PR. An agent resolves the conflict, and the factory pushes only if the changed files stay within the conflicting files and the allowed paths and `repo.install_command` / `repo.test_command` pass. The PR then goes through review again. If the resolve fails, it comments why; you can send `/resolve` again. Anything after `/resolve` (same line or below) is passed to the agent as notes.

Only users with write permission on the repository can approve, reject, revise, retry, resolve, answer a budget checkpoint or record a verdict.
The factory reacts 👀 to each command it handled and to each issue it took in; if it refused a command, it replies saying why.

### Commands

A command is the first line of a comment: `/` and the command name (any case), then a space, the end of the line, or one of `.,:;!?`. Every comment where the factory waits for you ends with the commands that apply at that point. `/help` replies with the full list, marking those. A mistyped command (say `/aprove`) gets one reply naming it, with the commands that apply now. On an issue that is not a factory work item, commands get no reaction and no reply.

| Command | What it does | Applies when |
|---|---|---|
| `/approve [notes]` | Approve the spec or the floor block. Notes on the same line or below go to the implementer and the reviewer | spec waiting for approval, spec at the revision limit, blocked by the floor check |
| `/reject <reason>` | Close the item without a merge, giving your reason | spec waiting for approval, spec at the revision limit, blocked by the floor check, paused at a budget checkpoint |
| `/revise <feedback>` | Get a new spec written with your feedback | spec waiting for approval |
| `/retry` | Run the failed run again | blocked by a failed run |
| `/resolve [notes]` | Let an agent resolve the PR's merge conflict; notes go to the agent | PR has a merge conflict |
| `/budget [tokens]` | Continue past the budget checkpoint with the suggested budget, or with a larger whole number of tokens | paused at a budget checkpoint |
| `/verdict accept\|changes\|reject <severity> <reason>` | Record a verdict on the result; it does not change the state | any open item, once it has a PR |
| `/help` | List every command and which ones apply now | any time |

Approval notes are untrusted text: they are capped at 2000 characters and checked by the leak scanner before they are stored. A note the scanner blocks refuses the approval with a reply; post `/approve` again without it. Generated from `src/core/commands.ts`; a test fails when this table differs.

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

### Several items at once

By default the factory builds one item at a time. To build several in parallel, set `workers` in `factory.config.json`, e.g. `"workers": 3`, and restart `npm run factory -- dev` (or `worker`). It must be a whole number of 1 or more; anything else stops startup with an error. Absent means 1.

Items whose allowed paths overlap still wait for each other, so their PRs do not conflict; triage and review never wait. Each worker passes its number (0, 1, 2, …) to the agent and to the update test command as `SF_WORKER_INDEX`. If your tests start a server or use a database, use it to pick a port or database name per worker so parallel runs do not collide, e.g. `PORT=$((3000 + SF_WORKER_INDEX))`. The number is unique only inside one process: two factory processes on one machine both have a worker 0.

Unknown config keys are rejected at load: a typo in `factory.config.json` (for example `"plugin"` or a `"hots"` in `store`) stops every command with an error that names the key, lists the valid keys and suggests the closest one; `doctor` shows each as a FAIL line.

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
| File or tidy an issue as the factory (the bot with `app`) | `npm run factory -- issue create --title <t> --body-file <f> [--label <l>]...`, `issue comment <n> --body-file <f>`, `issue title <n> <text>`, `issue sub-issue <parent> <child>` |
| Suspect a leak | Revoke the token on GitHub first (or the App's key), then rotate |

### Status page

`npm run factory -- ui` serves a read-only page at <http://127.0.0.1:4310/> (the port is `ui.port` in `factory.config.json`). The top is one list of work items, most urgent first, each with a short reason badge; items that wait for you also say what to do next (a link to the exact comment or PR and the command to type there). Below it the page shows what runs now and the queue; `/items/<id>` shows one item's timeline and runs. It updates itself every 5 seconds without losing your scroll, open details or search text, pauses while the tab is hidden, and has a Refresh link when JavaScript is off. It has no action buttons: approve, reject, retry and merge stay on GitHub. It listens on 127.0.0.1 only and answers only requests whose Host is `127.0.0.1` or `localhost`. It starts no controller or worker, so run it beside `npm run factory -- dev`. It reads the secret file like the other commands (the MySQL password, and known secret values for the egress scan); a field that looks like a secret shows `[withheld: <rule>]` instead of its text, and search can't find it.

The list's order:
1. Ready to merge
2. Needs approval
3. Needs you for another reason (failed, merge conflict, too many loops, budget)
4. Stuck (a run past its lease, or nothing moves the item)
5. Running
6. Queued
7. Waiting on another issue (empty until dependencies are tracked)
8. Closed (hidden unless asked for)

Within a level: items that unblock more others first, then the longest wait, then the higher tier.

Filters (in the URL, so a filtered view can be bookmarked; each option shows how many items it would show):
- `state`: `needs` (the first three levels) or one level
- `stage`: `NEW`, `READY`, `RUNNING`, `REVIEW`, `CLOSED`
- `tier`: `1` to `5`
- `kind`: the run kind in a failure reason, else the kind of the queued or running run (`triage`, `implement`, `review`, `update`)
- `unblocks=1`: only items others wait on
- `closed=1`: show closed items too
- `q`: search the issue number (`#12` or `12`) and the title as shown

Slack (optional, for real-time threads): [`docs/slack-setup.md`](docs/slack-setup.md), mostly `scripts/slack-app.sh create|tokens|check`.

Why the secret file lives where it does, and how each guard works: [`docs/setup.md`](docs/setup.md), [`docs/architecture.md` §5](docs/architecture.md#5-secret-isolation).

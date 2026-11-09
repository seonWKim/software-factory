# Set up

What to do once before the factory can take work. One command does most of it:

```bash
npm run setup
```

It is safe to run again: every question shows its default (your current choice) and Enter takes it, and it skips what is already done. Two steps need you in a browser; the command stops and tells you when.

- `npm run setup -- --yes` takes every default without asking (for scripts). A missing secret is reported, not asked: paste it later with a plain `npm run setup` in a terminal.
- `npm run setup -- --me` only registers you (your ID and display name). For a second person on a shared store: it changes neither `factory.config.json` nor the secret file.
- `npm run setup -- --rotate-github` (or `--rotate-claude`, `--rotate-mysql`) replaces a stored credential.

## Before you start

- Node.js 22.13 or newer, and git
- Claude Code installed (`claude --version`)
- A Claude Pro / Max / Team / Enterprise plan
- For a MySQL store: MySQL 8+ running locally, and an admin login that the `mysql` client can use (`~/.my.cnf`, or it asks for the root password). For SQLite, answer `sqlite` at setup's Store step and skip this
- With GitHub sync on: write access to the GitHub repository the factory works on (set in `factory.config.json`, default `seonWKim/software-factory`)
- `ANTHROPIC_API_KEY` **not** set in your shell. If it is, it overrides the subscription token: `unset ANTHROPIC_API_KEY`

## What `npm run setup` does

| Step | Automated | You do |
|---|---|---|
| 1. Store | Asks `sqlite` (one machine, no server) or `mysql` (a shared database for a team) | Press Enter for the default (`sqlite` on a new file) |
| 2. Plugins | Asks whether to sync with GitHub and whether to take work from Slack threads (then the channel IDs). Shows the change to `factory.config.json` as a `-`/`+` diff and writes it when you say yes; only the changed keys (`store`, `plugins`, `auth`, `permissions`, `slack`) change. Local only (the default on a new file) selects no GitHub plugin | Answer, then confirm the diff |
| 3. Mode | Asks `manual` or `auto` and `auto_merge_max_tier` (0 to 3; 0 merges nothing). Runtime settings, not file keys: set later in the "You and the mode" step through `factory settings set` | Press Enter to keep the current ones |
| 4. Secret file | Creates `~/.config/software-factory/.env` (folder `700`, file `600`), outside the repository | — |
| 5. Model credential | Prompts for the token with hidden input and writes it to the secret file | Run `claude setup-token` in a **separate, plain terminal**, sign in in the browser, copy the token it prints (shown once), paste it at the prompt |
| 6. GitHub token | Opens the token page, shows the exact settings, prompts with hidden input, writes it to the secret file | Create the token (settings below), paste it at the prompt |
| 7. Database | Creates the `software_factory` database and the factory's own MySQL user with a generated password, written to the secret file | Type the MySQL root password if the `mysql` client asks |
| 8. You and the mode | Asks your display name (prefilled from git `user.name`) and stores it once against your ID; makes you the local owner if there is none yet; sets the mode and tier you chose if they changed | Type your name or press Enter. Your ID stays `cli_user`, else `local:<git user.email>`, else `local:<OS user>` |
| 9. Other secrets | Prompts for any other secret the selected plugins declare | Paste each |
| 10. Labels | Creates the `factory` intake label and the eight status labels (below) on the repository; reports each as created, already exists, or could not create | — |
| 11. Checks | Runs `doctor`: file permissions, credentials present, claude CLI, database connection, push access, intake label; warns on a token that never expires and on each missing status label | Fix any `FAIL` line and rerun. On a new MySQL database, run `npm run migrate` once first (the schema-steps FAIL says so) |
| 12. Canary | Asks, then runs a real agent told to find a planted fake secret. It must not find it | Answer `Y`. If it fails, **do not run the factory**: revoke the GitHub token |

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
| Checks | Read-only (the CI gate reads the PR's check runs) |
| Commit statuses | Read-only (the CI gate reads the PR's commit statuses) |
| Metadata | Read-only (added automatically) |
| Everything else | No access |

`npm run setup` does not list Checks and Commit statuses yet; add them by hand. Without them the factory cannot read a PR's checks, logs `reading PR checks failed`, and the PR waits in review.

## After setup

```bash
npm run factory -- dev        # start: controller + worker in one process
```

`dev` runs `origin/<base_branch>`, not your working tree: it keeps a built copy in `.factory/runtime`, and when a merge lands on the base branch it builds the new commit, lets the running job finish, and restarts on it. A build that fails leaves the old version running. Your checkout is fast-forwarded too, but only when it is on the base branch with no local changes; it is never checked out, stashed or reset. Local edits and unpushed commits do not affect `dev` until they are pushed and merged.

To run your working tree instead (as before), set `"updater": "none"` in the `plugins` object of `factory.config.json` and restart `dev`. Details: [`docs/plugins/updater.md`](docs/plugins/updater.md).

Then on GitHub:

1. Label an issue `factory`.
2. The factory posts a spec on the issue. Reply `/approve [notes]`, `/reject <reason>`, or `/revise <feedback>`. Notes after `/approve` (on the same line or the lines below) go to the implementer and the reviewer; `/revise` keeps the issue open and posts a new spec written with your feedback; `/reject` posts your reason and closes the issue as not planned.
3. It opens a PR, reviews it, waits for the PR's checks (the `test` workflow, below), and comments when a human merge is needed. Merge it yourself. If a check fails, the factory sends the PR back to the implementer with the failing check names; that counts as one loop, like a review that found a bug.
   To ask for changes before you merge (or after its review run failed), reply `/revise <feedback>` on the PR, or submit a GitHub review with "Request changes": its text and each line comment (file and line) go to the implementer, who pushes to the same PR branch; a fresh review follows. Each round counts as one loop toward `max_loops`; at the limit the factory comments and starts nothing. Approvals and plain review comments start nothing. Only reviews from users with write permission count, and only those submitted after the factory first read the PR's reviews.
4. If a step fails, it comments; reply `/retry`.
   If `budgets` is set for the item's tier in `factory.config.json` (e.g. `"budgets": {"2": 2000000}`; absent means no limit) and the item has spent that many tokens, the factory stops before its next implement or review run and comments a budget checkpoint: what was spent, the current budget and a suggested one. All work so far is kept. Reply:
   - `/budget` to continue with the suggested budget;
   - `/budget <tokens>` to continue with your own budget, a whole number greater than the current one (e.g. `/budget 9000000`);
   - `/reject <reason>` to close the item. The branch and the PR stay as they are; close the PR yourself if you want.
5. To rate the result, comment `/verdict accept|changes|reject <severity> <reason>` on the issue or the PR. Severity is `none`, `minor`, `major` or `critical`; `accept` may leave out the severity (it is then `none`) and the reason, and `yes` or `ok` mean `accept`. A verdict is only recorded; it does not move the item. It needs a PR to exist, still works after the merge, and is refused once the item is closed without a merge. With a forge, the factory also records verdicts on its own: an `accept` when a factory PR is merged with no commits by people, a `changes` when a person pushes to it, and a `reverted` when its merge is reverted. A `/verdict` replaces the one the factory recorded for the PR's head.
6. If the PR stops merging cleanly and the factory cannot update it (the PR is marked `sf: needs human` with a conflict comment), reply `/resolve [notes]` on the issue or on the PR. An agent resolves the conflict, and the factory pushes only if the changed files stay within the conflicting files and the allowed paths and `repo.install_command` / `repo.test_command` pass. The PR then goes through review again. If the resolve fails, it comments why; you can send `/resolve` again. Anything after `/resolve` (same line or below) is passed to the agent as notes. When the resolve needs a file outside the conflicting files and the allowed paths (say, a test that imports a file the PR moved), start the reply with `/resolve +paths <path>...`: those paths are added to the allowed paths, and the lines below are the notes.

Only users with write permission on the repository can approve, reject, revise, retry, resolve, answer a budget checkpoint or record a verdict.
The factory reacts 👀 to each command it handled and to each issue it took in; if it refused a command, it replies saying why.

### Commands

A command is the first line of a comment: `/` and the command name (any case), then a space, the end of the line, or one of `.,:;!?`. Every comment where the factory waits for you ends with the commands that apply at that point. `/help` replies with the full list, marking those. A mistyped command (say `/aprove`) gets one reply naming it, with the commands that apply now. On an issue that is not a factory work item, commands get no reaction and no reply.

| Command | What it does | Applies when |
|---|---|---|
| `/approve [notes]` | Approve the spec, the floor block or a run held for a person by the Rule of Two, or start an implement run held by coordination cost now (not one waiting for a dependency). Notes on the same line or below go to the implementer and the reviewer. `/approve +paths <path>...` (at most 10, notes on the lines below) on the spec or the floor block also adds those paths to the allowed paths | spec waiting for approval, spec at the revision limit, blocked by the floor check, waiting for a person to approve its run (Rule of Two) |
| `/reject <reason>` | Close the item without a merge, giving your reason | spec waiting for approval, spec at the revision limit, blocked by the floor check, waiting for a person to approve its run (Rule of Two), paused at a budget checkpoint, blocked: the change was too large, blocked by a failed implement run, blocked: the agent asked for a human, blocked: a run failed the same way twice, review loop limit reached |
| `/revise <feedback>` | Get a new spec written with your feedback. On the PR: send your feedback to the implementer, who pushes a fix to the PR branch; a review runs after it | spec waiting for approval, blocked: the change was too large, blocked by a failed implement run, blocked: the agent asked for a human, blocked: a run failed the same way twice, review loop limit reached; on its PR: waiting for a human merge, blocked by a failed review run |
| `/retry` | Run the failed run again. Notes on the same line or below go to the implementer and the reviewer. `/retry +paths <path>...` (at most 10, notes on the lines below) after a failed implement run also adds those paths to the allowed paths. At a dependency closed without a merge, it reads the dependencies again and starts the implement run if none is still closed. At the review loop limit, it starts an implement run with the loop count reset; `+paths` applies there too | blocked by a failed run, blocked by a failed review run, blocked: the change was too large, blocked by a failed implement run, blocked: the agent asked for a human, blocked: a run failed the same way twice, blocked: a dependency was closed without a merge, review loop limit reached |
| `/resolve [notes]` | Let an agent resolve the PR's merge conflict; notes go to the agent. `/resolve +paths <path>...` (at most 10, notes on the lines below) also adds those paths to the allowed paths | PR has a merge conflict, blocked: the agent asked for a human |
| `/budget [tokens]` | Continue past the budget checkpoint with the suggested budget, or with a larger whole number of tokens | paused at a budget checkpoint |
| `/verdict accept\|changes\|reject <severity> <reason>` | Record a verdict on the result, also after the merge; it does not change the state. `/verdict accept` alone (or `yes`, `ok`) records severity `none`; it replaces the verdict the factory recorded for the PR's head from a merge or a push | any open or merged item, once it has a PR |
| `/standing [accept\|decline <rule>]` | Show the standing-approval rules, or turn one on or off. `/standing accept spec-t1` lets tier 1 specs that wait at the spec gate be approved without a reply; `/standing decline spec-t1` turns it off or declines its proposal. A `/revise` or `/reject` on an item the rule approved also turns it off | any time |
| `/link <code>` | Link the account you post from to a factory user, with a code from `factory link-code <user_id>` | any time |
| `/help` | List every command and which ones apply now | any time |

Approval and `/retry` notes are untrusted text: they are capped at 2000 characters and checked by the leak scanner before they are stored. Feedback on a PR (`/revise` there, or a "Request changes" review) is handled the same way, capped at 8000 characters. A note the scanner blocks refuses the approval with a reply; post `/approve` again without it. `+paths` (on the first line, right after `/approve` or `/retry`) takes up to 10 repo-relative paths with no `..` and no glob, and adds the ones the allowed paths do not cover yet; a path under a floor raises the item's tier to that floor's. When a run stops on files outside the allowed paths, its comment gives the exact `/retry +paths ...` reply. Generated from `src/core/commands.ts`; a test fails when this table differs.

Who may act is decided by the grant plugins in `permissions.grants` (default: write access on the repository; docs/plugins.md, GrantSource). To act from another account as the same factory user (your GitHub user is `github:<numeric id>`), run `npm run --silent factory -- link-code github:<id>` and post the printed `/link <code>` as a comment on any issue from the other account. The code works once, for 10 minutes, and 5 wrong codes lock it. `/link` is the one command read on any issue, work item or not; it is never listed in an item's footer.

If you have write permission and reply in plain words on an open work item's issue (300 characters or fewer, say "ship it"), the factory may answer once with the command it thinks you mean, such as `/approve`, or with the commands that apply now. It uses a cheap model call to do this. Nothing runs and nothing changes until you type the command yourself as a reply; that command is checked like any other.

### Local tasks from the command line

Work items can also come from your terminal instead of a GitHub issue. Add `"local"` to `plugins.source` (e.g. `"source": ["github-issues", "local"]`). Run the commands as `npm run --silent factory -- <command>`. None of them calls GitHub, and they work the same whether GitHub is selected, unreachable or rate limited.

Who you are: `cli_user` in `factory.config.json` if you set it (optional), else `local:<git user.email>`, else `local:<OS user name>`, else `local:anonymous`. The local UI uses the same identity. Git's `user.name` is never your ID: it is only the default of the display name `npm run setup` (or `npm run setup -- --me`) stores once against your ID; `factory users list` shows it next to the ID.

Who may act: local commands (the CLI and the local UI) are checked by the local auth plugin, never by GitHub's. GitHub comments are still checked by the `auth` plugin for GitHub. The first identity to run a writing command (`task create`, `approve`, `retry`, `revise`, `reject`, `users add`/`remove`) becomes the local **owner**.

| | Solo (default, zero setup) | Team (many developers on one shared store) |
|---|---|---|
| Config | Nothing to add: `"auth": "github"` (or any string) keeps GitHub comments on GitHub's check, and local commands use `local` | The same. To name both explicitly: `"auth": { "github_issue": "github", "local": "local" }` |
| Setup | None needed: you become the owner on your first writing command, or at `npm run setup` | The first person becomes the owner. Each later person runs `npm run setup -- --me` (ID and display name only) and has no role until the owner runs `factory users add <user_id> --role approver` |
| May approve, retry, revise, reject, resolve | The owner | The owner and every `approver` |
| May create, list and show | Everyone, `anonymous` included | Everyone, `anonymous` included |
| `anonymous` | Read and create only: never the owner, never an approver | The same |

A `permissions.static.deny` still refuses a local user. On a shared store the identity comes from each person's environment (git config, OS user), so anyone who can run the CLI against the store can set it: the store's credentials are the trust boundary.

- `factory task create --title <t> --body-file <f>`: Create a work item from a title and a body; in chat, a mention with any other words, outside an item's thread, is the request. Who: anyone who may submit work. Prints: the new work item's ID.
- `factory task list`: List local work items. Who: anyone. Prints: one line per local work item: ID, title, stage and blocked reason.
- `factory task show <id>`: Show one work item. Who: anyone. Prints: its state, spec, sub-tasks, runs and stored messages.
- `factory approve <id> [notes]`: Store `/approve` for the item. Who: the owner and approvers. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory retry <id> [text]`: Store `/retry` for the item. Who: the owner and approvers. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory revise <id> <feedback>`: Store `/revise` for the item. Who: the owner and approvers. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory reject <id> <reason>`: Store `/reject` for the item. Who: the owner and approvers. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory resolve <id> [notes]`: Store `/resolve` for the item. Who: the owner and approvers. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory merge <id>`: Merge a local item's branch into the local base branch once its review passed (no push; in auto mode the controller may merge it itself). Who: the owner and approvers (approve_merge). Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory users list`: List local users. Who: anyone. Prints: your identity and every local user with its role (owner, approver, requester).
- `factory users add <user_id> --role approver|requester`: Give a local user a role, e.g. `local:dev@example.com`. Who: the local owner. Prints: the user's new role.
- `factory users remove <user_id>`: Remove a local user's role. Who: the local owner. Prints: whether a role was removed.
- `factory settings list`: List every settable key. Who: anyone. Prints: each key's effective value and its source (override, file, default).
- `factory settings set <key> <value> [--project <owner/name>]`: Store an override; `<value>` is JSON. `mode`, `auto_merge_max_tier` and a change that loosens a tighten-only key need approve_merge. Who: anyone. Prints: the key's new and old value with their sources, and when it applies.
- `factory settings reset <key> [--project <owner/name>]`: Remove an override, so the file value (else the default) applies again; the same approve_merge rule as `settings set`. Who: anyone. Prints: the key's new and old value with their sources, and when it applies.
- `factory settings history [--limit <n>]`: Show the settings audit. Who: anyone. Prints: every set and reset, newest first (default 50).
- `factory mode auto|manual [--project <owner/name>]`: The same as `settings set mode <auto|manual>`. Who: the owner and approvers (approve_merge). Prints: the mode's new and old value.

`task create` takes the item in and queues its triage run; the store must already know the configured repo, so start the factory once first. `approve`, `retry`, `revise`, `reject` and `resolve` work for any work item, a GitHub one included, and only store the command in the command log; the controller reads it on its next poll and applies it with the local auth plugin's check, so a local owner or approver needs no GitHub write access. For a GitHub item the factory also posts one comment on the issue saying who sent which command. That mirror is best effort: while GitHub is down or rate limited the command still applies, and the comment is posted on a later tick. Its replies (the spec, refusals, failures) are stored as the item's messages: read them with `task show`. A refusal names the `factory users add` command the owner can run. `merge` is stored the same way; the controller merges the item's local branch `factory/<id>` into your local base branch with a merge commit, writing no checkout and pushing nothing, and closes the item. It needs the approver role (the owner has it), applies only to a local item waiting for a merge, and refuses while the base branch is checked out in a worktree (switch that checkout to another branch first) or when the branch conflicts (the reply lists the files). Generated from the command table, `src/core/command-table.ts`; a test fails when this list differs.

With no GitHub plugin selected (the solo default below) nothing ever reaches GitHub: `"auth": "local"`, `"permissions": { "grants": ["static"] }` and `"plugins": { …, "source": ["local"], "broker": "local" }`. Then the factory reads no GitHub credential, fetches no origin, opens no PR, and every item ends with `factory merge` (design `docs/design/05-sources.md`, Local startup).

### Status labels

Each work item's issue carries exactly one status label, and so does its PR once there is one. The factory sets it on every change of state, and again for every open item when it starts. Names are `status_label_prefix` (in `factory.config.json`, default `sf: `) plus the name below. The factory creates a missing one on first use; `doctor` only warns about a missing one.

| Label | Meaning |
|---|---|
| `sf: triaging` | Taken in; the triage agent is writing the spec |
| `sf: needs approval` | The spec is posted; reply `/approve`, `/reject <reason>`, or `/revise <feedback>` |
| `sf: implementing` | The implementer agent is working on the branch |
| `sf: in review` | The PR is open and the reviewer agent is checking it |
| `sf: ready to merge` | The PR passed review; a human merges it |
| `sf: needs human` | Stuck: a run failed (reply `/retry`), review hit the loop limit, the PR has a conflict, or the item reached its token budget (reply `/budget`, `/budget <tokens>` or `/reject <reason>`). The comments say which. For now it also shows while a reviewed PR waits for its checks; nothing is needed from you then |
| `sf: done` | The PR was merged |
| `sf: rejected` | Closed without a merge: spec rejected, or PR closed unmerged |

The factory removes only these eight names (under the current prefix) when it changes the status. Other labels, including your own labels that start with `sf: `, are never touched. Changing a label by hand does nothing; the factory does not read them.

### Several items at once

By default the factory builds one item at a time. To build several in parallel, set `workers` in `factory.config.json`, e.g. `"workers": 3`, and restart `npm run factory -- dev` (or `worker`). It must be a whole number of 1 or more; anything else stops startup with an error. Absent means 1.

To change the count while the factory runs, without a PR, set `max_workers` in the file once (a whole number of at least `workers`; absent means `workers`), then use `npm run factory -- settings set workers <n>` with any n from 1 to `max_workers`. The pool starts or stops worker loops on its next tick; a stopped loop finishes its current run first. `npm run factory -- settings reset workers` goes back to the file's `workers`.

To let the phases of a split you approved run without an `/approve` each, run `npm run factory -- settings set phases_auto_approve true` (`settings reset phases_auto_approve` turns it off again).

Items whose allowed paths overlap still wait for each other, so their PRs do not conflict; triage and review never wait. Each worker passes its number (0, 1, 2, …) to the agent and to the update test command as `SF_WORKER_INDEX`. If your tests start a server or use a database, use it to pick a port or database name per worker so parallel runs do not collide, e.g. `PORT=$((3000 + SF_WORKER_INDEX))`. The number is unique only inside one process: two factory processes on one machine both have a worker 0.

Unknown config keys are rejected at load: a typo in `factory.config.json` (for example `"plugin"` or a `"hots"` in `store`) stops every command with an error that names the key, lists the valid keys and suggests the closest one; `doctor` shows each as a FAIL line.

### Auto mode (`factory mode`)

By default the factory is in **manual** mode: a person approves every spec and merges every change. In **auto** mode it approves a spec itself when the spec is below tier 4, touches no path on the gate list (prompts, gates, permissions, tools, guard settings) and every decision has a proposed default that is not owner-only; it posts the answers it took in the thread. It also merges a reviewed local change itself, through the same local merge as `factory merge` (the checks run on the merge commit first), when the change is below tier 4, off the gate list, complete, and at or under the auto-merge tier. GitHub items are never merged automatically.

- `npm run factory -- mode auto` (or `manual`; `--project <owner/name>` for one project): the same as `settings set mode`. One audit row names who flipped it and when; running factories pick it up at their next tick.
- `npm run factory -- settings set auto_merge_max_tier <0-3>`: the highest tier auto mode merges at. The default 0 merges nothing, so raise it to let auto mode merge. 4 or more is refused.

Both need `approve_merge` on the project: solo, the local owner (you, after your first writing command) has it with no setup; on a team, an approver or the owner. The Settings page and the dashboard's top bar show the mode with a switch, and the auto-merge tier next to it. A failing check on the base branch after an automatic merge, a failure alarm or a budget checkpoint sets the mode back to manual, with one alarm in Needs you and one audit row by `system:auto`.

### Your own LLM session (`factory session`)

Work you do with an LLM in your own terminal can go through the factory too, as one `interactive` run on the work item: a lease, your user ID as its actor, your token count and notes, and a worker's gates before anything is pushed. A worker never claims an implement or update run whose item overlaps your open session, and a session does not start over a running one.

```bash
npm run --silent factory -- session start 12 [--spec spec.json] [--transcript <url>] [--as <github login>]   # issue #12 or a wi_… id
npm run --silent factory -- session status | note "<text>" [--tokens <n>] [--transcript <url>] | finish [--tokens <n>] | abandon [--tokens <n>]
```

- `start` creates the work item if the issue has none (only with `--spec`), records the run, makes a run folder on the item's branch and prints its path: work and commit there. It stays in the foreground and keeps the lease; Ctrl-C stops it, the lease expires, the reaper ends the run (`session_lost`) and the item is released. `--spec <file>`: your own spec for a NEW item, in the triage output format (checked by the same parser; no phases); the queued triage run is cancelled. `--transcript <url>`: an http or https link, stored after the leak scan. `--as <login>`: your GitHub login (default `repo.owner`), mapped to your user ID as for commands; you need write permission. Refused, with nothing changed, for an item that is closed, in review, waiting for `/approve`, without allowed paths, with a queued or running implement or update run or an open session, or overlapping another item's running implement run.
- `status` prints the item, the run, the lease expiry and the last `finish` result. `note <text>` stores a note after the leak scan (a flagged note is refused with the rule name). `--tokens <n>` (a whole number of 0 or more, on `note`, `finish`, `abandon`) sets your latest total, added to the item's `token_cost` once when the run ends.
- `finish` runs the scope gate, the size gate (the same `max_diff_lines` and `max_diff_files` as a worker), the floor check and `repo.test_command` in the run folder. Any failure lists the reasons, keeps the session open and pushes nothing; a floor hit is refused (a session cannot raise the tier). When all pass, the factory's broker pushes the branch and opens the PR, and the item goes to review; running `finish` again never opens a second PR or review.
- `abandon` ends the run as failed (`abandoned`); the pushed branch and the run folder are kept. A session that ended without a PR leaves the item `RUNNING`, blocked on you with `session_released`, nothing queued; `session start` takes it up again.
- With no work item id first, `status`, `note`, `finish` and `abandon` use the only open session on this machine (recorded under `<state_dir>/sessions/`).

Your LLM runs as you, with your access, outside the factory's sandbox; the gates at `finish` are the factory's check. A `git push` you run yourself bypasses them.

### Per-project settings

Five settings are gates that can differ per project: `max_attempts`, `max_diff_lines`, `max_diff_files`, `budgets` and `floors`. Put the global values either at top level (as the checked-in config does) or in `defaults`, not both: the same key in both places stops startup. Then tighten them for one project under `projects`, keyed by the configured repo's `owner/name`:

```json
{
  "repo": { "owner": "acme", "name": "shop", "path": ".", "base_branch": "main" },
  "defaults": {
    "max_attempts": 3,
    "max_diff_lines": 1500,
    "max_diff_files": 40,
    "budgets": { "2": 2000000 },
    "floors": [{ "prefix": "prompts/", "tier": 3 }]
  },
  "projects": {
    "acme/shop": {
      "max_diff_lines": 800,
      "budgets": { "2": 1000000 },
      "floors": [{ "prefix": "prompts/", "tier": 4 }, { "prefix": "migrations/", "tier": 3 }]
    }
  }
}
```

(The other keys of `factory.config.json` are left out of the example.) A project can only tighten: a number or budget above the global value, a global budget tier left out, or a global floor left out or lowered stops startup with an error naming the project and the key. A project block takes no other keys; `repo`, `dials`, `plugins` and the rest stay global. A project ID other than the configured repo's stops startup too. `npm run factory -- doctor` and the status page's Health panel list each setting's effective value and where it came from: `project`, `defaults` (top level or `defaults`), `built-in`, or `learned` (nothing writes learned values yet).

### Path companions

Some files always change together: a store schema change needs a MySQL migration step, and a design decision lives in a topic file beside its index. Declare these in `factory.config.json` under the optional top-level key `path_companions`, so a triage spec that names one file also allows the others:

```json
"path_companions": [
  { "when": "src/impl/store/sqlite/schema.ts", "also": ["migrations/mysql/", "src/impl/store/mysql/migrations.ts"] },
  { "when": "docs/design.md", "also": ["docs/design/"] }
]
```

- **Format.** A list of entries. Each has `when`, one repo-relative path, and `also`, a non-empty list of repo-relative paths. A path ending in `/` names a folder. No other key is allowed in an entry. A bad shape stops startup with a message naming the key and the entry index (`path_companions[1].also must be ...`). Without the key there are no companions.
- **How `when` matches.** Only the spec's `files_to_change` (the files triage expects to change) is matched, not `allowed_paths`. A path matches when it equals `when`, sits under a `when` folder, or is a folder that `when` sits under.
- **What gets added.** Each `also` path goes into the spec's `allowed_paths`, unless an allowed path already covers it. This happens on triage's answer before it is checked, so a companion triage lists in `files_to_change` but forgot in `allowed_paths` is accepted. It also happens before the tier floor, so an added path under a floor raises the tier. Built in, whatever the config: naming `docs/design.md` or `docs/plugins.md` in either list adds `docs/design/` or `docs/plugins/`; the index stays allowed. A split spec's phases are left alone: each phase's own triage adds its companions.
- **The spec line.** The spec comment's Files section lists each added path under "Added by `path_companions`", with the path that caused it: ``- `migrations/mysql/`: added because the spec names `src/impl/store/sqlite/schema.ts` ``. A spec that matches nothing reads exactly as triage wrote it.

The checked-in config declares both store schemas (SQLite and MySQL) and both doc indexes. Changing `path_companions` changes `factory.config.json`, which is under a floor, so it needs a human merge.

### CI and branch protection

`.github/workflows/test.yml` runs on every pull request and every push to `main`. Job `test`: `npm ci`, `npm run typecheck`, `npm test`. Job `test-mysql`: starts a `mysql:8` service and runs `npm test` with `SF_TEST_MYSQL_URL` set, so the MySQL store tests run too. No secret is needed.

The factory waits for a PR's checks before it posts "A human merge is required": while any check runs, the item stays in review (`blocked_on: ci`, `checks_pending`) and the factory looks again every `poll_interval_ms`; a failed check sends the item back to implement; when every check passed it moves to `merge_pending`. A PR with no checks at all counts as passed.

Once, after the workflow has run at least once on GitHub, make the `test` check required so no PR can be merged with failing tests, by hand or by the factory:

1. GitHub → the repository → Settings → Branches (or Rules → Rulesets) → Add branch protection rule for `main`.
2. Turn on **Require status checks to pass before merging** and **Require branches to be up to date before merging**.
3. In the search box, add the status check `test` (and `test-mysql` if you want the MySQL tests required too).
4. Save.

### Checks before push

Before an implement run pushes, the worker runs `repo.check_commands` from `factory.config.json` (here `npm run typecheck`, then `npm test`; the same commands as the workflow's `run:` steps, and a test fails if the two drift). A failure gets one fix step; a second failure stops the run with `checks_failed` and a comment naming the command. The update and resolve runs run the same list. Without a test database (`"plugins": { "test_database": "none" }`, the checked-in setting) the MySQL tests skip themselves before push and the PR body says so; CI's `test-mysql` job still runs them after the PR exists.

### Local test MySQL

To run the MySQL tests before push too, give the factory a test-only MySQL user and select the `mysql-local` test database. Use a server that holds no factory data if you can (a second local instance on another port is best); at least, use a user that can touch nothing but `sf_test_*` databases.

1. Create the user and its grants (as the MySQL admin, e.g. `mysql -u root -p`), with a password of your own:

   ```sql
   CREATE USER 'sf_test'@'localhost' IDENTIFIED BY '<a new password>';
   GRANT ALL PRIVILEGES ON `sf\_test\_%`.* TO 'sf_test'@'localhost';
   ```

   Those are the only grants: the user may create, use and drop databases whose names start with `sf_test_`, and nothing else. It has no access to `software_factory` or any other database, no `GRANT OPTION`, and no global privileges. The pattern needs the backslashes: an unescaped `_` matches any character.
   What the MySQL suite needs, by test:

   | Grant | Needed by | Without it |
   |---|---|---|
   | `ALL` on ``sf\_test\_%``.* (the grant above) | every MySQL test: each makes and drops its own `sf_test_*` database | the MySQL tests fail |
   | Global `CREATE USER` with `GRANT OPTION` (an admin such as CI's `root`; never give it to `sf_test`) | only "dev, worker, controller, status, ui and golden add exit non-zero…" in `tests/mysql-migrations.test.ts`, which makes a throwaway `sf_e2e_*` user | the test checks first, creates nothing and skips, with a message naming `CREATE USER`, the test user and this file; CI's `test-mysql` job (root) still runs it |

2. Put its admin URL in the secret file, outside the repository (`~/.config/software-factory/.env`, mode 600; never in `factory.config.json` or any file in the repository):

   ```sh
   TEST_MYSQL_URL=mysql://sf_test:<password>@127.0.0.1:3306
   ```

   URL-encode the password if it has `@`, `:` or `/`.
3. Select the plugin in `factory.config.json`: `"plugins": { ..., "test_database": "mysql-local" }`. With `mysql-local` selected and `TEST_MYSQL_URL` missing, the factory refuses to start.
4. Restart the factory. Each run that runs checks then creates `sf_test_<run id>`, passes `SF_TEST_MYSQL_URL=mysql://sf_test:<password>@127.0.0.1:3306/sf_test_<run id>` to the check commands only (never to an agent), and drops the database when the run ends. The tests make their own `sf_test_*` databases with the same user.

What it exposes: the check commands run code the agent wrote, with `SF_TEST_MYSQL_URL` in their environment, so that code can read this user's password while the checks run. That is why the user gets only the grants above. A run that crashes before it finishes can leave an `sf_test_*` database behind; nothing sweeps them yet. List them with `SHOW DATABASES LIKE 'sf\_test\_%';` and drop them by hand.

For `npm run test:mysql` on your own machine, the same URL can go in `.factory/test-mysql.url` (ignored by git).

## Run the factory on your project

The checked-in `factory.config.json` is this repository's own config. To point the factory at another repository, keep your config outside the factory checkout, so `dev`'s updater (which runs `origin/<base_branch>`) never replaces it:

1. Make a folder for it, e.g. `~/factory/my-app/`, and copy `factory.config.json` into it.
2. Edit at least `repo.owner`, `repo.name`, `repo.path` (your project's checkout; relative paths resolve from the folder you start the factory in), `repo.base_branch`, `repo.test_command` / `repo.check_commands`, `floors` and `store`. For one machine, `"store": { "type": "sqlite" }` needs no database.
3. Check it: `npm run factory -- doctor --config ~/factory/my-app/factory.config.json`. The first line names the config file in use.
4. Start: `npm run factory -- dev --config ~/factory/my-app/factory.config.json` (or `export FACTORY_CONFIG=…`; `--config` wins when both are set). Every command takes the flag.

With `--config` or `FACTORY_CONFIG`, `state_dir` and `worktrees_dir` resolve from the config file's folder (`~/factory/my-app/.factory`, `~/factory/my-app/.worktrees`); without them they stay under the folder you start in. Prompts still come from the factory checkout, and the secret file stays at `~/.config/software-factory/.env`. Solo use (SQLite) may set any key; on a shared MySQL store, `dials`, `floors`, `plugins`, `permissions` and `auth` always come from the checked-in file. Details: [`docs/plugins/selection.md`](docs/plugins/selection.md).

## Routine

| When | Command |
|---|---|
| Check that everything still works | `npm run factory -- doctor` |
| Check that the configured LLM provider answers (two small real calls) | `npm run factory -- llm-check` (or `doctor --llm`) |
| GitHub token expired or about to | `npm run setup -- --rotate-github` |
| Claude token replaced | `npm run setup -- --rotate-claude` |
| New MySQL password for the factory user | `npm run setup -- --rotate-mysql` |
| MySQL: after setup creates the database, and after an update that adds a file in `migrations/mysql/` (the factory refuses to start until then; back up first). Works while `factory dev` runs: the status page says the update waits for it; `migrate` drains the factory first, applies the steps, then the new revision starts. It drains only `factory dev`: stop any `factory controller` or `factory worker` you started yourself before you migrate, so no old process writes meanwhile. Set `"updater": { "auto_migrate": true }` in `factory.config.json` to have the factory do this by itself | `npm run migrate` |
| MySQL: see the schema state and the pending steps | `npm run migrate -- --status` |
| MySQL: see what `npm run migrate` would run, changing nothing | `npm run migrate -- --dry-run` |
| See work items / one item's history | `npm run factory -- status` / `npm run factory -- status <id>` |
| Watch the factory in a browser (read-only) | `make ui` (or `npm run factory -- ui`), then open <http://127.0.0.1:4310/> (the app; the older page is at `/classic`) |
| File or tidy an issue as the factory (the bot with `app`) | `npm run factory -- issue create --title <t> --body-file <f> [--label <l>]...`, `issue comment <n> --body-file <f>`, `issue edit <n> --body-file <f>`, `issue title <n> <text>`, `issue sub-issue <parent> <child>` |
| Suspect a leak | Revoke the token on GitHub first (or the App's key), then rotate |

### Status page

`npm run factory -- dev` serves the factory app at <http://127.0.0.1:4310/> (under the checked-in `git-worktree` updater it runs the page as a child and swaps it on each new revision; with `plugins.updater: none`, start it yourself with `npm run factory -- ui`). It redirects to `/app/`; the port is `ui.port` in `factory.config.json`. Pages: Floor (what needs you, what runs, the queue), Work items with a page per item, Workers, Queue, Health, Failures, Settings (the mode switch and runtime settings), Users (user IDs and roles, the local owner only) and Data. The older server-rendered page described below is at <http://127.0.0.1:4310/classic>. The top shows what the factory process is doing, what runs now, the queue and any paused runs. Then comes one list of work items, most urgent first, each with a short reason badge; items that wait for you also say what to do next (a link to the exact comment or PR and the command to type there). Health, totals and cost come last; `/items/<id>` shows one item's timeline and runs. It updates itself every 5 seconds without losing your scroll, open details or search text, pauses while the tab is hidden, and has a Refresh link when JavaScript is off. Each item page lists the commands that apply to it now and a Merge button once its review passed (a local change through the merge queue, a PR at its reviewed head). It listens on 127.0.0.1 only and answers only requests whose Host is `127.0.0.1` or `localhost`. It starts no controller or worker, so run it beside `npm run factory -- dev`. It reads the secret file like the other commands (the MySQL password, and known secret values for the egress scan); a field that looks like a secret shows `[withheld: <rule>]` instead of its text, and search can't find it.

**Commands from the page.** The page sends item commands as the same user the CLI uses on this machine (`cli_user`, else your git `user.email`, else your OS login), with no setup; the item page shows "Acting as <user>". To act as another user, set `ui.user_id` in `factory.config.json` to a factory user ID (the ID the factory knows you by, e.g. `github:<numeric id>`; never a display name), and restart `npm run factory -- ui`:

```json
"ui": { "port": 4310, "user_id": "github:12345" }
```

Every command sent from the page acts as that user, with that user's permissions: the controller runs the same permission check as for a comment from that user, and refuses (with a reply on the issue and in the item's replies) what that user may not do. Anyone who can open the page on this machine acts as that user, so set it only on a machine you alone use. A server not bound to loopback would need `ui.user_id` (the endpoint answers 503 without it); today the server binds only 127.0.0.1. An empty or non-string value stops startup with an error naming `ui.user_id`. The checked-in config does not set it; keep your own ID out of the repository. The page sends the item commands (`approve`, `reject`, `revise`, `retry`, `verdict`, `resolve` and the others the item allows) and `merge`; `help` and `link` stay in the thread.

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

### Slack (optional: real-time threads)

Off by default; nothing changes until you turn it on. Once on, mentioning the bot in a listed channel starts a work item from that thread, and the factory answers in the thread with the spec, status and buttons. PRs and code stay on GitHub.

One-time Slack app setup, details in [`docs/slack-setup.md`](docs/slack-setup.md) (mostly `scripts/slack-app.sh create|tokens|check`):

1. **The app, from the manifest** ([`slack/manifest.json`](slack/manifest.json)): Socket Mode on (no public URL or open port), interactivity on (for the buttons), bot scopes `app_mentions:read`, `channels:history`, `chat:write`, `im:write`, `reactions:write`, events `app_mention` and `message.channels`.
2. **The tokens go in the secret file** (`~/.config/software-factory/.env`, never in the repository), through `scripts/slack-app.sh tokens`:
   - `SLACK_BOT_TOKEN` (`xoxb-…`, OAuth & Permissions page): reads threads and posts in them.
   - `SLACK_APP_TOKEN` (`xapp-…`, Basic Information → App-Level Tokens, scope `connections:write`): opens the Socket Mode connection.
3. **The channel:** `/invite @software-factory` in the channel, then copy its ID (channel details, bottom of the **About** tab, `C…`). Use the ID, not the name.
4. **Turn it on** in `factory.config.json`, then restart the factory:

   ```json
   "slack": { "channels": ["C0123456789"] },
   "plugins": { "source": ["github-issues", "local", "slack"] }
   ```

5. **Link your Slack account** to your factory user (a Slack account has no rights until it is linked; then it acts as that user, with that user's stored role): run `factory link-code <your factory user ID>` (solo: the local owner, e.g. `local:you@example.com`; `factory users list` shows it), then post `@software-factory /link <code>` in the channel.

Known gaps (2026-11-09; issues #479–#486): people's Slack replies are not shown on the item page, `/revise` on a PR is refused from Slack, commands get no 👀 reaction, and private channels (`G…`) do not work yet.

In Slack, a message that starts with `/` is taken by Slack itself, so type commands after a mention (`@software-factory /revise <feedback>`) or use the buttons.

The factory's commands in Slack, from the same command table as the CLI (`@bot` is the mention of the bot). Each runs as the factory user the Slack account is linked to, with that user's stored role; an unlinked account gets one reply saying so, and only `/link` and `help` are answered for it. `list`, `show`, `users list` and `settings` reads reply with what the CLI prints, cut to Slack's limits with a note naming the CLI command that prints the whole text and, for `show <id>`, a link to the item's source. Item commands and `merge` store the CLI's command row, and the controller answers in the item's thread. `help` lists only the commands you may run where you ask it. A mention with any other words is a request in plain words: outside an item's thread it starts a work item, in an item's thread the factory suggests a command.

- `@bot <request in plain words>`: as `factory task create --title <t> --body-file <f>`. Who: anyone who may submit work.
- `@bot list`: as `factory task list`. Who: anyone.
- `@bot show <id>`: as `factory task show <id>`. Who: anyone.
- `@bot /approve [notes]`: as `factory approve <id> [notes]`, in the item's thread. Who: the owner and approvers.
- `@bot /retry [text]`: as `factory retry <id> [text]`, in the item's thread. Who: the owner and approvers.
- `@bot /revise <feedback>`: as `factory revise <id> <feedback>`, in the item's thread. Who: the owner and approvers.
- `@bot /reject <reason>`: as `factory reject <id> <reason>`, in the item's thread. Who: the owner and approvers.
- `@bot /resolve [notes]`: as `factory resolve <id> [notes]`, in the item's thread. Who: the owner and approvers.
- `@bot merge`: as `factory merge <id>`, in the item's thread. Who: the owner and approvers (approve_merge).
- `@bot users list`: as `factory users list`. Who: anyone.
- `@bot users add <user_id> --role approver|requester`: as `factory users add <user_id> --role approver|requester`; refused in chat until #479, so use the CLI. Who: the local owner.
- `@bot users remove <user_id>`: as `factory users remove <user_id>`; refused in chat until #479, so use the CLI. Who: the local owner.
- `@bot settings list`: as `factory settings list`. Who: anyone.
- `@bot settings set <key> <value> [--project <owner/name>]`: as `factory settings set <key> <value> [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: anyone.
- `@bot settings reset <key> [--project <owner/name>]`: as `factory settings reset <key> [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: anyone.
- `@bot settings history [--limit <n>]`: as `factory settings history [--limit <n>]`. Who: anyone.
- `@bot mode auto|manual [--project <owner/name>]`: as `factory mode auto|manual [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: the owner and approvers (approve_merge).

To turn it off, drop `"slack"` from `plugins.source`. Several replicas: only one holds the Socket Mode connection at a time (the listener lease); `scripts/slack-app.sh check` reports one more connection while the factory runs.

Why the secret file lives where it does, and how each guard works: [`docs/setup.md`](docs/setup.md), [`docs/architecture.md` §5](docs/architecture.md#5-secret-isolation).

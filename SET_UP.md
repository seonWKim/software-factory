# Set up

What to do once before the factory can take work. One command does most of it:

```bash
npm run setup
```

It is safe to run again: every question shows its default (your current choice) and Enter takes it, and it skips what is already done. Two steps need you in a browser; the command stops and tells you when.

Every step looks the same: its number and title, one line on why, its question with the default, then a `✓` (done) or `✗` (not done, with what to do) line:

```
3. Secrets
   The credentials the selected plugins declare; each missing one is asked with hidden input and written only to the secret file.
   Needed: CLAUDE_CODE_OAUTH_TOKEN
   Paste CLAUDE_CODE_OAUTH_TOKEN now (hidden input)? [Y/n]
   ...
   ✓ saved CLAUDE_CODE_OAUTH_TOKEN
```

If a run stops (you press Ctrl-C, a check fails, the database is not ready), the next `npm run setup` says where it stopped and asks `Continue from step N? [yes] / start over`. Enter continues from that step; `start over` runs from step 1. Setup keeps this in `<state_dir>/setup-progress.json` (`.factory/setup-progress.json` by default): the names of the finished steps and your GitHub answer, never a secret. A setup that finishes with every step `✓` deletes the file.

- `npm run setup -- --yes` takes every default without reading the terminal (for scripts). A missing secret is reported on the Secrets step's `✗` line, not asked: paste it later with a plain `npm run setup` in a terminal.
- `npm run setup -- --rotate-github` (or `--rotate-claude`) replaces a stored credential.

## Start over: pull → teardown → setup

To reset this machine and set the factory up again from a clean state (after pulling a new version, or when a setup went wrong):

```bash
git pull
make teardown ARGS=--dry-run   # lists what it would remove, changes nothing
make teardown                  # asks you to type "teardown", then removes it
make setup
```

`make teardown` runs `npm run factory -- teardown`. It refuses while the factory runs on this machine; `ARGS=--stop` drains it first (in-flight runs finish), then continues. It removes the state folder (`.factory/`; a SQLite store is copied first to `~/.config/software-factory/backups/teardown-<time>/`, and the path is printed), the factory's run folders and version copies in `.worktrees/` and `.factory/versions/`, its `factory/*` branches already merged into the base branch, and its `refs/factory/*` refs. It keeps and lists everything else: your own folders in `.worktrees/`, a run folder or worktree with uncommitted changes, unmerged branches, branches checked out somewhere. Nothing is forced. A second run says there is nothing to delete.

It never removes `factory.config.json`, the secret file (unless `ARGS=--secrets`, which asks again and removes only the factory's own entries), GitHub issues or pull requests, the GitHub App, or the Slack app; it prints where to remove each by hand. Decisions: [`docs/design/08-teardown.md`](docs/design/08-teardown.md).

## Before you start

- Node.js 22 (the major CI runs; `.nvmrc`), 22.13 or newer, and git
- Claude Code installed (`claude --version`)
- A Claude Pro / Max / Team / Enterprise plan
- With GitHub sync on: write access to the GitHub repository the factory works on (set in `factory.config.json`, default `seonWKim/software-factory`)
- `ANTHROPIC_API_KEY` **not** set in your shell. If it is, it overrides the subscription token: `unset ANTHROPIC_API_KEY`

## What `npm run setup` does

| Step | Automated | You do |
|---|---|---|
| 1. Plugins | Asks whether to sync with GitHub and whether to take work from Slack threads (then the channel IDs). Shows the change to `factory.config.json` as a `-`/`+` diff and writes it when you say yes; only the changed keys (`plugins`, `slack`) change. Local only (the default on a new file) selects no GitHub plugin. If you answer no to GitHub and decline the diff, setup still asks for no GitHub secret and checks none | Answer, then confirm the diff |
| 2. Secret file | Creates `~/.config/software-factory/.env` (folder `700`, file `600`), outside the repository, with an empty line for each secret the selected plugins need | Press Enter |
| 3. Secrets | Lists the secrets the selected plugins need, then asks for each missing one with hidden input and writes it to the secret file. The model credential is `CLAUDE_CODE_OAUTH_TOKEN`; with GitHub on, `GITHUB_APP_ID` (App) or `GITHUB_TOKEN` (token, with the settings below); with Slack on, its two tokens. With nothing missing it asks whether to replace one | For the model credential, run `claude setup-token` in a **separate, plain terminal**, sign in in the browser, copy the token it prints (shown once). Paste each at its prompt |
| 4. Database | Creates or updates the SQLite store under the state folder (the only store) | Press Enter |
| 5. You | Asks your display name (prefilled from git `user.name`) and stores it once against your ID; makes you the local owner if there is none yet | Type your name or press Enter. Your ID stays `cli_user`, else `local:<git user.email>`, else `local:<OS user>` |
| 6. Mode | Asks `manual` or `auto` and `auto_merge_max_tier` (0 to 3; 0 merges nothing) and sets a changed one through `factory settings set`. Runtime settings, not file keys | Press Enter to keep the current ones |
| 7. Setup of the selected plugins | Creates the `factory` intake label and the eight status labels (below) on the repository; reports each as created, already exists, or could not create. Nothing to do with GitHub off | Press Enter |
| 8. Checks | Runs the `doctor` checks and marks each `✓`, `!` (warning) or `✗`: file permissions, credentials present, `ANTHROPIC_API_KEY` not set, claude CLI, push access, intake label; warns on a token that never expires and on each missing status label. Each `✗` line says how to fix it | Fix any `✗` line and rerun: setup continues from this step |
| 9. Canary | Asks, then runs a real agent told to find a planted fake secret. It must not find it | Answer `Y`. If it fails, **do not run the factory**: revoke the GitHub token |

Tokens never appear on screen, in shell history, in command arguments, or in the repository. Only the factory's own tools read the secret file; agents can't (guards G1–G6, `docs/architecture.md` §5).

### GitHub App (the bot; `plugins.github_auth: "app"`, the checked-in setting)

The factory acts on GitHub as your GitHub App, so issues, comments, pushes and PRs show the App's bot as author.

- Put the App's ID in the secret file as `GITHUB_APP_ID` (`npm run setup` asks for it) and its private key in `github-app.pem` next to the secret file (`~/.config/software-factory/`, mode 600).
- Install the App on the repository. **Repository permissions:** Contents, Issues and Pull requests: read and write; Actions: read and write (the CI gate reruns a PR's failed jobs once and reads a failed job's log); Metadata: read. Everything else: no access.
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
| Actions | Read and write (the CI gate reruns a PR head's failed jobs once, and reads the failed job's log after a second failure) |
| Metadata | Read-only (added automatically) |
| Everything else | No access |

`npm run setup` does not list Checks, Commit statuses and Actions yet; add them by hand. Without Checks and Commit statuses the factory cannot read a PR's checks, logs `reading PR checks failed`, and the PR waits in review. Without Actions it logs `rerunning failed CI jobs failed` or `reading the failed CI job's log failed`, and a failed check goes back to the implementer with the check names only.

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
5. To rate the result, comment `/verdict accept|changes|reject <severity> <reason>` on the issue or the PR, run `factory verdict <id> accept|changes|reject [<severity> <reason>]`, or use the item page's Accept, Changes and Reject buttons (the severity beside them, the reason in the note box). Severity is `none`, `minor`, `major` or `critical`; `accept` may leave out the severity (it is then `none`) and the reason, and `yes` or `ok` mean `accept`. A verdict is only recorded; it does not move the item. It needs a PR to exist (a local item needs none), still works after the merge, and is refused once the item is closed without a merge. With a forge, the factory also records verdicts on its own: an `accept` when a factory PR is merged with no commits by people, a `changes` when a person pushes to it, and a `reverted` when its merge is reverted. A `/verdict` replaces the one the factory recorded for the PR's head.
6. If the PR stops merging cleanly and the factory cannot update it (the PR is marked `sf: needs human` with a conflict comment), reply `/resolve [notes]` on the issue or on the PR. An agent resolves the conflict, and the factory pushes only if the changed files stay within the conflicting files and the allowed paths and `repo.install_command` / `repo.test_command` pass. The PR then goes through review again. If the resolve fails, it comments why; you can send `/resolve` again. Anything after `/resolve` (same line or below) is passed to the agent as notes. When the resolve needs a file outside the conflicting files and the allowed paths (say, a test that imports a file the PR moved), start the reply with `/resolve +paths <path>...`: those paths are added to the allowed paths, and the lines below are the notes. A resolve that failed because it changed such a file says so and gives the exact `/resolve +paths ...` reply for its files.

Only users with write permission on the repository can approve, reject, revise, retry, resolve, answer a budget checkpoint or record a verdict.
The factory reacts 👀 to each command it handled and to each issue it took in; if it refused a command, it replies saying why.

### Commands

A command is the first line of a comment: `/` and the command name (any case), then a space, the end of the line, or one of `.,:;!?`. Every comment where the factory waits for you ends with the commands that apply at that point. `/help` replies with the full list, marking those. A mistyped command (say `/aprove`) gets one reply naming it, with the commands that apply now. On an issue that is not a factory work item, commands get no reaction and no reply.

| Command | What it does | Applies when |
|---|---|---|
| `/approve [notes]` | Approve the spec, the floor block or a run held for a person by the Rule of Two, or start an implement run held by coordination cost now (not one waiting for a dependency). Notes on the same line or below go to the implementer and the reviewer. `/approve +paths <path>...` (at most 10, notes on the lines below) on the spec or the floor block also adds those paths to the allowed paths. Over the size cap (a change too large, or a spec at its size checkpoint), `/approve <why>` needs a note saying why and approves a one-time cap; the dashboard's Approve opens a dialog for that note | spec waiting for approval, spec at the revision limit, blocked by the floor check, waiting for a person to approve its run (Rule of Two), blocked: the change was too large |
| `/reject <reason>` | Close the item at any open phase without a merge, giving your reason; its queued and running runs are stopped. Not once its change is in the merge queue or merged: then it says why | any open item |
| `/revise <feedback>` | Get a new spec written with your feedback. While implementing: queue your feedback for one more implement run on the item's branch when the run ends, before review. On the PR: send your feedback to the implementer, who pushes a fix to the PR branch; a review runs after it. On a local item with no PR: send your feedback to the implementer, who commits a fix to the item's local branch; a review runs after it. On a New or in-triage item: add context (the dashboard's Add context), queued, so one more triage run reads the filed text and your text when the current one ends | triaging, spec waiting for approval, implementing, blocked: the change was too large, blocked by a failed implement run, blocked: the agent asked for a human, blocked: a run failed the same way twice, review loop limit reached; on a local item with no PR: waiting for a human merge; on its PR: waiting for a human merge, blocked by a failed review run |
| `/retry` | Run the failed run again. Notes on the same line or below go to the implementer and the reviewer. `/retry +paths <path>...` (at most 10, notes on the lines below) after a failed implement or resolve run also adds those paths to the allowed paths; a resolve run gets the notes without the `+paths` line. At a dependency closed without a merge, it reads the dependencies again and starts the implement run if none is still closed. At the review loop limit, it starts an implement run with the loop count reset; `+paths` applies there too. On an item held for a recurring failure, it lifts the hold so the item's queued runs start; with `+paths` after a failed implement run, it adds the paths and starts a fresh implement run from the kept work instead. On a held phase of a split, it releases the phase into triage once the previous phase closed without a merge. After an interactive session ended without a PR, it queues the implement run (which a new `interactive start` can take over); `+paths` applies there too | blocked by a failed run, blocked by a failed review run, blocked: the change was too large, blocked by a failed implement run, blocked: the agent asked for a human, blocked: a run failed the same way twice, blocked: a dependency was closed without a merge, review loop limit reached, held: its run failed like a known recurring failure, held: waiting for the previous phase of its split, released: its session ended without a PR |
| `/resolve [notes]` | Let an agent resolve the PR's merge conflict; notes go to the agent. `/resolve +paths <path>...` (at most 10, notes on the lines below) also adds those paths to the allowed paths | PR has a merge conflict, blocked: the agent asked for a human |
| `/paths +<path>...` | Add paths to the allowed paths of an item being implemented, in place: an interactive session's finish checks the new list, and a worker implement run takes it at its next attempt. At most 10, each with `+` before it, notes on the lines below. It never removes a path | implementing, blocked by a failed implement run, blocked: the change was too large, released: its session ended without a PR |
| `/hold <id>` | Hold until <id> merges: writes a `Depends on: <id>` line in the item's problem and queues the implement run, which waits for <id> (a local wi_… item or its short ID, or a built task tk_…) to merge and then starts on its own. Refused for an ID that names no local item, the item itself, or an item already merged. Also on a local item whose implement run is queued and not started (`factory hold <item> <id>`): it writes the line and the queued run waits the same way. While the run is running it is refused, and applies once the run ends | on a local item with no PR: blocked: the agent asked for a human |
| `/note <text>` | Add a note for the item's reviewer and implementer, such as the reason a done-when line is built differently; their next run shows it under the approver's notes. It changes no state | any open item |
| `/budget [tokens]` | Continue past the budget checkpoint with the suggested budget, or with a larger whole number of tokens | paused at a budget checkpoint |
| `/verdict accept\|changes\|reject <severity> <reason>` | Record a verdict on the result, also after the merge; it does not change the state. `/verdict accept` alone (or `yes`, `ok`) records severity `none`; it replaces the verdict the factory recorded for the PR's head from a merge or a push | any open or merged item, once it has a PR (a local item needs none) |
| `/standing [accept\|decline <rule>]` | Show the standing-approval rules, or turn one on or off. `/standing accept spec-t1` lets tier 1 specs that wait at the spec gate be approved without a reply; `/standing decline spec-t1` turns it off or declines its proposal. A `/revise` or `/reject` on an item the rule approved also turns it off | any time |
| `/link <code>` | Link the account you post from to a factory user, with a code from `factory link-code <user_id>` | any time |
| `/help` | List every command and which ones apply now | any time |

Approval and `/retry` notes are untrusted text: they are capped at 2000 characters and checked by the leak scanner before they are stored. Feedback on a PR (`/revise` there, or a "Request changes" review) is handled the same way, capped at 8000 characters. A note the scanner blocks refuses the approval with a reply; post `/approve` again without it. `+paths` (on the first line, right after `/approve` or `/retry`) takes up to 10 repo-relative paths with no `..` and no glob, and adds the ones the allowed paths do not cover yet; a path under a floor raises the item's tier to that floor's. When a run stops on files outside the allowed paths, its comment gives the exact `/retry +paths ...` reply. Generated from `src/core/commands.ts`; a test fails when this table differs.

Only the owner may send a command: one owner check decides every command (docs/plugins/auth-provider.md). To act from another account as the same factory user (your GitHub user is `github:<numeric id>`), run `npm run --silent factory -- link-code github:<id>` and post the printed `/link <code>` as a comment on any issue from the other account. The code works once, for 10 minutes, and 5 wrong codes lock it. `/link` is the one command read on any issue, work item or not; it is never listed in an item's footer.

If you have write permission and reply in plain words on an open work item's issue (300 characters or fewer, say "ship it"), the factory may answer once with the command it thinks you mean, such as `/approve`, or with the commands that apply now. It uses a cheap model call to do this. Nothing runs and nothing changes until you type the command yourself as a reply; that command is checked like any other.

### Commands in your own words

You can type a command in your own words in the dashboard, the CLI and Slack. The factory reads it with one cheap model call and answers with the commands it thinks you mean, as typed lines, stored as one pending proposal. Nothing changes until you confirm the proposal, or type a line yourself; a confirm is checked as the typed command is, as you, so a command you may not run, or one whose item has moved on, is refused with a reply saying why. Only the owner may send commands.

- **Dashboard:** on an item's page, write in the box under Commands ("Say it in your own words"), for example `looks good, approve it but keep the change small`, and press Read it. The factory answers in the item's thread; the proposal shows on the page with Confirm all and Cancel.
- **CLI:** `factory "approve wi_123 but keep the change small"` prints each proposed command with its proposal ID, for example `proposal prop_3f2a…`. Run `factory confirm prop_3f2a…` to apply them. Any first word that is not a `factory` command is read this way.
- **Slack:** in a work item's thread, reply with no mention, for example `ship it, the tests look fine`. The factory answers in the thread with a button per command, Confirm all and Cancel. In a thread that is not a work item's, a reply with no mention is not read; mention the bot there.

### Local tasks from the command line

Work items can also come from your terminal instead of a GitHub issue. Add `"local"` to `plugins.source` (e.g. `"source": ["github-issues", "local"]`). Run the commands as `npm run --silent factory -- <command>`. None of them calls GitHub, and they work the same whether GitHub is selected, unreachable or rate limited.

Who you are: `cli_user` in `factory.config.json` if you set it (optional), else `local:<git user.email>`, else `local:<OS user name>`, else `local:anonymous`. The local UI uses the same identity. Git's `user.name` is never your ID: it is only the default of the display name `npm run setup` stores once against your ID; the status page shows it next to the ID.

Who may act: one owner check decides every command, whatever its origin (the CLI, the local UI, GitHub comments, Slack). The first identity to run a writing command (`task create`, `approve`, `retry`, `revise`, `reject`), or to finish `npm run setup`, becomes the **owner**; nothing needs to be configured. Only the owner may approve, retry, revise, reject, resolve and merge; everyone, `anonymous` included, may create, list and show. `anonymous` is never the owner. Anyone else's command is refused with "only the owner may send this command".

The identity comes from your environment (git config, OS user), so anyone who can run the CLI against the store can set it: the store's credentials are the trust boundary.

`factory help` prints the same command list as a `/help` reply; `factory help <id>` marks the ones that apply to that item now, exactly as `/help` on its issue does. `factory approve <id>` checks first that approve applies to the item (the spec gate, the floor block, a run held for the Rule of Two or by coordination cost); anywhere else it prints the refusal the controller would give and stores nothing. The status page lists only the commands that apply now and that you may send; the ones it leaves out are named once, with the reason, and every refusal there shows as plain text.

- `factory task create --title <t> --body-file <f> [--depends-on <id>]`: Create a work item from a title and a body; `--depends-on <id>` writes a `Depends on: <id>` line, so its implement run waits until that local item merges (an ID that names no local item is refused); in chat, a mention with any other words, outside an item's thread, is the request. Who: anyone who may submit work. Prints: the new work item's ID.
- `factory task add <words>`: Add a plain task, never a work item or a triage run; quick-add words set its fields: `today`, `tomorrow` or `YYYY-MM-DD`, `HH:MM`, `!1` to `!3`, `#label`, `+project`, `every day`, `every week` or `every month`, and the words left are its title. Who: anyone who may submit work. Prints: the task: ID, title, due, priority, list and recurrence.
- `factory task done <task_id>`: Complete a plain task; a recurring one gets its next occurrence once, however often it is completed. Who: anyone who may submit work. Prints: that it is done (or already was), and the next occurrence.
- `factory task reopen <task_id>`: Undo a plain task's completion; a recurring one's next occurrence is removed while it is open, and the undo is refused once that is done. Who: anyone who may submit work. Prints: that it is open again (or was not done), and the next occurrence it removed.
- `factory task edit <task_id> <words>`: Edit an open plain task with quick-add words: only the fields they name change, and words with no title keep the title. Who: anyone who may submit work. Prints: the edited task.
- `factory task delete <task_id>`: Delete a plain task for good; refused while it has open sub-tasks, and its done sub-tasks become plain tasks. Who: anyone who may submit work. Prints: that it is deleted, and the done sub-tasks it detached.
- `factory task sub <parent_id> <words>`: Add a sub-task under a plain task from quick-add words, one level deep: a sub-task cannot have sub-tasks. Who: anyone who may submit work. Prints: the sub-task, with its parent's ID.
- `factory task build <task_id>`: Send an open plain task to intake as one local work item, linked to the task; building it again makes no second item, and a merge of that item completes the task. Who: anyone who may submit work. Prints: the work item's ID (or that the task was already built as it).
- `factory task list [--project <project_slug>]`: List local work items, then open plain tasks, or with `--project` one task project's. Who: anyone. Prints: one line per local work item: ID, title, stage and blocked reason; then a Tasks section, one line per open task with its projects after its list (`-`, or `+a,+b`; a sub-task with its parent's ID).
- `factory task project <task_id> [-<from>] +<slug>|-<slug>`: Add, remove or move a task's project. Who: anyone who may submit work. Prints: that it was added, taken out or moved (or already was).
- `factory project create <name>`: Create a task project, a group of plain tasks. Who: anyone who may submit work. Prints: the project: +slug and name.
- `factory project list [--archived]`: List task projects, or the archived ones. Who: anyone who may submit work. Prints: one line per project: +slug and name.
- `factory project rename <slug> <name>`: Rename a task project. Who: anyone who may submit work. Prints: the renamed project.
- `factory project archive <slug>`: Archive a task project; its tasks stay in it. Who: anyone who may submit work. Prints: that it is archived (or already was).
- `factory project restore <slug>`: Restore an archived task project. Who: anyone who may submit work. Prints: that it is active again (or already was).
- `factory project delete <slug>`: Delete a task project, not its tasks. Who: anyone who may submit work. Prints: that it is deleted, and the tasks it took out.
- `factory task show <id>`: Show one work item. Who: anyone. Prints: its state, spec, sub-tasks, runs and stored messages.
- `factory approve <id> [notes]`: Store `/approve` for the item. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory retry <id> [text]`: Store `/retry` for the item. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory revise <id> <feedback>`: Store `/revise` for the item; on a New or in-triage item it adds context, queued for one re-triage after the current triage run. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory reject <id> <reason>`: Store `/reject` for the item. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory resolve <id> [notes]`: Store `/resolve` for the item. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory task paths <id> +<path>...`: Store `/paths` for a running item: add those paths (at most 10, each with `+` before it) to its allowed paths, which never removes one. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory task note <id> <text>`: Store `/note` for an open item: a note for its reviewer and implementer, such as the reason a done-when line is built differently, which changes no stage. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory hold <id> <id>`: Store `/hold <id>` for the item: hold it until the local item `<id>` merges (when its implement run asked for a human or is queued, not running). Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory verdict <id> <accept|changes|reject> [<severity> <reason>]`: Store `/verdict` for the item: a verdict on its result, which changes no state. Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory merge <id>`: Merge a local item's branch into the local base branch once its review passed (no push; in auto mode the controller may merge it itself). Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory run-next <id>`: Move the item's queued run to queue position 1, ahead of earlier Run next moves; it starts nothing a busy item, a dependency, a coordination hold, paused claims or a rate limit keeps queued (the item page's Run next; not in chat). Who: the owner. Prints: the stored command's number; the controller applies it and answers in the item's thread.
- `factory "<words>"`: Read a command in your own words with the plain-words reader; in chat, a reply with no mention in an item's thread the factory owns. Nothing changes: each proposed command is stored as pending until it is confirmed. Who: the owner. Prints: each proposed command as its typed line, with the proposal ID to confirm.
- `factory confirm <proposal-id>`: Confirm a stored proposal: the controller applies each of its pending commands once, through the typed command's path and check, as you. Who: the owner. Prints: the stored command's number, or that nothing is pending; the controller answers a refusal in the item's thread.
- `factory settings list`: List every settable key. Who: anyone. Prints: each key's effective value and its source (override, file, default).
- `factory settings set <key> <value> [--project <owner/name>]`: Store an override; `<value>` is JSON. `mode`, `auto_merge_max_tier` and a change that loosens a tighten-only key need approve_merge. Who: anyone. Prints: the key's new and old value with their sources, and when it applies.
- `factory settings reset <key> [--project <owner/name>]`: Remove an override, so the file value (else the default) applies again; the same approve_merge rule as `settings set`. Who: anyone. Prints: the key's new and old value with their sources, and when it applies.
- `factory settings history [--limit <n>]`: Show the settings audit. Who: anyone. Prints: every set and reset, newest first (default 50).
- `factory mode auto|manual [--project <owner/name>]`: The same as `settings set mode <auto|manual>`. Who: the owner. Prints: the mode's new and old value.
- `factory schedule list`: List the schedules. Who: the owner. Prints: one line per schedule, Check a page ones too: ID, title, next due time, `paused` or `on each merge`, running or idle, action kind, missed rule, token cap.
- `factory schedule add --id <id> --title <t> --cadence <interval|daily|weekly|cron|on-merge> [--spec <spec>] [--zone <IANA>] --action <build|agent|feedback|check-page> [--body <text>] [--token-cap <n>] [--missed catch-up|skip] [--run-now on|off] [--url <url>] [--instruction <text>] [--run-cap <usd|none>] [--daily-cap <usd|none>]`: Store a new schedule, first due at its cadence's next slot after now; refused for an ID already stored, a bad cadence, zone or action, and an agent or feedback action without `--body` (its prompt; a build's item body); a daily schedule's token cap counts the runs of each UTC day, any other's all its runs. A check-page action needs an http(s) `--url` and `--instruction` (or `--body`), and takes USD caps; only it takes `--cadence on-merge`, with no `--spec` (zone UTC). Who: the owner. Prints: the stored schedule's line.
- `factory schedule edit <id> [--title <t>] [--cadence <interval|daily|weekly|cron>] [--spec <spec>] [--zone <IANA>] [--action <build|agent|feedback>] [--body <text>] [--token-cap <n>] [--missed catch-up|skip] [--url <url>] [--instruction <text>] [--run-cap <usd|none>] [--daily-cap <usd|none>]`: Change only the flags given; a new cadence or zone sets an unpaused schedule's next due time to its first slot after now, and a paused one stays paused; refused with no flag, or a bad cadence, zone, action, token cap or USD cap; a check-page schedule's cadence, zone or trigger does not change, and no action changes to or from check-page. Who: the owner. Prints: the edited schedule's line.
- `factory schedule pause <id>`: Clear the schedule's next due time, so none of its slots fire (a check-page one is marked paused); refused when already paused. Who: the owner. Prints: the paused schedule's line.
- `factory schedule resume <id>`: Set a paused schedule's next due time to its first slot after now; refused when not paused. Who: the owner. Prints: the resumed schedule's line.
- `factory schedule run <id>`: Set the schedule's next due time to now, so the next tick fires it once; refused when paused or on-merge, writing nothing. Who: the owner. Prints: the schedule's line.
- `factory schedule runs <id>`: List the schedule's runs, oldest first. Who: the owner. Prints: one line per run: occurrence, outcome, recorded time, tokens, cost.
- `factory schedule delete <id>`: Remove the schedule and its suggestions in one transaction, so none of its slots fire again; a run in flight finishes, its past runs and their items stay; refused for an unknown ID. Who: the owner. Prints: the deleted schedule's line.
- `factory schedule draft <words…> [--yes]`: Draft a schedule from your words with the configured model (plugins.llm), then ask y/N before adding it; `--yes`, the last word, adds it without asking; refused with no model, no terminal and no `--yes`, a failed model call, or a cadence, zone or action the checks of `schedule add` refuse. Who: the owner. Prints: the proposed schedule, then the added schedule's line, or that nothing was stored.
- `factory schedule improve <id> [--yes]`: Have the configured model revise the schedule's text (a build's body, an agent's or feedback's prompt), then ask y/N before writing it; `--yes`, the last word, writes it without asking; refused with no model, no terminal and no `--yes`, or a failed model call. Who: the owner. Prints: the old and the new text, then the edited schedule's line, or that nothing was stored.

`task create` takes the item in and queues its triage run; the store must already know the configured repo, so start the factory once first. `approve`, `retry`, `revise`, `reject` and `resolve` work for any work item, a GitHub one included, and only store the command in the command log; the controller reads it on its next poll and applies it with the owner check, so the owner needs no GitHub write access. For a GitHub item the factory also posts one comment on the issue saying who sent which command. That mirror is best effort: while GitHub is down or rate limited the command still applies, and the comment is posted on a later tick. Its replies (the spec, refusals, failures) are stored as the item's messages: read them with `task show`. `merge` is stored the same way; the controller merges the item's local branch `factory/<id>` into your local base branch with a merge commit, writing no checkout and pushing nothing, and closes the item. Only the owner may send it; it applies only to a local item waiting for a merge, and refuses while the base branch is checked out in a worktree (switch that checkout to another branch first) or when the branch conflicts (the reply lists the files). Generated from the command table, `src/core/command-table.ts`; a test fails when this list differs.

With no GitHub plugin selected (the solo default below) nothing ever reaches GitHub: `"plugins": { …, "source": ["local"], "broker": "local" }`. Then the factory reads no GitHub credential, fetches no origin, opens no PR, and every item ends with `factory merge` (design `docs/design/05-sources.md`, Local startup).

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

By default the factory builds one item at a time. To build several in parallel, set `workers` in `factory.config.json`, e.g. `"workers": 3`, and restart `npm run factory -- dev` (or `worker`). It must be a whole number of 0 or more; anything else stops startup with an error. Absent means 1. With 0 no worker claims a run, and runs already going finish.

To change the count while the factory runs, without a PR, set `max_workers` in the file once (a whole number of at least `workers`; absent means `workers`), then use `npm run factory -- settings set workers <n>` with any n from 0 to `max_workers`. The pool starts or stops worker loops on its next tick; a stopped loop finishes its current run first. 0 stops every loop: no new run starts, and the runs going finish. To also put the implement and review runs going back in the queue, use `npm run factory -- stop` (undo: `npm run factory -- resume owner`). `npm run factory -- settings reset workers` goes back to the file's `workers`.

To let the phases of a split you approved run without an `/approve` each, run `npm run factory -- settings set phases_auto_approve true` (`settings reset phases_auto_approve` turns it off again).

Items whose allowed paths overlap still wait for each other, so their PRs do not conflict; triage and review never wait. Each worker passes its number (0, 1, 2, …) to the agent and to the update test command as `SF_WORKER_INDEX`. If your tests start a server or use a database, use it to pick a port or database name per worker so parallel runs do not collide, e.g. `PORT=$((3000 + SF_WORKER_INDEX))`. The number is unique only inside one process: two factory processes on one machine both have a worker 0.

Unknown config keys are rejected at load: a typo in `factory.config.json` (for example `"plugin"` or a `"hots"` in `store`) stops every command with an error that names the key, lists the valid keys and suggests the closest one; `doctor` shows each as a FAIL line.

### Auto mode (`factory mode`)

By default the factory is in **manual** mode: a person approves every spec and merges every change. In **auto** mode it approves a spec itself when the spec is below tier 4, touches no path on the gate list (prompts, gates, permissions, tools, guard settings) and every decision has a proposed default that is not owner-only; it posts the answers it took in the thread. It also merges a reviewed local change itself, through the same local merge as `factory merge` (the checks run on the merge commit first), when the change is below tier 4, off the gate list, complete, and at or under the auto-merge tier. GitHub items are never merged automatically.

- `npm run factory -- mode auto` (or `manual`; `--project <owner/name>` for one project): the same as `settings set mode`. One audit row names who flipped it and when; running factories pick it up at their next tick.
- `npm run factory -- settings set auto_merge_max_tier <0-3>`: the highest tier auto mode merges at. The default 0 merges nothing, so raise it to let auto mode merge. 4 or more is refused.

Both need `approve_merge` on the project: the owner (you, after your first writing command) has it with no setup. The Settings page and the dashboard's top bar show the mode with a switch, and the auto-merge tier next to it. A failing check on the base branch after an automatic merge, a failure alarm or a budget checkpoint sets the mode back to manual, with one alarm in Needs you and one audit row by `system:auto`.

### Interactive tasks: you handle an item in your own LLM session (`factory interactive`)

An interactive task is a work item you handle yourself, in your own Claude (or other LLM) session, instead of a worker. `factory interactive` and `factory session` are the same command. It works for local tasks and GitHub issues alike. Starting one on an item whose implement or update run is only queued takes the item over: those queued runs are cancelled. A running one still refuses. The dashboard shows an "Interactive task" badge on the item while it is open.

Work you do with an LLM in your own terminal goes through the factory as one `interactive` run on the work item: a lease, your user ID as its actor, your token count and notes, and a worker's gates before anything is pushed. A worker never claims an implement or update run whose item overlaps your open session, and a session does not start over a running one.

```bash
npm run --silent factory -- interactive start 12 [--spec spec.json [--wait]] [--transcript <url>] [--as <github login>]   # issue #12 or a wi_… id
npm run --silent factory -- interactive status | note "<text>" [--tokens <n>] [--transcript <url>] | finish [--tokens <n>] | abandon [--tokens <n>]
```

- `start` creates the work item if the issue has none (only with `--spec`), records the run, makes a run folder on the item's branch and prints its path: work and commit there. It stays in the foreground and keeps the lease; Ctrl-C stops it, the lease expires, the reaper ends the run (`session_lost`) and the item is released. `--spec <file>`: your own spec for a NEW item, in the triage output format (checked by the same parser; no phases); the queued triage run is cancelled. `--transcript <url>`: an http or https link, stored after the leak scan. You act as the CLI identity (`cli_user`, else your git `user.email`, else your OS user, else `anonymous`), with no GitHub call. `--as <login>`: act as that GitHub account instead, mapped to your user ID as for commands; it is checked on GitHub, so it needs the GitHub source on (`github-issues` in `plugins.source`): with the source off it is refused (turn the source on or drop `--as`), and a login GitHub does not know is refused (check the login, or start without `--as`). Who may start is the owner check, as for every command. Refused, with nothing changed, for an item that is closed, in review, waiting for `/approve`, without allowed paths, with a running implement or update run or an open interactive task, or overlapping another item's running implement run. `--wait` (with `--spec`, on a NEW item): instead of refusing over another item's running run, reserves the item for this session (triage skips it; another session start on it is refused) and starts the session on the first check, every 15 seconds, after no running run shares its files. Ctrl-C releases the reservation at once; after 2 hours it ends by itself. Either way the item then goes to triage as usual.
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

Some files always change together: a store interface change needs the SQL store, the SQLite schema and the contract test, and a design decision lives in a topic file beside its index. Declare these in `factory.config.json` under the optional top-level key `path_companions`, so a triage spec that names one file also allows the others:

```json
"path_companions": [
  { "when": "src/interfaces/factory-store.ts", "also": ["src/impl/store/sql/sql-factory-store.ts", "src/impl/store/sqlite/schema.ts", "tests/store-contract.test.ts"] },
  { "when": "docs/design.md", "also": ["docs/design/"], "reason": "a design decision lives in a topic file beside the index" },
  { "when": "src/core/types.ts", "with": ["src/worker/runs/"], "also": ["src/worker/settings/worker-kinds.setting.ts"], "reason": "a new run kind joins the worker_kinds setting" }
]
```

- **Format.** A list of entries. Each has `when`, one repo-relative path, and `also`, a non-empty list of repo-relative paths. A path ending in `/` names a folder. Two keys are optional: `reason`, a non-empty string saying why the change needs `also`, and `with`, a non-empty list of more repo-relative paths that must all match too. No other key is allowed in an entry. A bad shape stops startup with a message naming the key and the entry index (`path_companions[1].also must be ...`). Without the key there are no companions.
- **How `when` matches.** Only the spec's `files_to_change` (the files triage expects to change) is matched, not `allowed_paths`. A path matches when it equals `when`, sits under a `when` folder, or is a folder that `when` sits under. With `with`, every `with` path must match a `files_to_change` path the same way, so an entry can fire only on the change it is for (above: a new run kind edits the `RunKind` type and adds a run folder; an edit to one existing run does neither alone).
- **What gets added.** Each `also` path goes into the spec's `allowed_paths`, unless an allowed path already covers it. This happens on triage's answer before it is checked, so a companion triage lists in `files_to_change` but forgot in `allowed_paths` is accepted. It also happens before the tier floor, so an added path under a floor raises the tier. Built in, whatever the config: naming `docs/design.md` or `docs/plugins.md` in either list adds `docs/design/` or `docs/plugins/`; the index stays allowed. A split spec's phases are left alone: each phase's own triage adds its companions.
- **The spec line.** The spec comment's Files section lists each added path under "Added by `path_companions`", with the path that caused it: ``- `tests/store-contract.test.ts`: added because the spec names `src/interfaces/factory-store.ts` ``. An entry with a `reason` that added a path also puts `Added by companion rule: <reason>` under "Applied defaults", once per reason (when they would pass the limit of 10 applied defaults they share one line). A spec that matches nothing reads exactly as triage wrote it.
- **On `/revise`.** A `/revise` reruns triage, so the revised spec gets the same companions and notes.

The checked-in config declares the store interface, the config keys, both doc indexes, the generated files, the controller table docs, the SQL store's folder and the run-kind files, each with a reason. An `also` path on the gate list (`src/controller/`, the settings folders) makes the item's merge wait for a person even when the run does not edit it, so give such an entry a narrow `when` or a `with`. Changing `path_companions` changes `factory.config.json`, which is under a floor, so it needs a human merge.

### CI and branch protection

`.github/workflows/test.yml` runs on every pull request and every push to `main`. Job `test`: `npm ci`, `npm run typecheck`, `npm test`. No secret is needed. The store is SQLite (`docs/design/05-coordination.md`).

The factory waits for a PR's checks before it posts "A human merge is required": while any check runs, the item stays in review (`blocked_on: ci`, `checks_pending`) and the factory looks again every `poll_interval_ms`; a failed check sends the item back to implement; when every check passed it moves to `merge_pending`. A PR with no checks at all counts as passed.

Once, after the workflow has run at least once on GitHub, make the `test` check required so no PR can be merged with failing tests, by hand or by the factory:

1. GitHub → the repository → Settings → Branches (or Rules → Rulesets) → Add branch protection rule for `main`.
2. Turn on **Require status checks to pass before merging** and **Require branches to be up to date before merging**.
3. In the search box, add the status check `test`.
4. Save.

### Checks before push

Before an implement run pushes, the worker runs `repo.check_commands` from `factory.config.json` (here `npm run typecheck`, then `npm test`; the same commands as the workflow's `run:` steps, and a test fails if the two drift). A failure gets one fix step; a second failure stops the run with `checks_failed` and a comment naming the command. The update and resolve runs run the same list.

### Feedback schedule grants

A feedback schedule's agent gets Read, Glob and Grep in this repo. To give it more, add `--grant <word>` (repeat it, one per kind) to `factory schedule add` or `edit` with `--action feedback`; `--grant none` clears them. `factory schedule list` shows each grant in plain words.

- `browser=<url>`: the `schedule.browse` broker tool (served through the runner's tool bridge, like the shell grant's), limited to that sandbox URL (http or https on localhost or a loopback address).
- `notes`: Write and Edit, only inside `.factory/notes/<schedule id>/`, which `add` or `edit` creates.
- `repo=<absolute path>[#<branch>]`: the agent runs in a fresh checkout of that repo (branch `main` by default), and no other. Set up the repo first: it must be a git repo (`git -C <path> rev-parse` works) outside the factory's `.factory` folder, with the branch present.
- `shell=<absolute database path>`: one query tool that runs `sqlite3 -safe -readonly` on that database file, and no other command: one SELECT, WITH, EXPLAIN or PRAGMA table_info statement, no dot commands, options or file functions. `sqlite3` 3.37 or newer (for `-safe`) must be on the PATH, and the agent runner must expose broker tools (`claude-code` does).

A grant that is refused when the schedule runs (a repo that is gone, a missing database) fails that run before its agent starts; `factory schedule runs <id>` shows why.

## Run the factory on your project

The checked-in `factory.config.json` is this repository's own config. To point the factory at another repository, keep your config outside the factory checkout, so `dev`'s updater (which runs `origin/<base_branch>`) never replaces it:

1. Make a folder for it, e.g. `~/factory/my-app/`, and copy `factory.config.json` into it.
2. Edit at least `repo.owner`, `repo.name`, `repo.path` (your project's checkout; relative paths resolve from the folder you start the factory in), `repo.base_branch`, `repo.test_command` / `repo.check_commands`, `floors` and `store`. For one machine, `"store": { "type": "sqlite" }` needs no database.
3. Check it: `npm run factory -- doctor --config ~/factory/my-app/factory.config.json`. The first line names the config file in use.
4. Start: `npm run factory -- dev --config ~/factory/my-app/factory.config.json` (or `export FACTORY_CONFIG=…`; `--config` wins when both are set). Every command takes the flag.

With `--config` or `FACTORY_CONFIG`, `state_dir` and `worktrees_dir` resolve from the config file's folder (`~/factory/my-app/.factory`, `~/factory/my-app/.worktrees`); without them they stay under the folder you start in. Prompts still come from the factory checkout, and the secret file stays at `~/.config/software-factory/.env`. With SQLite you may set any key. Details: [`docs/plugins/selection.md`](docs/plugins/selection.md).

## macOS app

Gongbang, a Mac app that runs the factory for you: a window on the dashboard, `Gb <n>` in the menu bar (`n`: how many items need you, refreshed every 15 seconds), and a Quit that lets the factory finish what it is doing. Unsigned, macOS only. Decisions: [`docs/design/09-desktop-app.md`](docs/design/09-desktop-app.md).

Install:

1. Finish `npm run setup` in this checkout, and build it once: `npm run build`.
2. Build the app: `npm run build:desktop:macos`. It copies Electron from `node_modules/electron/dist` into `desktop/out/Gongbang.app`, with the Gongbang icon (built from `design-system/icon.svg`; `npm run build:icons -- <folder>` writes the PNG sizes alone). If it says `node_modules/electron/dist` is missing, install the project's dependencies (`npm install`) and run it again; the script itself never installs anything.
3. Optional: drag `desktop/out/Gongbang.app` to `/Applications`; an older `Software Factory.app` there can go to the Trash. The app runs the checkout it was built from, wherever the app itself is.
4. Start it: `open desktop/out/Gongbang.app`. The app is not signed: the first time, macOS may refuse to open it; right-click it in Finder, choose Open, and confirm.

Use:

- If the factory already runs for that checkout (`npm run factory -- dev` in a terminal), the app attaches to it: it shows its dashboard and count, starts no second factory, and its Quit leaves that factory running. Otherwise the app starts the factory (`dist/main.js dev`) as its own child and starts it again 5 seconds after it stops. The log is `~/Library/Application Support/software-factory/state/supervisor.log`; its first line says `attached` when the app did not start the factory.
- Closing the window keeps the factory and the menu bar item running; click the Dock icon or choose "Open dashboard" in the menu bar to see it again.
- Cmd+Q, or Quit in the menu bar, drains the factory the app started (in-flight work stops as on Ctrl-C) and waits up to 60 seconds before it stops the factory hard.
- Its settings are in `~/Library/Application Support/software-factory/config.json`, written on first start: `checkout` (the factory checkout to run), `ui_port` (set it when `factory.config.json` sets another `ui.port`) and `keep_running_when_closed` (`false` makes closing the window quit). Quit and start the app again after a change.
- The app never reads the secret file: the factory it starts does, as from a terminal.
- Known limit: an app started from Finder or `open` gets macOS's short `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), not your shell's. If the log says the factory cannot find `claude` or another tool, that is why; a later change passes the login shell's `PATH`.

## Routine

| When | Command |
|---|---|
| Check that everything still works | `npm run factory -- doctor` |
| Check that the configured LLM provider answers (two small real calls) | `npm run factory -- llm-check` (or `doctor --llm`) |
| GitHub token expired or about to | `npm run setup -- --rotate-github` |
| Claude token replaced | `npm run setup -- --rotate-claude` |
| After an update that adds a breaking migration or a data step (`npm run migrate -- --status` lists them; back up first). Works while `factory dev` runs: the status page says the update waits for it; `migrate` drains the factory first, applies the steps, then the new revision starts. Set `"updater": { "auto_migrate": true }` in `factory.config.json` to have the factory do this by itself | `npm run migrate` |
| See the pending breaking migrations and data steps | `npm run migrate -- --status` |
| See what `npm run migrate` would run, changing nothing | `npm run migrate -- --dry-run` |
| See work items / one item's history | `npm run factory -- status` / `npm run factory -- status <id>` |
| Watch the factory in a browser (read-only) | `make ui` (or `npm run factory -- ui`), then open <http://127.0.0.1:4310/> (the app) |
| Reset this machine and set up again | `make teardown`, then `make setup` (see [Start over](#start-over-pull--teardown--setup)) |
| Suspect a leak | Revoke the token on GitHub first (or the App's key), then rotate |

### Status page

`npm run factory -- dev` serves the factory app at <http://127.0.0.1:4310/> (under the checked-in `git-worktree` updater it runs the page as a child and swaps it on each new revision; with `plugins.updater: none`, start it yourself with `npm run factory -- ui`). It redirects to `/app/`; the port is `ui.port` in `factory.config.json`. Pages: Floor (what needs you, what runs, the queue), Work items with a page per item, Workers, Queue, Health, Failures, Settings (the mode switch and runtime settings) and Data. Each item page lists the commands that apply to it now and a Merge button once its review passed (a local change through the merge queue, a PR at its reviewed head). It listens on 127.0.0.1 only and answers only requests whose Host is `127.0.0.1` or `localhost`. It starts no controller or worker, so run it beside `npm run factory -- dev`. It reads the secret file like the other commands (known secret values for the egress scan); a field that looks like a secret shows `[withheld: <rule>]` instead of its text, and search can't find it.

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

### Google Calendar (optional)

Settings → Calendar → Connect signs in through Google, with the factory's default client or your own ([calendar-source](docs/plugins/calendar-source.md)). Google may show "Google hasn't verified this app" for either client: that is expected, and Continue is safe. A client in Testing status must be reconnected every 7 days, unless you set it to In production on the OAuth consent screen, which needs no verification for your own account. When the sign-in expires, Settings → Calendar shows "Reconnect Google Calendar": press Connect again.

### Slack (optional: real-time threads)

Off by default; nothing changes until you turn it on. Once on, mentioning the bot in a listed channel starts a work item from that thread, and the factory answers in the thread with the spec, status and buttons. PRs and code stay on GitHub.

One-time Slack app setup, details in [`docs/slack-setup.md`](docs/slack-setup.md) (mostly `scripts/slack-app.sh create|tokens|check`):

1. **The app, from the manifest** ([`slack/manifest.json`](slack/manifest.json)): Socket Mode on (no public URL or open port), interactivity on (for the buttons), bot scopes `app_mentions:read`, `channels:history`, `groups:history`, `chat:write`, `im:write`, `reactions:read`, `reactions:write`, events `app_mention`, `message.channels`, `message.groups` and `reaction_added` (a 👍 or 👎 on a factory message is a verdict). An app installed before `reactions:read` and `reaction_added` were added must be updated from the manifest and reinstalled to get them.
2. **The tokens go in the secret file** (`~/.config/software-factory/.env`, never in the repository), through `scripts/slack-app.sh tokens`:
   - `SLACK_BOT_TOKEN` (`xoxb-…`, OAuth & Permissions page): reads threads and posts in them.
   - `SLACK_APP_TOKEN` (`xapp-…`, Basic Information → App-Level Tokens, scope `connections:write`): opens the Socket Mode connection.
3. **The channel:** `/invite @software-factory` in the channel, then copy its ID (channel details, bottom of the **About** tab, `C…`). Use the ID, not the name.
4. **Turn it on** in `factory.config.json`, then restart the factory:

   ```json
   "slack": { "channels": ["C0123456789"] },
   "plugins": { "source": ["github-issues", "local", "slack"] }
   ```

5. **Link your Slack account** to your factory user (a Slack account has no rights until it is linked; then it acts as that user): run `factory link-code <your factory user ID>` (the owner, e.g. `local:you@example.com`; `npm run setup` prints it on its You step), then post `@software-factory /link <code>` in the channel.

Known gaps (2026-11-09; issues #479–#486): people's Slack replies are not shown on the item page, `/revise` on a PR is refused from Slack, commands get no 👀 reaction, and private channels (`G…`) do not work yet.

In Slack, a message that starts with `/` is taken by Slack itself, so type commands after a mention, with no slash (`@software-factory revise <feedback>`), or use the buttons.

The factory's commands in Slack, from the same command table as the CLI (`@bot` is the mention of the bot). Each runs as the factory user the Slack account is linked to, under the owner check; an unlinked account gets one reply saying so, and only `/link` and `help` are answered for it. `list`, `show` and `settings` reads reply with what the CLI prints, cut to Slack's limits with a note naming the CLI command that prints the whole text and, for `show <id>`, a link to the item's source. Item commands and `merge` store the CLI's command row, and the controller answers in the item's thread. `help` lists only the commands you may run where you ask it. A mention with any other words is a request in plain words: outside an item's thread it starts a work item, in an item's thread the factory suggests a command.

In Slack a command follows a mention of the bot, in the item's thread and with no slash: `@software-factory approve`, `@software-factory revise <feedback>`, and so for every command (`retry`, `reject`, `resolve`, `budget`, `merge`, `verdict`, `standing`, `link`). The slash form after a mention (`@software-factory /approve`) still works. Outside an item's thread, a mention that starts with a command word and no slash is a request and starts a work item; there `link` keeps its slash (`@software-factory /link <code>`). A reply in an item's thread with no mention still needs the slash. `@software-factory help` answers in the mention's thread: outside an item's thread with how to start work and `/link <code>`, in an item's thread with the commands that apply now, in the same words as `/help` on GitHub but without the slash.

- `@bot <request in plain words>`: as `factory task create --title <t> --body-file <f> [--depends-on <id>]`. Who: anyone who may submit work.
- `@bot task add <words>`: as `factory task add <words>`. Who: anyone who may submit work.
- `@bot task done <task_id>`: as `factory task done <task_id>`. Who: anyone who may submit work.
- `@bot task reopen <task_id>`: as `factory task reopen <task_id>`. Who: anyone who may submit work.
- `@bot task edit <task_id> <words>`: as `factory task edit <task_id> <words>`. Who: anyone who may submit work.
- `@bot task delete <task_id>`: as `factory task delete <task_id>`. Who: anyone who may submit work.
- `@bot task sub <parent_id> <words>`: as `factory task sub <parent_id> <words>`. Who: anyone who may submit work.
- `@bot task build <task_id>`: as `factory task build <task_id>`. Who: anyone who may submit work.
- `@bot list`: as `factory task list [--project <project_slug>]`. Who: anyone.
- `@bot task project <task_id> [-<from>] +<slug>|-<slug>`: as `factory task project <task_id> [-<from>] +<slug>|-<slug>`. Who: anyone who may submit work.
- `@bot project create <name>`: as `factory project create <name>`. Who: anyone who may submit work.
- `@bot project list [--archived]`: as `factory project list [--archived]`. Who: anyone who may submit work.
- `@bot project rename <slug> <name>`: as `factory project rename <slug> <name>`. Who: anyone who may submit work.
- `@bot project archive <slug>`: as `factory project archive <slug>`. Who: anyone who may submit work.
- `@bot project restore <slug>`: as `factory project restore <slug>`. Who: anyone who may submit work.
- `@bot project delete <slug>`: as `factory project delete <slug>`. Who: anyone who may submit work.
- `@bot show <id>`: as `factory task show <id>`. Who: anyone.
- `@bot approve [notes]`: as `factory approve <id> [notes]`, in the item's thread. Who: the owner.
- `@bot retry [text]`: as `factory retry <id> [text]`, in the item's thread. Who: the owner.
- `@bot revise <feedback>`: as `factory revise <id> <feedback>`, in the item's thread. Who: the owner.
- `@bot reject <reason>`: as `factory reject <id> <reason>`, in the item's thread. Who: the owner.
- `@bot resolve [notes]`: as `factory resolve <id> [notes]`, in the item's thread. Who: the owner.
- `@bot paths +<path>...`: as `factory task paths <id> +<path>...`, in the item's thread. Who: the owner.
- `@bot note <text>`: as `factory task note <id> <text>`, in the item's thread. Who: the owner.
- `@bot hold <id>`: as `factory hold <id> <id>`, in the item's thread. Who: the owner.
- `@bot verdict <accept|changes|reject> [<severity> <reason>]`: as `factory verdict <id> <accept|changes|reject> [<severity> <reason>]`, in the item's thread. Who: the owner.
- `@bot merge`: as `factory merge <id>`, in the item's thread. Who: the owner.
- `@bot <command in your own words>`: as `factory "<words>"`; in an item's thread the factory owns, a reply with no mention. Who: the owner.
- `@bot confirm <proposal-id>`: as `factory confirm <proposal-id>`. Who: the owner.
- `@bot settings list`: as `factory settings list`. Who: anyone.
- `@bot settings set <key> <value> [--project <owner/name>]`: as `factory settings set <key> <value> [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: anyone.
- `@bot settings reset <key> [--project <owner/name>]`: as `factory settings reset <key> [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: anyone.
- `@bot settings history [--limit <n>]`: as `factory settings history [--limit <n>]`. Who: anyone.
- `@bot mode auto|manual [--project <owner/name>]`: as `factory mode auto|manual [--project <owner/name>]`; refused in chat until #479, so use the CLI. Who: the owner.
- `@bot schedule list`: as `factory schedule list`. Who: the owner.
- `@bot schedule add <flags>`: as `factory schedule add --id <id> --title <t> --cadence <interval|daily|weekly|cron|on-merge> [--spec <spec>] [--zone <IANA>] --action <build|agent|feedback|check-page> [--body <text>] [--token-cap <n>] [--missed catch-up|skip] [--run-now on|off] [--url <url>] [--instruction <text>] [--run-cap <usd|none>] [--daily-cap <usd|none>]`. Who: the owner.
- `@bot schedule edit <id> <flags>`: as `factory schedule edit <id> [--title <t>] [--cadence <interval|daily|weekly|cron>] [--spec <spec>] [--zone <IANA>] [--action <build|agent|feedback>] [--body <text>] [--token-cap <n>] [--missed catch-up|skip] [--url <url>] [--instruction <text>] [--run-cap <usd|none>] [--daily-cap <usd|none>]`. Who: the owner.
- `@bot schedule pause <id>`: as `factory schedule pause <id>`. Who: the owner.
- `@bot schedule resume <id>`: as `factory schedule resume <id>`. Who: the owner.
- `@bot schedule run <id>`: as `factory schedule run <id>`. Who: the owner.
- `@bot schedule runs <id>`: as `factory schedule runs <id>`. Who: the owner.
- `@bot schedule delete <id>`: as `factory schedule delete <id>`. Who: the owner.

To turn it off, drop `"slack"` from `plugins.source`. Several replicas: only one holds the Socket Mode connection at a time (the listener lease); `scripts/slack-app.sh check` reports one more connection while the factory runs.

Why the secret file lives where it does, and how each guard works: [`docs/setup.md`](docs/setup.md), [`docs/architecture.md` §5](docs/architecture.md#5-secret-isolation).

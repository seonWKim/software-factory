# SourceAdapter

What it does: intake. Brings in new work items and commands from a source, and posts comments back. `SourceAdapter` is a union on `intake` (docs/architecture.md, Intake):

- `intake: "poll"` (`PollSource`): `poll(cursor)` returns events and the next cursor; the controller calls it every `poll_interval_ms`.
- `intake: "stream"` (`StreamSource`): `subscribe(signal)` returns an `AsyncIterable<PushedEvent>`, for sources that push events as they happen (e.g. Slack Socket Mode).

Both kinds have `postComment`, `markSeen` and `setStatus`.

Plugins:

- `github-issues`: `GitHubIssueSource`. Issues with the intake label on the configured repository, their comments and pull requests, and commits on the base branch (`repo.base_branch`; one extra API call per poll, for revert tracking, design §6).
  - `setStatus(source, status, pr_number)`: shows one of eight statuses (`triaging`, `needs_approval`, `implementing`, `in_review`, `ready_to_merge`, `needs_human`, `done`, `rejected`) as a label. `pr_number` null labels the issue; non-null labels that PR instead (PRs share the issue labels API), so the controller calls it once for the issue and once for the PR. Each call creates the label if missing (a 422 `already_exists` counts as success), adds it, and removes the other seven fixed names; a 404 on removal counts as success, and no other label is touched, including other labels under the prefix. Idempotent and best effort: the controller logs a failure as a warning and the transition stands. Names, colours and descriptions live in one table in `src/impl/source/github-issue-source.ts`. Uses the existing Issues read/write permission; no new scope.
  - Enable: `"plugins": { "source": "github-issues", ... }`.
  - Secrets: none of its own (the shared client's `GitHubCredentials`). Settings: `repo` (including `base_branch`), `intake_label`, `branch_prefix`, `poll_interval_ms`, `status_label_prefix` (optional, default `"sf: "`; labels are the prefix plus e.g. `needs approval`. Changing it leaves labels under the old prefix in place).

- `local`: `LocalSource` (issue #199). A poll source of type `local` that reads the store, never a forge, and makes no network call.
  - `poll(cursor)` reads the CLI command log (`command_inbox`, migration 24) after the cursor, at most 100 commands per poll; the rest come on the next poll. The cursor is the `seq` of the last command read, as a string (`intake:local`); none or empty means from the first command.
  - Each command for a local item becomes one event. Its shape: `args.item` is the work item ID, `args.text` an optional string. The command is rebuilt as `/<command> <text>` and read by the same comment parser as GitHub comments, so the event kinds match (`/link` is a plain comment, an unknown word an `unknown_command`; `revise` has no `pr`, `resolve` has `pr: null`, `verdict` targets the item). The event's source is the item's own SourceRef, `comment_id` is the command's `key`, and the identity is provider `local` with subject the actor after `local:`. A command whose item is missing or not local gives no event; the cursor still moves past it.
  - `postComment` stores one item message (`item_thread`, migration 24) for the item with that source id, idempotent on the marker (a repeat stores nothing), and returns `url: null`. An id with no local item throws, naming the id. `markSeen`, `setStatus` and `closeIssue` do nothing: the store already holds the item's state.
  - It does not write commands or create items, and emits no `item_requested`. Local identities go through the configured `AuthProvider` unchanged.
  - Enable: `"plugins": { "source": "local", ... }`, or next to GitHub: `"source": ["github-issues", "local"]`.
  - Secrets: none. Settings: none.
  - Switch back: `"source": "github-issues"` (or drop `"local"` from the list).

- `slack`: `SlackSource` (issue #109). A **stream** source of type `slack_thread`: Slack threads become work items in real time, over Socket Mode. Off unless `plugins.source` lists it.
  - In: one Socket Mode WebSocket, opened only by the replica holding the `slack_thread` listener lease (the existing stream-intake listener: store first, then ack; reconnect with backoff). No Slack SDK: `src/impl/source/slack-socket.ts` uses Node's WebSocket and `slack-api.ts` the Web API over HTTPS. Only events in a channel listed in `slack.channels` count; the bot's own messages, other bots (`bot_id`), and `subtype` events (edits, joins, deletes) are ignored and acked at once.
  - A mention of the bot (`app_mention`) starts one work item from its thread: source id `slack:<team id>:<channel id>:<thread ts>` (the message `ts` for a top-level mention), title the first line of the text, link `https://slack.com/archives/<channel>/p<ts>`. Slack sends a `message` and an `app_mention` event (two event ids) for one mention: only `app_mention` counts, and intake is idempotent on the source id. A mention whose text after the bot is a command (`@bot /approve`) is that command; `@bot /link <code>` links the Slack account; a mention in a thread that already is an item is a plain comment. A reply in an item's thread without a mention is a command or a plain comment, through the same comment parser as GitHub (`src/impl/source/comment-event.ts`). A top-level message without a mention starts nothing.
  - Buttons: messages that end with the command footer get a button for each listed command that takes no text (`approve`, `retry`, `resolve`, `budget`, `help`, from the command table in `src/core/commands.ts`); a suggestion for a plain reply gets Confirm and Cancel. A press is the same event as typing the command, as the presser; Confirm sends the suggested command, Cancel stores nothing. Every press and typed command goes through the controller's one `AuthProvider` check, as on GitHub.
  - People are Slack user IDs (provider `slack`, subject `U…`); no display name is read, stored or logged. A Slack user is a factory user only through a link: `factory link-code <user_id>`, then `@bot /link <code>` in a listed channel. An unlinked account's command is refused with one reply in the thread; an unlinked mention gets one reply saying the thread was not taken in.
  - Dedupe keys: `event:<event_id>`, or `action:<team>:<user>:<action_ts>` for a button press, so a redelivery after a reconnect is one inbox row.
  - Out: `postComment` turns the Markdown into Slack mrkdwn (markers dropped, `PR #N` linked to GitHub), egress-scans the whole message with its buttons, and posts it in the thread with the marker's hash in Slack message metadata. It looks in the thread first, so a marker is posted at most once. A message the scanner blocks is never posted in any form: the thread gets one notice naming the rules, under the same marker, so it is not tried again. `setStatus` keeps one status message per thread, edited in place, with a link to the PR once the item has one; a PR's own status stays on GitHub. `markSeen` and `closeIssue` do nothing (no reaction scope; a thread cannot close: the controller's reject or close comment says it).
  - PRs and code stay on GitHub: implement, review and the human gate run as for an issue, and the merge closes the item through the `github-issues` source, which must be listed too.
  - Enable: add `"slack": { "channels": ["C0123456789"] }` to factory.config.json and list it next to GitHub: `"source": ["github-issues", "local", "slack"]`. One-time Slack app setup: SET_UP.md, Slack.
  - Secrets: `SLACK_APP_TOKEN` (app-level token, `connections:write`: opens the Socket Mode connection) and `SLACK_BOT_TOKEN` (bot token: reads threads and posts in them). Read only inside `src/impl/source/slack-api.ts`, at the point of use. Settings: `slack.channels`, a non-empty list of channel IDs (`C…` or `G…`), checked at load: an unknown key in the block, a channel name instead of an ID, or a missing block while `slack` is selected fails startup. A format check only: the bot has no `channels:read`.
  - Switch back: drop `"slack"` from `plugins.source` (the `slack` block may stay; nothing reads it). Slack items keep their state; their replies log `no source adapter for the item's source type; skipped`.

Other sources may implement `setStatus` as a no-op.

**Several sources.** `plugins.source` takes one name or a list of names:

- `"source": "github-issues"` and `"source": ["github-issues"]` select the same thing as always.
- `"source": ["github-issues", "<other>"]` runs both. The factory builds one adapter per name. Each poll source has its own cursor (`intake:<source type>`) and each stream source its own listener and inbox cursor (`inbox:<source type>`). Each source's intake step runs on its own, so a source that fails (a poll that throws) does not stop the others in the same tick; its cursor simply does not move.
- Fails at startup, naming `plugins.source`: an empty list, an unknown name, the same name twice, two entries that build the same source type, or several entries with none of type `github_issue`. PR merge, close and unmergeable events come only from `github-issues`, so without it factory PRs would never close their items. One non-GitHub source alone is still accepted.
- **Per-item routing.** The controller sends each item's `postComment`, `markSeen`, `setStatus` and `closeIssue` to the adapter whose `type` matches the item's source type, so replies go back where the item came from. A command's reply goes to the source the command came from.
- **PRs stay on GitHub.** `setStatus` for a PR (non-null `pr_number`) goes to the `github_issue` adapter, whatever the item's own source. (With only one non-GitHub source configured, it goes to that source, as before.)
- An item whose source type is no longer listed keeps its state: its comment, 👀, status and close calls log the warning `no source adapter for the item's source type; skipped` and do nothing.
- Commands (`/approve`, `/revise`, `/help`, unknown commands, plain comments) from any source run the same command table, the same `AuthProvider` permission check and the same replies.
- Secrets: the union of what every listed source declares.

**Writing a stream source plugin.** Implement `StreamSource` (`src/interfaces/source-adapter.ts`) with `readonly intake = "stream"` and a `type` from `SourceType`:

- `subscribe(signal)` opens **one** connection and yields a `PushedEvent` per event: the `SourceEvent`, a `dedupe_key` that is unique within the source and the same on every redelivery of that event (e.g. Slack's `envelope_id`, or better the event id), and `ack()`. The iterable completes when the connection ends and throws when it fails. Stop and complete once `signal` aborts. Do not reconnect inside `subscribe`: the listener does that, with backoff, by calling it again.
- `ack()` tells the source the event is safe. The listener calls it only after the event is committed to the store inbox, so do not ack on receipt. An event that was never acked must come back on a later connection; that is what makes a crash lose nothing.
- Do not keep state another replica would need. Only the replica holding the source's listener lease calls `subscribe`; every replica's controller handles the events from the inbox, through the same `handleEvent` as polled events, so the source's `postComment`, `markSeen` and `setStatus` are called from whichever replica handles the event.
- Credentials (e.g. a Socket Mode app token) are read by the plugin from the `SecretStore` passed in its factory context, as `github-issues` does through `GitHubClient`, never put in events or logs.
- Register it in `src/plugins.ts` under `source` with its section here, as for any plugin. Settings: `lease_ms` and `heartbeat_ms` (the listener lease reuses them), `inbox_retention_days` (optional, default 14, a positive integer or startup fails: inbox rows older than this that every reader has passed are deleted).

`fake-stream` (`FakeStreamSource`, source type `slack_thread`) is **test-only**: it lives in `tests/helpers/fakes.ts`, is added with `withPlugin` through `fakeStreamRegistry()` in tests only, and is not in `REGISTRY`, so config cannot select it.

`fake-slack-poll` (`FakeSlackPollSource`, a poll source of type `slack_thread`) is **test-only** in the same way, through `fakeSlackPollRegistry()`; tests use it as the second source next to GitHub.

Switch back / disable: `"source": "github-issues"` (or drop the other names from the list). There is no "off".

## History

- **Several sources** (changed 2026-11-01). Before: `plugins.source` took one name and every comment, 👀, status and close went through that one adapter.
- **`local` tables** (changed 2026-11-07, issue #281). Before: `poll` and `postComment` read and wrote migration 21's local-only command and message tables; now they use `command_inbox` and `item_thread` through the same store methods.

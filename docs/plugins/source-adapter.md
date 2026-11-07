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

- `slack`: `SlackSource` (issue #109). A stream source of type `slack_thread` on Slack Socket Mode, through `SlackWebClient` (`src/impl/source/slack-client.ts`): Node's built-in `WebSocket` and `fetch`, no Slack SDK.
  - Intake: a mention of the bot in a listed channel gives one `item_requested` for its thread, source id `slack:<team id>:<channel id>:<thread ts>`; the title is the first line of the mention without the bot mention. A message in a channel not on the list, a bot's message, an edit, and a top-level message without a mention start nothing (acked at once, never stored). Each pushed event's `dedupe_key` is Slack's event id (a button press: `action:<action ts>`), so a replay after a reconnect is one inbox row. Acks follow the inbox write, as for every stream source.
  - Replies in the item's thread and button presses become the same events as a GitHub comment (the `local` source's `commentEvent` parser): `/approve`, `/reject <reason>`, `/revise <feedback>`, `/retry`, `/resolve`, `/budget`, `/help`, `/verdict`, unknown commands, plain comments (`/link` included). A message that mentions the bot is intake only, never also a command. Identities are provider `slack`, subject the Slack user id; no display name or user name is read, stored or logged. The controller's `AuthProvider` check decides every one; outside GitHub, `/help` and unknown commands are checked too, and an unknown account gets the refusal reply in the thread.
  - Buttons: a message that ends with the command footer gets one button per command that takes no text and applies now (approve, retry, resolve, budget, help), read from that footer, which is built from the command table in `src/core/commands.ts`. A plain-language suggestion gets Confirm (carries the suggested command, which then runs as if typed) and Cancel (starts nothing).
  - `postComment`: reads the thread's replies (`conversations.replies` with metadata) and posts nothing when a message carries the marker in its metadata (`factory_comment`), so each marker posts at most once; returns the thread's link. Everything posted (text and button values) passes the `EgressScanner` first. A blocked message is not posted and never retried in any form: the thread gets one fixed withheld notice that carries the same marker, and the log line names the rule only. `markSeen`, `setStatus` and `closeIssue` do nothing (no `reactions:write` scope, no labels, threads do not close).
  - Once the item has a PR, the controller posts its link in the thread once (marker `pr-link:<number>`); review, checks and the merge run on GitHub as for any item.
  - Enable: add the `slack` block with `channels`, a non-empty list of channel IDs (`C…` or `G…`, never names; any other key fails at startup), and list the source next to GitHub: `"source": ["github-issues", "slack"]`. One-time Slack app setup: SET_UP.md, "Slack threads".
  - Secrets: `SLACK_APP_TOKEN` (app-level token, `connections:write`: opens the Socket Mode connection) and `SLACK_BOT_TOKEN` (bot token: reads thread replies, posts messages). Read from the `SecretStore` only inside `SlackWebClient`, at the point of use, into the Authorization header; never into an event, a log line, an error or a message. It reads no GitHub credential. `build()` passes every source the secret store, the egress scanner and the clock beyond the typed source context.
  - Switch back: `"source": "github-issues"` (or drop `"slack"` from the list). The `slack` block may stay; it is still checked.

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
- **Slack source** (added 2026-11-01, issue #109). Before: no real stream source existed; Slack items could only come from the test-only fakes.
- **`local` tables** (changed 2026-11-07, issue #281). Before: `poll` and `postComment` read and wrote migration 21's local-only command and message tables; now they use `command_inbox` and `item_thread` through the same store methods.

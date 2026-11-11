# 12. Notification channels

Status: design only. Nothing here is built yet (see "Not yet built").

- **A person picks where they are notified (new decision, 2026-11-11, work item wi_811f4a45).** Before, every reply goes only to the item's own source (per-item routing, `docs/plugins/source-adapter.md`). Now a message may go to one channel or several, by a setting the person owns. Building it is a separate, later item.
  - **Picker choices.** A choice is a non-empty set of channels: a single channel (`slack`) or several (`slack` + `github`). `local` (the item's thread in the store) is always written and is not a choice. A channel is the name of a source adapter in `plugins.source`. A channel the process has no adapter for is not an error: its rows wait in the outbox, as they do today.
  - **Who sets it.** Per person, with an optional per-item override. Order of resolution: the item's override, else the requester's own choice, else the default (the item's own source only, today's behaviour). The override can only be set by someone allowed to act on the item.
  - **Where it is stored.** In the store, keyed by user ID (the person's factory user ID) and, for an override, the work item ID. Agent-sent messages are keyed by the agent ID of the sender. Never a display name. The picker's table and migration are part of the later build.
  - **Fan-out through the outbox.** The thread entry stays the single record of the message (written once, as today). The outbox step creates **one outbox row per chosen channel**, keyed on (thread entry, channel). Each row is delivered once to its channel's adapter, with backoff on failure. A failure, outage or rate limit on one channel delays only that channel's row; the other rows are delivered on their own schedule. A second replica or a repeated handler finds the same keys and adds nothing.
  - **Vendor features are optional capabilities of the adapter.** The core sends one neutral message (text plus a few neutral hints, for example "acknowledged" or "needs you"). Each source adapter may declare optional methods or flags that render a hint its own way, the way `fileIssue` and `fileSubIssue` are optional today: Slack may map "acknowledged" to an emoji reaction and keep its formatting; GitHub may map it to a label. The controller checks that the method is present and never reads a source type. An adapter without the capability gets the plain text. A new source adds its own features without a change to the core or to the other adapters.
  - **Local first.** A local action (intake, spec, command, branch, review, merge) is authorized and applied locally and never waits on a channel. The thread entry is written first; delivery to Slack, GitHub or any sync plugin happens afterwards from the outbox. A Slack or GitHub outage does not stop local work; it only leaves that channel's rows pending until it returns.
  - **Solo default.** One person, one machine, no setup: identity from git `user.email`, then the OS user, then `anonymous`. With no choice stored, the message goes to the item's own source only, as today. The solo user can set a choice in the local store with no account on any external service.
  - **Enterprise setting.** Many people on a shared store (MySQL): each person's channel choice lives in the store by user ID, so replicas read the same choice; agents are identified by agent ID. Which channels a person may choose follows their linked accounts and grants (design 08-permissions). An org may restrict the allowed channels in the reviewed config.
  - **Not yet built.** Everything above. A later build would touch:
    - the outbox step: create one row per channel and key it on (entry, channel) (`src/controller/` outbox unit and the outbox table);
    - the source adapter interface (`src/interfaces/`): the optional rendering capabilities, and each adapter's plugin topic file in `docs/plugins/`;
    - the store: a choice table by user ID, with an optional per-item override, with SQLite and MySQL migrations;
    - config: the allowed-channels setting and the default;
    - the commands or dashboard control that set the choice.
    It should be split into small items (store and resolution, then fan-out, then capabilities, then the control).

## History

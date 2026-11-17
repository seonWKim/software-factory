# Software factory: design index

The design of the factory. Living document: change it when a decision changes.

Read this index first, then open only the topic files your change touches. Each topic file states its current
decision first; replaced decisions are in `history/<topic>.md`. A design change edits the topic file, never this
index. Add a line here only for a new topic file. Topic files keep the old section numbers: "§5" means `05-*`.

## 1. Shape
- [01-shape.md](design/01-shape.md): the flow from intake to the human gate and post-merge.

## 2. Work item
- [02-work-item.md](design/02-work-item.md): the one work-item shape for every source.
- [02-tasks.md](design/02-tasks.md): plain tasks, never work items: quick add, `task add`, repeats.
- [02-tasks-page.md](design/02-tasks-page.md): what the Tasks page lists, edits and completes.
- [02-tasks-calendar.md](design/02-tasks-calendar.md): the calendar component, its Google sync, events in task views.

## 3. Risk
- [03-risk.md](design/03-risk.md): how the tier is set and rechecked, and the safety ratchet.

## 4. Agents
- [04-agents.md](design/04-agents.md): the agent roles, model class per run kind and tier, "In short".
- [04-gate-commands.md](design/04-gate-commands.md): the human commands, refusals, footers, app requests, verdict buttons.
- [04-spec-gate-commands.md](design/04-spec-gate-commands.md): spec answers, `/revise` and `/resolve` forms, widening allowed paths.
- [04-chat-commands.md](design/04-chat-commands.md): commands in your own words: classifier, chat answers, proposals.
- [04-verdicts.md](design/04-verdicts.md): `/verdict` on every surface, implicit verdicts, pushback capture.
- [04-closing-source-issue.md](design/04-closing-source-issue.md): closing the source issue stops the item, its runs and its PR.
- [04-pre-push-gates.md](design/04-pre-push-gates.md): the scope, size and floor gates before a push, and sync with the base.
- [04-triage.md](design/04-triage.md): path companions, files triage adds to allowed paths, topic folders.
- [04-split-specs.md](design/04-split-specs.md): size estimates, splitting a big spec into phases, the phase hold.

## 5. Coordination
- [05-coordination.md](design/05-coordination.md): isolation, claim order, leases and fencing, the SQLite store.
- [05-dependencies.md](design/05-dependencies.md): parallel workers, hold policy, cost threshold, hotspots, dependency reads.
- [05-restarts.md](design/05-restarts.md): stalled runs, the model probe, retries, backoff, sending to a human.
- [05-restart-asks.md](design/05-restart-asks.md): runs that ask for allowed paths, test paths or an unmerged dependency.
- [05-restart-pauses.md](design/05-restart-pauses.md): restart history, claim pauses, rate limits, `checks_env`, drains.
- [05-alarms.md](design/05-alarms.md): the alarm step: repeated errors, zero-token runs.
- [05-sandbox.md](design/05-sandbox.md): the sandbox interface, one git folder per run, guarded tools.
- [05-merge-conflict.md](design/05-merge-conflict.md): update runs on unmergeable PRs, the automatic resolve, `/resolve`.
- [05-ci-gate.md](design/05-ci-gate.md): the CI workflow and the controller's check gate before a merge.
- [05-sources.md](design/05-sources.md): local items and startup, thread and outbox, CLI intake.
- [05-slack-intake.md](design/05-slack-intake.md): Slack presses, mentions, spec messages, replies, reactions.
- [05-github-sync.md](design/05-github-sync.md): the GitHub client, PRs through the forge, sync records, call budget.
- [05-stream-intake.md](design/05-stream-intake.md): local and stream intake, several sources, adopted PRs.
- [05-interactive-sessions.md](design/05-interactive-sessions.md): a person's own LLM session on an item as an `interactive` run.
- [05-status-labels.md](design/05-status-labels.md): the eight status labels and when the controller sets them.
- [05-standing-approvals.md](design/05-standing-approvals.md): what every spec decision records, the run check.

## 6. Measurement
- [06-measurement.md](design/06-measurement.md): the feedback rate, revert tracking, `factory stats`, the golden set.
- [06-token-budget.md](design/06-token-budget.md): per-tier token budget checkpoints and what a run's tokens count.
- [06-spend.md](design/06-spend.md): spend per day, week and item, and dollar budgets.

## 7. Self-improvement
- [07-self-improvement.md](design/07-self-improvement.md): how the factory changes its own behaviour, the doc index in the prompt.
- [07-improve-report.md](design/07-improve-report.md): the improve report, Run now, retire suggestions, improve triggers.

## 8. Operations
- [08-plugins.md](design/08-plugins.md): named plugins and the registry, login plugin, secret names.
- [08-self-update.md](design/08-self-update.md): running from a copy of the base branch, the start-then-drain update.
- [08-settings.md](design/08-settings.md): settings in layers that may only tighten a gate, runtime changes.
- [08-settings-page.md](design/08-settings-page.md): the Settings page, file-only keys through a local branch.
- [08-permissions.md](design/08-permissions.md): the owner's local check (`OwnerAuth`), identity, size limits.
- [08-enterprise.md](design/08-enterprise.md): one owner with many workers, local first, tools, audit, identity.
- [08-teardown.md](design/08-teardown.md): `factory teardown`: what setup leaves, removes, keeps.
- [08-retention.md](design/08-retention.md): the daily retention pass and its periods.

## 9. Status page
- [09-status-page.md](design/09-status-page.md): the read-only status page, its guards, the "Needs you" list.
- [09-health.md](design/09-health.md): the Health panel and the read-only schema probe.
- [09-dashboard-app.md](design/09-dashboard-app.md): the dashboard app shell, JSON API, `/app/`, responsive check.
- [09-dashboard-tasks.md](design/09-dashboard-tasks.md): the Tasks page, Calendar page, Needs you, Project switcher.
- [09-dashboard-rules.md](design/09-dashboard-rules.md): the Rules page: verdicts, Applied rules, Promote, Retire, Run now.
- [09-dashboard-settings.md](design/09-dashboard-settings.md): the Settings page and the Plugins page.
- [09-dashboard-system.md](design/09-dashboard-system.md): the Work tree, Workers, Failures, Spend and Data pages.
- [09-dashboard-item.md](design/09-dashboard-item.md): the item page: thread, transcripts, why an item waits.
- [09-dashboard-item-commands.md](design/09-dashboard-item-commands.md): item commands: decision box, buttons, dialogs, Merge button.
- [09-status-banner.md](design/09-status-banner.md): the banner that shows what the update supervisor is doing.
- [09-notifications.md](design/09-notifications.md): owner notices: `controller_notices`, kinds, quiet hours.
- [09-desktop-app.md](design/09-desktop-app.md): the macOS app that runs the supervisor and shows the dashboard.
- [09-brand-and-tokens.md](design/09-brand-and-tokens.md): the one token source, generated `tokens.css`, the no-hex rule.
- [09-dashboard-complexity.md](design/09-dashboard-complexity.md): audit of the dashboard's pages, simplification proposals.

## 10. Event-driven factory
- [10-event-driven.md](design/10-event-driven.md): the RFC 0015 move, tables, migrations, journaled runs, merge queue.
- [10-event-bus.md](design/10-event-bus.md): the sql bus, consumer groups, dead letters, inbound, controller units.
- [10-event-outbound.md](design/10-event-outbound.md): outbound deliveries and retry, run roles, hooks.

## 11. Packs and signal ledger
- [11-packs.md](design/11-packs.md): pack layers (base, org, project, learned) and the `packs` key.
- [11-plugin-import.md](design/11-plugin-import.md): `factory plugins import` of skills and MCP servers.
- [11-signal-ledger.md](design/11-signal-ledger.md): the `controller_signals` table, signal sources, tags, backfill.

## 12. Notification channels
- [12-notification-channels.md](design/12-notification-channels.md): per-person channel picker, outbox rows; design only.

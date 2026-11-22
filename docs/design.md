# Software factory: design index

Read this index, then only the topics your change touches. A topic states its current decision
first, replaced ones in `history/<topic>.md`. A design change edits the topic file; add a line here only
for a new topic. "§5" means `05-*`.

## 1. Shape
- [01-shape.md](design/01-shape.md): flow from intake to the human gate and post-merge.

## 2. Work item
- [02-work-item.md](design/02-work-item.md): one work-item shape for every source.
- [02-tasks.md](design/02-tasks.md): plain tasks, never work items: quick add, `task add`, repeats.
- [02-tasks-page.md](design/02-tasks-page.md): what the Tasks page lists, edits and completes.
- [02-tasks-calendar.md](design/02-tasks-calendar.md): calendar component, Google sync, events in tasks.

## 3. Risk
- [03-risk.md](design/03-risk.md): how the tier is set and rechecked, and the safety ratchet.

## 4. Agents
- [04-agents.md](design/04-agents.md): agent roles, model class per run kind and tier, "In short".
- [04-gate-commands.md](design/04-gate-commands.md): human commands, refusals, footers, verdict buttons.
- [04-spec-gate-commands.md](design/04-spec-gate-commands.md): spec answers, `/revise`, `/resolve`.
- [04-chat-commands.md](design/04-chat-commands.md): plain-words classifier, chat answers, proposals.
- [04-verdicts.md](design/04-verdicts.md): `/verdict` everywhere, implicit verdicts, pushback capture.
- [04-closing-source-issue.md](design/04-closing-source-issue.md): closing the source issue stops item, runs, PR.
- [04-pre-push-gates.md](design/04-pre-push-gates.md): scope, size and floor gates before a push.
- [04-triage.md](design/04-triage.md): path companions, files triage adds to allowed paths, topic folders.
- [04-split-specs.md](design/04-split-specs.md): size estimates, splitting a spec into phases, phase hold.

## 5. Coordination
- [05-coordination.md](design/05-coordination.md): isolation, claim order, leases, fencing, SQLite.
- [05-dependencies.md](design/05-dependencies.md): parallel workers, hold policy, cost.
- [05-restarts.md](design/05-restarts.md): stalled runs, model probe, retries, backoff, human handoff.
- [05-restart-asks.md](design/05-restart-asks.md): runs that ask for paths or a dependency.
- [05-restart-pauses.md](design/05-restart-pauses.md): claim pauses, rate limits, `checks_env`, drains.
- [05-alarms.md](design/05-alarms.md): alarm step: repeated errors, zero-token runs.
- [05-sandbox.md](design/05-sandbox.md): sandbox interface, one git folder per run, guarded tools.
- [05-merge-conflict.md](design/05-merge-conflict.md): update runs on unmergeable PRs, `/resolve`.
- [05-ci-gate.md](design/05-ci-gate.md): CI workflow and the controller's check gate before a merge.
- [05-sources.md](design/05-sources.md): local items and startup, thread and outbox, CLI intake.
- [05-slack-intake.md](design/05-slack-intake.md): Slack presses, mentions, spec posts, replies, emoji.
- [05-github-sync.md](design/05-github-sync.md): GitHub client, forge PRs, sync records, call budget.
- [05-stream-intake.md](design/05-stream-intake.md): local and stream intake, many sources, adopted PRs.
- [05-interactive-sessions.md](design/05-interactive-sessions.md): own LLM session as a run.
- [05-status-labels.md](design/05-status-labels.md): eight status labels, when the controller sets them.
- [05-standing-approvals.md](design/05-standing-approvals.md): what spec decisions record, the run check.

## 6. Measurement
- [06-measurement.md](design/06-measurement.md): feedback rate, reverts, `factory stats`.
- [06-token-budget.md](design/06-token-budget.md): per-tier token checkpoints, what a run's tokens count.
- [06-spend.md](design/06-spend.md): spend per day, week and item, and dollar budgets.
- [06-efficiency.md](design/06-efficiency.md): items finished per period; tokens and time per item.

## 7. Self-improvement
- [07-self-improvement.md](design/07-self-improvement.md): how the factory changes itself.
- [07-conflict-hotspots.md](design/07-conflict-hotspots.md): hotspots.
- [07-learned-rules.md](design/07-learned-rules.md): learned rules.
- [07-improve-report.md](design/07-improve-report.md): improve report, Run now, retirement.
- [07-design-learnings.md](design/07-design-learnings.md): UI corrections.

## 8. Operations
- [08-plugins.md](design/08-plugins.md): named plugins and the registry, login plugin, secret names.
- [08-self-update.md](design/08-self-update.md): base-branch copy, start-then-drain update.
- [08-settings.md](design/08-settings.md): layered settings that only tighten gates, runtime changes.
- [08-settings-page.md](design/08-settings-page.md): Settings page, file-only keys via a local branch.
- [08-permissions.md](design/08-permissions.md): owner's local check (`OwnerAuth`), identity, size limits.
- [08-enterprise.md](design/08-enterprise.md): one owner, many workers, local first.
- [08-teardown.md](design/08-teardown.md): `factory teardown`: what setup leaves, removes, keeps.
- [08-retention.md](design/08-retention.md): daily retention pass and its periods.

## 9. Status page
- [09-status-page.md](design/09-status-page.md): read-only status page, its guards.
- [09-health.md](design/09-health.md): Health panel, schema probe.
- [09-dashboard-app.md](design/09-dashboard-app.md): index of dashboard topics.
- [09-dashboard-shell.md](design/09-dashboard-shell.md): sidebar, top bar, theme, mode.
- [09-dashboard-components.md](design/09-dashboard-components.md): shared pieces, plain words, i18n.
- [09-dashboard-search.md](design/09-dashboard-search.md): `⌘K` search, `?` help.
- [09-dashboard-api.md](design/09-dashboard-api.md): API, serving, responsive check.
- [09-dashboard-activity.md](design/09-dashboard-activity.md): Activity page.
- [09-dashboard-runners.md](design/09-dashboard-runners.md): Runners page, Migrate now.
- [09-dashboard-tasks.md](design/09-dashboard-tasks.md): Tasks list, row, Needs you.
- [09-dashboard-tasks-quick-add.md](design/09-dashboard-tasks-quick-add.md): Quick add.
- [09-dashboard-tasks-calendar.md](design/09-dashboard-tasks-calendar.md): Calendar page.
- [09-dashboard-tasks-projects.md](design/09-dashboard-tasks-projects.md): Project switcher.
- [09-dashboard-rules.md](design/09-dashboard-rules.md): Rules: verdicts, Promote, Retire.
- [09-dashboard-proposals.md](design/09-dashboard-proposals.md): Proposals page.
- [09-dashboard-settings.md](design/09-dashboard-settings.md): Settings and Plugins.
- [09-dashboard-system.md](design/09-dashboard-system.md): Work, Failures, Spend, Data.
- [09-dashboard-workers.md](design/09-dashboard-workers.md): run timeline, dependency graph.
- [09-dashboard-item.md](design/09-dashboard-item.md): item page, thread, transcripts.
- [09-dashboard-item-commands.md](design/09-dashboard-item-commands.md): item commands, dialogs.
- [09-status-banner.md](design/09-status-banner.md): supervisor banner.
- [09-notifications.md](design/09-notifications.md): owner notices, kinds, quiet hours.
- [09-desktop-app.md](design/09-desktop-app.md): macOS app.
- [09-brand-and-tokens.md](design/09-brand-and-tokens.md): design tokens, no-hex rule.
- [09-dashboard-complexity.md](design/09-dashboard-complexity.md): dashboard page audit.

## 10. Event-driven factory
- [10-event-driven.md](design/10-event-driven.md): tables, migrations, journaled runs, merge queue.
- [10-event-bus.md](design/10-event-bus.md): sql bus, consumer groups, dead letters, inbound, units.
- [10-event-outbound.md](design/10-event-outbound.md): outbound deliveries, retry, run roles, hooks.

## 11. Packs and signal ledger
- [11-packs.md](design/11-packs.md): pack layers (base, org, project, learned), the `packs` key.
- [11-plugin-import.md](design/11-plugin-import.md): `plugins import` of skills and MCP servers.
- [11-signal-ledger.md](design/11-signal-ledger.md): `controller_signals` table, sources, tags, backfill.

## 12. Notification channels
- [12-notification-channels.md](design/12-notification-channels.md): channel picker, outbox rows.

# Software factory: design index

Read this index, then only the topics you touch. Add a line here only for a new topic. "§5" means `05-*`.

## 1. Shape
- [01-shape.md](design/01-shape.md): intake to human gate and post-merge.

## 2. Work item
- [02-work-item.md](design/02-work-item.md): one shape for all sources.
- [02-attachments.md](design/02-attachments.md): triage context, images, links.
- [02-tasks.md](design/02-tasks.md): table, `task add`, route.
- [02-tasks-quick-add.md](design/02-tasks-quick-add.md): quick-add words, repeats.
- [02-tasks-projects.md](design/02-tasks-projects.md): task projects.
- [02-tasks-build.md](design/02-tasks-build.md): Build this, merge close.
- [02-tasks-edit.md](design/02-tasks-edit.md): edit, delete, sub-tasks.
- [02-tasks-page.md](design/02-tasks-page.md): the Tasks page.
- [02-tasks-calendar.md](design/02-tasks-calendar.md): calendar, Google sync.

## 3. Risk
- [03-risk.md](design/03-risk.md): tier and safety ratchet.

## 4. Agents
- [04-agents.md](design/04-agents.md): agent roles, models.
- [04-gate-commands.md](design/04-gate-commands.md): human commands.
- [04-spec-gate-commands.md](design/04-spec-gate-commands.md): spec answers, `/revise`.
- [04-chat-commands.md](design/04-chat-commands.md): chat commands.
- [04-chat-agent](design/04-chat-agent.md): turns.
- [04-verdicts.md](design/04-verdicts.md): `/verdict`, implicit verdicts, pushbacks.
- [04-closing-source-issue.md](design/04-closing-source-issue.md): closing source.
- [04-pre-push-gates.md](design/04-pre-push-gates.md): pre-push gates.
- [04-triage.md](design/04-triage.md): path companions, allowed paths.
- [04-split-specs.md](design/04-split-specs.md): size estimates, phases.
- [04-screenshots.md](design/04-screenshots.md): UI screenshots.

## 5. Coordination
- [05-coordination.md](design/05-coordination.md): claims, leases, fencing.
- [05-dependencies.md](design/05-dependencies.md): parallel workers, holds.
- [05-restarts.md](design/05-restarts.md): stalled runs, retries.
- [05-restart-asks.md](design/05-restart-asks.md): runs asking for paths.
- [05-restart-pauses.md](design/05-restart-pauses.md): claim pauses, drains.
- [05-alarms.md](design/05-alarms.md): repeated errors, zero-token runs.
- [05-sandbox.md](design/05-sandbox.md): interface, run folders, tools.
- [05-merge-conflict.md](design/05-merge-conflict.md): update runs, `/resolve`.
- [05-ci-gate.md](design/05-ci-gate.md): CI workflow, check gate.
- [05-sources.md](design/05-sources.md): local items, outbox.
- [05-slack-intake.md](design/05-slack-intake.md): Slack intake.
- [05-github-sync.md](design/05-github-sync.md): GitHub client, PRs.
- [05-stream-intake.md](design/05-stream-intake.md): stream intake, adopted PRs.
- [05-interactive-sessions.md](design/05-interactive-sessions.md): interactive run.
- [05-status-labels.md](design/05-status-labels.md): the eight status labels.
- [05-standing-approvals.md](design/05-standing-approvals.md): spec decisions.

## 6. Measurement
- [06-measurement.md](design/06-measurement.md): feedback rate, stats.
- [06-token-budget.md](design/06-token-budget.md): token checkpoints.
- [06-spend.md](design/06-spend.md): spend per day, week, item.
- [06-efficiency.md](design/06-efficiency.md): per-period totals.

## 7. Self-improvement
- [07-self-improvement.md](design/07-self-improvement.md): self-change.
- [07-conflict-hotspots.md](design/07-conflict-hotspots.md): hotspots.
- [07-learned-rules.md](design/07-learned-rules.md): learned rules.
- [07-improve-report.md](design/07-improve-report.md): improve report, retirement.
- [07-design-learnings.md](design/07-design-learnings.md): UI corrections.

## 8. Operations
- [08-plugins.md](design/08-plugins.md): plugins, registry, secret names.
- [08-self-update.md](design/08-self-update.md): base-branch copy, drain update.
- [08-settings.md](design/08-settings.md): layered settings, tighten only.
- [08-settings-page.md](design/08-settings-page.md): Settings page, file-only keys.
- [08-permissions.md](design/08-permissions.md): `OwnerAuth`, identity, size limits.
- [08-enterprise.md](design/08-enterprise.md): one owner, many workers, local first.
- [08-teardown.md](design/08-teardown.md): `factory teardown`.
- [08-retention.md](design/08-retention.md): daily retention pass.
- [08-cleanup.md](design/08-cleanup.md): closed items' leftovers.
- [08-schedules.md](design/08-schedules.md): schedules and runs.
- [08-schedules-actions.md](design/08-schedules-actions.md): actions.
- [08-schedules-manage.md](design/08-schedules-manage.md): writes.

## 9. Status page
- [09-status-page.md](design/09-status-page.md): read-only status page.
- [09-health.md](design/09-health.md): Health panel, schema probe.
- [09-dashboard-app.md](design/09-dashboard-app.md): dashboard index.
- [09-dashboard-shell.md](design/09-dashboard-shell.md): sidebar, top bar.
- [09-dashboard-components.md](design/09-dashboard-components.md): shared pieces, i18n.
- [09-dashboard-search.md](design/09-dashboard-search.md): `⌘K` search.
- [09-dashboard-api.md](design/09-dashboard-api.md): API, serving.
- [09-api-registry.md](design/09-api-registry.md): capability registry, feature map, OpenAPI.
- [09-dashboard-activity.md](design/09-dashboard-activity.md): Activity page.
- [09-dashboard-runners.md](design/09-dashboard-runners.md): Runners page.
- [09-dashboard-tasks.md](design/09-dashboard-tasks.md): Tasks list, row.
- [09-dashboard-tasks-needs.md](design/09-dashboard-tasks-needs.md): Needs you.
- [09-dashboard-tasks-quick-add.md](design/09-dashboard-tasks-quick-add.md): Quick add.
- [09-dashboard-tasks-calendar.md](design/09-dashboard-tasks-calendar.md): Calendar page.
- [09-dashboard-schedules.md](design/09-dashboard-schedules.md): Schedules page.
- [09-dashboard-tasks-projects.md](design/09-dashboard-tasks-projects.md): Projects.
- [09-dashboard-rules.md](design/09-dashboard-rules.md): Rules page.
- [09-dashboard-rules-waiting.md](design/09-dashboard-rules-waiting.md): waiting rows.
- [09-dashboard-rules-applied.md](design/09-dashboard-rules-applied.md): applied rules.
- [09-dashboard-rules-standing.md](design/09-dashboard-rules-standing.md): standing rules.
- [09-dashboard-proposals.md](design/09-dashboard-proposals.md): Proposals page.
- [09-dashboard-settings.md](design/09-dashboard-settings.md): Settings and Plugins.
- [09-dashboard-system.md](design/09-dashboard-system.md): Work, Spend, Data.
- [09-dashboard-workers.md](design/09-dashboard-workers.md): run timeline.
- [09-dashboard-evals.md](design/09-dashboard-evals.md): a skill's evals page.
- [09-dashboard-item.md](design/09-dashboard-item.md): item page.
- [09-dashboard-item-commands.md](design/09-dashboard-item-commands.md): item commands.
- [09-dashboard-item-about.md](design/09-dashboard-item-about.md): item About.
- [09-dashboard-item-runs.md](design/09-dashboard-item-runs.md): item Runs.
- [09-dashboard-item-thread.md](design/09-dashboard-item-thread.md): item Thread.
- [09-dashboard-item-actions.md](design/09-dashboard-item-actions.md): item actions.
- [09-status-banner.md](design/09-status-banner.md): supervisor banner.
- [09-notifications.md](design/09-notifications.md): owner notices.
- [09-desktop-app.md](design/09-desktop-app.md): macOS app.
- [09-brand-and-tokens.md](design/09-brand-and-tokens.md): design tokens.
- [09-dashboard-complexity.md](design/09-dashboard-complexity.md): page audit.

## 10. Event-driven factory
- [10-event-driven.md](design/10-event-driven.md): tables, migrations, merge queue.
- [10-event-bus.md](design/10-event-bus.md): sql bus, dead letters.
- [10-event-outbound.md](design/10-event-outbound.md): outbound delivery.

## 11. Packs and signal ledger
- [11-packs.md](design/11-packs.md): pack layers, the `packs` key.
- [11-plugin-import.md](design/11-plugin-import.md): `plugins import`.
- [11-signal-ledger.md](design/11-signal-ledger.md): signal ledger.

## 12. Notification channels
- [12-notification-channels.md](design/12-notification-channels.md): channel picker.

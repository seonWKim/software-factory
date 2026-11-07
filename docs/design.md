# Company software factory: design index

The design of the factory. Living document: change it when a decision changes.

How to use it: read this index first, then open only the topic files your change touches. Each topic file
states its current decision first; its older decisions and their dates are under "History" at the bottom.
A design change edits the topic file (current text, plus one History line for what it replaces), never this
index. Add a line here only for a new topic file. Topic files keep the old section numbers, so "§5" means
the `05-*` files.

## 1. Shape
- [01-shape.md](design/01-shape.md): the flow from intake through triage, implement, review and the human gate to post-merge.

## 2. Work item
- [02-work-item.md](design/02-work-item.md): the one work-item shape for every source, and projects keyed by the forge's repository ID.

## 3. Risk
- [03-risk.md](design/03-risk.md): how the tier is set and rechecked, which tiers need a human, and the safety ratchet.

## 4. Agents
- [04-agents.md](design/04-agents.md): the agent roles, the model class per run kind and tier, the GitHub gate and the "In short" opening.
- [04-gate-commands.md](design/04-gate-commands.md): the human commands (`/approve`, `/reject`, `/revise`, `/verdict`, `/help`), refusals, footers and suggestions, and `/revise` or "Request changes" on a pull request.
- [04-closing-source-issue.md](design/04-closing-source-issue.md): closing the source issue stops the item, its runs and its PR.
- [04-pre-push-gates.md](design/04-pre-push-gates.md): the scope, size and floor gates before a push, sync with the base, and the resolve run's gates.
- [04-split-specs.md](design/04-split-specs.md): triage size estimates, splitting a big spec into phases, and the phase hold.

## 5. Coordination
- [05-coordination.md](design/05-coordination.md): isolation, parallel workers and claim order, dependencies and the coordination cost threshold, leases and fencing, the store backend and MySQL schema steps.
- [05-restarts.md](design/05-restarts.md): stalled runs and the model probe, how failed runs are retried, backed off, paused, resumed or sent to a human.
- [05-sandbox.md](design/05-sandbox.md): the sandbox interface, one git folder per run, and the guarded file and shell tools.
- [05-merge-conflict.md](design/05-merge-conflict.md): update runs on unmergeable PRs, the automatic resolve, and `/resolve`.
- [05-ci-gate.md](design/05-ci-gate.md): the CI workflow and the controller's check gate before a merge.
- [05-sources.md](design/05-sources.md): stream intake, several sources at once, and adopting PRs and pushes a person makes.
- [05-status-labels.md](design/05-status-labels.md): the eight status labels and when the controller sets them.

## 6. Measurement
- [06-measurement.md](design/06-measurement.md): the feedback rate, revert and fix-forward tracking, `factory stats`, and the reviewer's golden set.
- [06-token-budget.md](design/06-token-budget.md): per-tier token budget checkpoints, and what a run's tokens and cost count.

## 7. Self-improvement
- [07-self-improvement.md](design/07-self-improvement.md): how the factory changes its own behaviour, and the doc index in the prompt.

## 8. Enterprise
- [08-plugins.md](design/08-plugins.md): named plugins and the discovered registry, the GitHub login plugin, declared secret names, keep awake.
- [08-self-update.md](design/08-self-update.md): running from a copy of the base branch, and the start-then-drain update.
- [08-settings.md](design/08-settings.md): per-project settings resolved in layers that may only tighten a gate, and changing settings at runtime (`factory settings`) with no PR.
- [08-permissions.md](design/08-permissions.md): factory users, linked accounts, grants and roles, and the checked-in size limits.
- [08-enterprise.md](design/08-enterprise.md): interfaces with local and cloud backends, environments, tools, auth classes, audit and identity.

## 9. Status page
- [09-status-page.md](design/09-status-page.md): the read-only status page, its guards, the "Needs you" list, the dashboard order and refresh.
- [09-health.md](design/09-health.md): the Health panel and the read-only schema probe.
- [09-dashboard-app.md](design/09-dashboard-app.md): the client dashboard app, its read-only JSON API and how `/app/` is served.
- [09-status-banner.md](design/09-status-banner.md): the banner that shows what the update supervisor is doing.

## Plans
- [phase-2-backlog.md](design/phase-2-backlog.md): the design-side order of the Phase 2 work.
- [first-build.md](design/first-build.md): the suggested build order for the first local version.

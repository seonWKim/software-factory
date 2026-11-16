# Work item wi_7eab5b4145a84b0e834578d30bf3e580

Source: https://github.com/seonWKim/software-factory/issues/246

## Problem

Merging is the last human gate, and it has no factory-side path. The factory reads "ready to merge" (merge_pending in src/core/commands.ts and src/core/status-label.ts), but no code merges a PR. Auto-merge is fixed at 0 (src/compose.ts), and the GitHub tool broker has open_pr but no merge tool (src/impl/broker/github-tool-broker.ts). The SourceAdapter interface (src/interfaces/source-adapter.ts) has no merge action, and there is no Forge interface at all. The dashboard is read-only: it serves GET and HEAD only, and its design says commands are not in the app yet (docs/design/09-dashboard-app.md). This spec depends on #172 (Forge) and #213 (app commands), and neither is merged.

## Done criteria
- With the GitHub forge, Merge on a ready item merges the PR through the bot, and the item closes as completed (flow test with the fake forge).
- With the local forge, Merge puts the branch's commits on the base branch, and the item closes, with no GitHub call (flow test).
- Merge is refused and nothing changes (no merge call, no stage or block change) when the item is not ready to merge (test).
- Merge is refused when a check is failed or still pending (test).
- Merge is refused when commits arrived after the reviewed head (test).
- Merge is refused when the branch does not merge cleanly into base (test).
- Merge is refused for a user without permission, using the same authorize check as /approve, owner only by default (test).
- The merge decision and the actor's ID are stored in the item's timeline. No display name is stored (test).
- The local merge never touches the person's own working checkout: its branch, HEAD and status are the same before and after (test).
- A second merge call on an already merged item does nothing and makes no second merge (test).
- Merge on Floor rows and the item page shows only for ready-to-merge items. The confirmation shows the title, tier, files and lines changed, and the PR link when there is one (app test).
- After confirming, the row shows merging, then leaves Needs you once merged, or shows the refusal reason next to the button (app test).
- A project with no forge setting keeps today's behaviour: no merge button, and the merge command is refused with a pointer to GitHub (test).
- Auto-merge stays as it is: auto_merge_max_tier stays 0 (existing test passes unchanged).
- docs/plugins/forge.md, docs/plugins/tool-broker.md, docs/design/04-gate-commands.md, docs/design/01-shape.md and docs/design/09-dashboard-app.md record the merge command and the local forge. The old decision (only a person on GitHub merges; the app is read-only) is kept as a History line in each file.

## Desired output

Build in three steps, each a separate PR merged by a human: (1) the merge command and the GitHub forge merge; (2) the local forge; (3) the Merge button in the app, which also needs the POST route guards. Each step's tests pass on its own. Human merge is required because the change touches the final human gate and the factory's own tools. Rollout is per project: the forge setting is off by default, so nothing changes until a project turns it on. Tests use the fake forge, and a temporary git repository for the local forge.

## Scope

In scope:
- The merge gate command: parsing, the ready-state check, the authorize check, and the timeline row.
- The controller re-check before merge: review passed, checks green, no newer commits than the reviewed head, branch mergeable.
- A Forge interface with a merge action, and its github implementation through a new broker tool.
- A local forge: merge the item's branch into base in its own worktree.
- The Merge button and confirmation on Floor rows and the item page, with a POST route in the dashboard server.
- Docs: the forge topic file, the tool-broker topic file, and the design topic files for the command, the merge gate and the app.

Out of scope:
- Auto-merge (auto_merge_max_tier stays 0).
- Merge buttons for PRs the factory did not open.
- A per-command permission model (#107).
- Slack merge buttons.
- Build-out of the Forge interface or the app's command path beyond what this merge needs (#172 and #213 own those).
- Local-first item intake: this spec does not create local work items.

## Allowed paths (do not change files outside these)
- src/core/commands.ts
- src/core/controller.ts
- src/core/config.ts
- src/config-keys.ts
- src/interfaces/forge.ts
- src/plugins.ts
- src/impl/forge/
- src/impl/broker/github-tool-broker.ts
- src/compose.ts
- src/ui/api.ts
- src/ui/app.ts
- web/src/
- docs/plugins.md
- docs/plugins/forge.md
- docs/plugins/tool-broker.md
- docs/design/01-shape.md
- docs/design/04-gate-commands.md
- docs/design/09-dashboard-app.md
- tests/merge-command.test.ts
- tests/local-forge.test.ts
- tests/merge-app.test.tsx
- tests/helpers/fakes.ts
- src/impl/github/github-tool-broker.ts
- src/impl/github/github-forge.ts
- tests/commands.test.ts
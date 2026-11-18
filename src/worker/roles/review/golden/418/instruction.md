# Work item wi_ab560f5014dd4eef96a5f46772dc9e82

Source: local:local-00d34555-7b55-47b1-a3e9-b55015fe21b6

## Problem

An item at blocked_on: human, blocked_reason: max_loops has no command entry for its phase in the command table (src/core/commands.ts). So the footer prints "No command changes this item's state now.", and the controller (src/core/controller.ts) refuses /retry because it finds no failed run to retry. It also refuses /reject and /revise because the item is not waiting for a spec. The fix is to list the three existing commands for this phase and let the controller apply them: /retry starts an implement run with a reset loop count, /revise goes back through triage, and /reject closes the item. Two existing tests assert the old last footer line of the max-loops comment: tests/flow.test.ts (around line 2049) and tests/pr-revise.test.ts (line 189). Both change in this work. No schema change and no backfill.</problem>
<parameter name="decisions">[]

## Done criteria
- A flow test in tests/flow.test.ts drives an item to max_loops (blocked_on: human, blocked_reason: max_loops), then sends /retry +paths src/core/x.ts. It checks that one implement run starts, that src/core/x.ts is in allowed_paths, that loop_count is 0, that restart_count went up by 1, and that stage is RUNNING.
- The same flow test sends /reject <reason> to an item at max_loops. It checks that the item is CLOSED with close_reason: rejected and that the source issue is closed as not planned.
- A flow test sends /revise <feedback> to an item at max_loops. It checks that the item goes to NEW with a triage run and the feedback stored, and that loop_count is 0.
- A /revise with no feedback at max_loops is refused with one reply, and the item does not change.
- commandFooter for max_loops lists /retry, /revise, /reject and /help, and no longer ends with the line "No command changes this item's state now."
- The max-loops comment on the PR ends with /help, and its last line is not "No command changes this item's state now." The assertion at tests/flow.test.ts (around line 2049) and the assertion at tests/pr-revise.test.ts (line 189) are updated to check the new last lines. The merge comment assertions are unchanged.
- The existing footer test in tests/commands.test.ts (merge_pending, no state-changing command) passes unchanged.
- /retry +paths at max_loops widens allowed_paths the same way it does after a failed implement run: at most 10 paths, no .., no glob, and covered paths are not added again.
- /retry, /revise and /reject at max_loops on a PR-bearing item behave the same as on an item without a PR.
- /retry on other phases is unchanged: a failed triage, review or update run still refuses +paths.
- SET_UP.md command table matches commandTableMarkdown(), and the existing test in tests/local-cli.test.ts that compares them passes.
- docs/design/04-gate-commands.md states the new decision first, with the replaced one as a line under its History heading.
- npm test -- tests/flow.test.ts, npm test -- tests/pr-revise.test.ts, npm test -- tests/commands.test.ts and npm test -- tests/local-cli.test.ts pass.

## Desired output

Code: in src/core/commands.ts, add max_loops to the phases of retry, revise and reject. In src/core/controller.ts: at max_loops, retryKind returns implement. retry() also sets stage: RUNNING and loop_count: 0 in its patch and uses the reset count in the run key. command() accepts spec_rejected at max_loops and routes revise_requested through reviseAfterFailure, which sets loop_count: 0 only when the item is at max_loops. Regenerate the /retry, /revise and /reject rows of the SET_UP.md table from commandTableMarkdown(). Docs: update docs/design/04-gate-commands.md. Tests: add the flow cases to tests/flow.test.ts, and update the two max-loops footer assertions in tests/flow.test.ts and tests/pr-revise.test.ts. No store migration. Solo and enterprise behaviour are the same here; no difference to name.

## Scope

In scope:
- At max_loops, /retry (with +paths and notes), /revise <feedback> and /reject <reason> apply, from the issue and from the CLI.
- task show and every footer at max_loops list these three commands and /help.
- The max-loops PR comment footer changes, and the two tests that assert its last line follow the change.
- The SET_UP.md command table and the gate-commands topic file follow the code.
- Flow tests for the three commands at max_loops.

Out of scope:
- The CI failure on #246 (node:sqlite bundling) and its unpushed fixture fix. This is a separate follow-up issue.
- Running /retry +paths tests/commands.test.ts on #246. A person does this after this change merges.
- Changing the max_loops limit or the review loop logic.
- Commands on the PR conversation at max_loops (pr_phases is unchanged).
- Dashboard buttons or any UI change.
- Backfilling existing items at max_loops.

## Allowed paths (do not change files outside these)
- src/core/commands.ts
- src/core/controller.ts
- SET_UP.md
- docs/design/04-gate-commands.md
- tests/flow.test.ts
- tests/pr-revise.test.ts
- docs/design.md
- tests/commands.test.ts
- tests/local-cli.test.ts
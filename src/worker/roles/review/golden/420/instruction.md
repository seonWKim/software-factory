# Work item wi_ad10935e7da04f079cc260c0b4627c68

Source: local:local-b4298682-c48e-458d-adce-ab6c68a4febe

## Problem

A merge-conflict resolve run may change only the conflicting files and the item's allowed paths. When the base needs one more file, such as a test that imports a file the PR moved, the run fails with out_of_scope or a typecheck failure. In the controller, `/resolve` is the only command that does not split `+paths` off its text: `commandInput` returns no paths for `resolve_requested`, and `resolveCommand` passes the raw text as the run's notes. The notes also skip the egress scan and length cap that `/retry` notes get. PR #416 (wi_ef989a91) failed twice this way, and its item stays at merge_conflict_pending.

## Done criteria
- `/resolve +paths tests/x.test.ts` on an item at merge_conflict_pending adds `tests/x.test.ts` to allowed_paths and queues one resolve run. A flow test in tests/flow.test.ts checks this.
- The resolve run's notes exclude the `+paths` line. The notes are the lines below it, or empty when there are none.
- The paths come from `parseCommandPaths` and the widening from the existing `widen` helper. No copy of either is added.
- `/resolve +paths` follows the `/retry +paths` rules: at most 10 paths, no `..`, no glob, no absolute path; a covered path is not added again. A refused path changes nothing and gets one reply.
- `/resolve` without `+paths` behaves as before: the same run input and no change to allowed_paths. The existing resolve tests pass.
- `/resolve +paths` on an item not waiting on a merge conflict, and not asking for a human, is refused. Nothing changes.
- `/resolve +paths` on an item whose resolve run asked for a human (agent_needs_human) also widens allowed_paths, and queues one resolve run.
- The command table in src/core/commands.ts shows the `/resolve +paths <path>...` usage. SET_UP.md is regenerated, and the test that checks SET_UP.md against the code passes.
- docs/design/04-gate-commands.md states the new decision first, and the old one goes under History.
- `npm test -- tests/flow.test.ts tests/commands.test.ts` passes.

## Desired output

Code: in src/core/controller.ts, `commandInput` splits `+paths` off the `/resolve` text as it does for `/retry`. `resolveCommand` takes that note and the widening, and sets allowed_paths in the same transaction as the run. The `/resolve` usage stays `/resolve [notes]` in the table, with a `+paths` sentence added to its description, like `/retry`. Tests: flow tests cover the widening, the stripped notes and the refusals. Commands test: help and table text.

## Scope

In scope:
- `/resolve +paths <path>...` on a merge-conflict item and on an agent_needs_human resolve answer
- Stripping the `+paths` line from the resolve run's notes
- Egress scan and length cap for `/resolve` notes, as for `/retry`
- Command table entry, regenerated SET_UP.md, and the design decision in docs/design/04-gate-commands.md

Out of scope:
- `/resolve +paths` on a failed resolve run (the `/retry +paths` rule for implement runs stays as it is)
- Changing the `factory resolve` local CLI usage text
- Changing how automatic resolve runs pick their notes
- Any change to the resolve prompt, the scope gate, or the conflict rules
- Backfilling resolve runs or items already stored

## Allowed paths (do not change files outside these)
- src/core/commands.ts
- src/core/controller.ts
- tests/flow.test.ts
- tests/commands.test.ts
- docs/design/04-gate-commands.md
- SET_UP.md
- docs/design.md
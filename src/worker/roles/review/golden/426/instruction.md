# Work item wi_561d68cd3abb46679ff654a3365bf6d2

Source: https://github.com/seonWKim/software-factory/issues/421

## Problem

The implement run builds the GitHub issue number with `Number(item.source.id.split("#")[1])` at four places in the worker: the merge-conflict, failed-checks, checks-env and scope-violation comments. A local item's source id has no `#`, so the number is `NaN`. When GitHub is selected, the GitHub tool broker is present, so the worker does not skip the comment and sends `issues/NaN/comments`. The review and update comments pass the PR number as `null` when there is no PR, which has the same problem. The checks-env comment also calls the broker directly and skips the existing helper. I did not trace which of the four sites fired in the two failed runs. The change makes all of them safe.

## Done criteria
- A test runs an implement for a local item with the GitHub broker selected. The fake GitHub client throws on any request whose path contains `NaN`, and the run makes no GitHub request.
- The merge-conflict, failed-checks, checks-env and scope-violation comments of a local item make no forge call and do not fail the run.
- One helper in src/core/change-ref.ts returns the GitHub issue number of a GitHub issue item from its `#<digits>` source id, and null for any other item or id. The four worker sites use it and no longer call `Number(...split("#"))`.
- forgeComment with a null number makes no broker call and returns ok. A review or update comment on an item with no PR makes no GitHub call.
- The broker's comment tool returns a failed result and makes no request when its `number` is not a positive integer. Agent-supplied args reach it, so this is the boundary check.
- A GitHub item's comments still post to its issue or PR, with the same markers and bodies. tests/pre-push-checks.test.ts and tests/worker-sync.test.ts pass unchanged.
- docs/design/05-sources.md states the decision: a local item makes no forge comment even with GitHub selected. #333 stays the follow-up for the rest of local items with GitHub.
- `npm test -- tests/local-forge-calls.test.ts tests/pre-push-checks.test.ts tests/worker-sync.test.ts tests/local-broker.test.ts` passes.

## Desired output

Code: the one helper in src/core/change-ref.ts; worker.ts uses it at the four sites and in forgeComment, and the checks-env comment goes through forgeComment, not a second direct broker call; the broker's comment tool checks its number. Tests: the new file tests/local-forge-calls.test.ts with a GitHub fake that throws on NaN, covering a local implement run, the four comment paths, and a GitHub item still posting. Docs: one decision line in docs/design/05-sources.md. Solo default: a local item never calls GitHub. Enterprise setting: a GitHub item keeps its comments, unchanged.

## Scope

In scope:
- Forge comment calls made for a local item in the implement and review runs.
- One helper that turns a GitHub item's source id into an issue number, or null.
- The broker's comment tool's check on its number.
- Tests for the NaN path and for GitHub items still posting.
- The design line for local items with GitHub selected.

Out of scope:
- Local items with GitHub selected otherwise: PR open, push, preflight and checks. This stays with #333.
- Other callers of issueNumberFromSourceId in the GitHub source and forge, which only run for GitHub items. Follow-up if they can see a non-GitHub id.
- Backfilling or re-running the failed runs of wi_c2ecf40f.
- Changing the outbox, the thread, or the command inbox.

## Allowed paths (do not change files outside these)
- src/core/worker.ts
- src/core/change-ref.ts
- src/impl/github/github-tool-broker.ts
- tests/local-forge-calls.test.ts
- docs/design/05-sources.md
- docs/design.md
# Work item wi_908a612824a1405a9ae44cda730f9d0d

Source: https://github.com/seonWKim/software-factory/issues/671

## Problem

Four runs failed with `start_to_close` across three work items (issue #671). Only the implement step is confirmed from the code. The implement kind's `run-agent` step has no override, so it gets the shared default of one hour per step (`src/worker/run-kind.ts`, `DEFAULT_TIMEOUTS`). The resolve kind raises its step to three hours with a comment that says why (`src/worker/runs/resolve/resolve.run.ts`).
The step's work is larger than the agent's own budget. The agent's limit is `run_timeout_ms`, 45 minutes by default (`src/worker/settings/run-timeout-ms.setting.ts`). The same step also runs the toolchain warm-up command, which gets its own `run_timeout_ms` budget, before the agent starts (`src/worker/runner.ts`, `agent()`). It also runs the after-agent pack checks and saves the run bundle. So agent plus warm-up can pass one hour, and the step timeout fires first.
This explains the run that lasted about 3,589 s. It does not explain the run of about 1,064 s, and the issue does not say which kind that run was. The issue's other claims (the test suite, Chrome checks, the background helper) are not verified here. The draft's fixes 2 to 4 (a deadline and heartbeat inside the runner, killing background tasks, a CLAUDE.md rule on test runs) are out of scope for this item.

Given values:
- Error code: `start_to_close`
- Normalized detail: `step run-agent ran past its start_to_close timeout (<id> ms)`
- Work items: `wi_9157751395af4ce9afcd410eaf6700ef`, `wi_c298572359ff4c6e902bc45c3e0abc01`, `wi_1c34b5543bbc437db97353859a02447c`
- Runs: `run_3f8264ff9c8a4cf2a0de7a3b848c8c6a`, `run_1690a0c35f3c4daf934a1b0af7b4a248`, `run_533be88246734103aaa886b869f52444`, `run_561dc84643694ea8bb3c13fb1a05c7f4`

## Done criteria
- The implement run kind sets `start_to_close_ms` for its `run-agent` step to the approved value (default 2 hours, 7,200,000 ms), and no other kind's timeout changes.
- The implement step's budget is longer than twice `run_timeout_ms` (the warm-up and the agent), with the reason written in a comment.
- A test reads the implement kind's timeouts and fails if the `run-agent` step budget is at or below twice the default `run_timeout_ms`.
- `docs/design/10-event-driven.md` states the implement `run-agent` budget as the current decision, and the one-hour-per-step line moves under its History heading.
- `npm test -- <the new test file>` passes; `npm test` passes on the touched files and their existing contract tests.
- No change to the agent runner, the heartbeat, `run_timeout_ms`, prompts, gates or CLAUDE.md.

## Desired output

A one-line override in the implement run kind's `timeouts` (`steps: { "run-agent": { start_to_close_ms } }`) with a comment that gives the reason, the same form the resolve kind uses. A test that reads the implement kind's timeouts. The design topic file's line on per-step timeouts updated to name the implement value.

## Scope

In scope:
- The implement run's `run-agent` step budget.
- A test for that budget.
- The design topic file line for per-step timeouts.

Out of scope:
- A deadline or heartbeat inside the agent runner that tells the agent to stop and commit (draft fix 2). Follow-up issue.
- Killing leftover background tasks and forcing structured output at the agent's final text (draft fix 3). Follow-up issue.
- A CLAUDE.md rule on running the full test suite once and skipping Chrome checks in the sandbox (draft fix 4). Follow-up issue.
- Per-work-item-size timeouts (draft fix 1, beyond the single value).
- The review, triage and update run kinds, unless the 1,064 s run turns out to be one of them (see the problem).

## Allowed paths (do not change files outside these)
- src/worker/runs/implement/implement.run.ts
- tests/implement-run-timeouts.test.ts
- docs/design/10-event-driven.md
- docs/design.md
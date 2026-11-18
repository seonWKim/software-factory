# Work item wi_fad1762e44c84c18b9681a4c1431edfc

Source: local:local-c8bc8e8b-d18c-4cb2-83b7-ea2823f0b0e3

## Problem

The failing test is in tests/migrate-drain.test.ts. It drives withDrain (src/migrate-drain.ts) with a FakeClock. It advances the clock 121 times, pausing 5 ms of real time between advances, then asserts the exit code is 1. withDrain does real file reads between its clock sleeps. Under load those reads can take longer than 5 ms. The test then stops advancing before withDrain reaches its timeout check, so the promise never resolves and the code stays null ("expected null to be 1"). The issue text mentions a child exit event, but this test spawns no child; the cause is the fixed step count, and the fix belongs in the test. I found no bug in withDrain: its timeout path is correct when it gets to run.

## Done criteria
- tests/migrate-drain.test.ts passes when run alone with npm test -- tests/migrate-drain.test.ts.
- The test passes 20 runs in a row while a parallel full test suite runs.
- The timeout test no longer advances the clock a fixed number of times. It advances until the promise resolves, with a real-time deadline that fails the test with a clear message.
- src/migrate-drain.ts is unchanged.

## Desired output

Change only the timeout test in tests/migrate-drain.test.ts: replace the fixed `for (let t = 0; t < 121 ...)` loop with a loop that advances the FakeClock by 1 s and yields, until `code` is set or a real-time deadline (for example 20 s) passes. Keep the existing assertions (code 1, nothing applied, cancel request, progress line, final "did not drain within 120 s" line). No other test or source file changes.

## Scope

In scope:
- The flaky timeout test in tests/migrate-drain.test.ts: its clock-advance loop.

Out of scope:
- Any change to src/migrate-drain.ts, unless the fixed test shows a real bug.
- Other tests in the file or the global vitest timeout.
- Changing how the test environment or CI runs under load.

## Allowed paths (do not change files outside these)
- tests/migrate-drain.test.ts
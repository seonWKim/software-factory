# Work item wi_581e9fe7da37451199aace3fade51d7e

Source: https://github.com/seonWKim/software-factory/pull/633

## Problem

Accept spec_conflict without a summary

## AS-IS → TO-BE

AS-IS: an implement agent that finds a done criterion it cannot meet answers `{"spec_conflict": "..."}`. The parser still required `summary` and `next_steps`, so the run failed as `invalid_output` with detail `summary/next_steps`, and the spec revision that spec_conflict should start never happened. Item `wi_bff9485e…` failed this way 4 times: every run correctly reported that `web/src/views/system-banner.tsx` is outside the allowed paths. The same `summary/next_steps` detail was also given when the answer was not an object at all, which hid what actually happened.

TO-BE: with `spec_conflict` set, `summary` and `next_steps` may be left out (as with `needs_human`), so the run fails as `spec_conflict` and the controller revises the spec with the reason. An answer that is not an object says what came back: `no structured answer: the agent ended without one`, `... ended with plain text instead`, or `... the answer is an array, not an object`.

## Files

- `src/core/outputs.ts`: `parseImplement` treats spec_conflict like needs_human for the optional fields; `noAnswerError` names a missing answer; schema descriptions say so.
- `tests/review-routing.test.ts`: a spec_conflict-only answer parses; a missing or text answer gets the specific message.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Done criteria

## Desired output



## Scope



## Allowed paths (do not change files outside these)
- src/core/outputs.ts
- tests/review-routing.test.ts
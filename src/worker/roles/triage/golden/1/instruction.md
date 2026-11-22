Small fix: the golden report prints "0 cases" for a role whose cases folder holds only a README

`factory golden run --role review` prints "0 cases" with no hint when `golden/` has no case folders. It should say which folder it read. The change is one message in `src/golden.ts`, plus its test in `tests/golden.test.ts`. Nothing else should change.

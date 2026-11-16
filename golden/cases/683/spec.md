# Work item wi_f22f47ee74534e8c9ec88583768f31af

Source: https://github.com/seonWKim/software-factory/pull/683

## Problem

Fix readonly query tests on Node 22

## AS-IS → TO-BE

- **AS-IS:** main's CI (Node 22) is red since the Data page Ask merged. The query child relies on `setAuthorizer` (Node 24.10+) to deny ATTACH/PRAGMA and to turn hidden-column reads into NULL. On Node 22 none of that runs, so two tests fail. Worse, a hidden column read under another name (`WITH r(c0, …) AS (SELECT * FROM worker_runs) SELECT …`) gets past Ask's name check and `[hidden]` mapping and returns `lease_token`.
- **TO-BE:** writes stay refused on every Node, and the tests assert that without conditions. ATTACH and `PRAGMA query_only = OFF` still run on Node 22, but they leave nothing writable: attached databases, `:memory:` included, open read-only, and a new file cannot be created. A new unconditional test checks this. The authorizer-only assertions now run under `it.runIf(hasAuthorizer())`. When no authorizer is present, the child reads the statement's `EXPLAIN` plan and refuses any query that reads a hidden column or opens an index that holds one. That makes the hidden-column guard hold on Node 22 too: such a query is refused instead of returning NULL.

## Changes

- `src/impl/store/sqlite/readonly-query-worker.ts`: adds `hasAuthorizer()` and `ignoredReadProblem()`. The plan check maps root pages to tables and indexes and refuses on an `OP_Column` of an ignored column. It also refuses any open of an index holding that column, or of a table whose column numbering is not plain.
- `tests/store-readonly-query.test.ts`: unconditional assertions cover write refusal, read-only ATTACH, and the plan check (including the renamed-CTE and index-seek probes). A test also exercises the no-authorizer path with `setAuthorizer` removed, so it runs on every Node. The ATTACH/PRAGMA-denied and NULL assertions are `runIf(hasAuthorizer())`.
- `tests/data-ask.test.ts`: `SELECT *` gives `[hidden]` with an authorizer and is refused without one. A new end-to-end renamed-CTE test checks that the token never appears.
- `docs/design/09-dashboard-app.md`: one sentence in the Ask query decision, plus a History line.

## Tests

- `npm run typecheck`: pass.
- `npm test -- tests/store-readonly-query.test.ts tests/data-ask.test.ts`: passes on Node 25 and Node 24.13. Simulated Node 22 (`setAuthorizer` stripped via `--import`, child included): 26 passed, 2 skipped.
- Full `npm test`: 367 files, 5483 tests passed.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

## Done criteria

## Desired output



## Scope



## Allowed paths (do not change files outside these)
- docs/design/09-dashboard-app.md
- src/impl/store/sqlite/readonly-query-worker.ts
- tests/data-ask.test.ts
- tests/store-readonly-query.test.ts
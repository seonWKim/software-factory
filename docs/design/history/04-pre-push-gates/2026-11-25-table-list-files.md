# History of 04-pre-push-gates: table-list files follow an allowed migration

- **The table-list files had to be named in allowed_paths** (decision changed 2026-11-25, "The table-list files follow an allowed migration").
- Before: `isCovered` covered `tests/store-contract.test.ts` and the drop-legacy migration's `RETIRED` list (`src/state/migrations/20261109T0900-state-drop-legacy-tables.migration.ts`, `tests/state/contract-migrations.test.ts`) only when an allowed path named them. Triage never did, so an item whose migration added or rebuilt a table failed those tests and stopped to ask the owner for a one-line edit: wi_457bb850 (calendar Google sync), wi_4a16d8f1 (eval repeats), wi_7b97a829 (eval gate).
- Now: they are covered whenever an allowed path is a migration; `AGENTS.md` limits the edit to the table-name lists.

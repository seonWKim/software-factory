# Work item wi_8c15fdca0c334487b20f3900adeb8c7f

Source: local:local-94c7e030-e6ae-432d-becb-9948d88ffd66-phase-2-phase-1

## Problem

Migration 35 added the change_ref and change_url columns to work_items, and the store writes them whenever pr_number is set (src/impl/store/sql/change-fields.ts). The WorkItem type in src/core/types.ts still lists only pr_number. rowToWorkItem in src/impl/store/sql/rows.ts does not map the two columns, so no caller can read them. The item that intake returns for an adopted PR is built by newWorkItem, which does not set them either, so it would not match the stored row. This phase adds the two fields to the type, maps them on read, and makes the intake result match the row.

## Done criteria
- WorkItem in src/core/types.ts has change_ref (string or null) and change_url (string or null).
- Every work item read path returns both fields from the row: factory and adopted items, with and without a stored label.
- The item that intake returns (created or adopted) has the same change_ref and change_url as its stored row.
- tests/store-contract.test.ts has a test that reads change_ref and change_url through the store API, and it passes on the SQLite run.
- tests/store-contract.test.ts passes on the MySQL run when SF_TEST_MYSQL_URL is set.
- docs/design/02-work-item.md lists change_ref and change_url in its field list and has a History line for this change, dated 2026-11-08.
- npm run typecheck passes.
- npm test passes.
- No migration is added and no existing row is changed.

## Desired output

Two type fields, the row mapping, the intake result fix, one contract test covering both backends, and the design topic update. No migration.

## Scope

In scope:
- Add change_ref and change_url to WorkItem.
- Map both columns when reading any work item.
- Set both on the item returned by intake, so it matches the stored row.
- Contract test for the two fields on SQLite, and on MySQL when SF_TEST_MYSQL_URL is set.
- Update docs/design/02-work-item.md: field list and History line.

Out of scope:
- Changing migration 35 or the change columns; they are already in place.
- Backfilling existing rows.
- Callers, the status page or the web client using the new fields.
- Changing getWorkItemByPr or any other lookup by PR.
- The change_ref column on unreviewed_merges.

## Allowed paths (do not change files outside these)
- src/core/types.ts
- src/impl/store/
- tests/store-contract.test.ts
- tests/helpers/fakes.ts
- docs/design/02-work-item.md
- docs/design.md
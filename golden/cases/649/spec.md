# Work item wi_a9e7308df1754672842a3b513e4091c1

Source: https://github.com/seonWKim/software-factory/issues/647

## Problem

The default mechanical path list in src/core/coordination.ts names the MySQL step folder migrations/mysql/, and so does the same list in factory.config.json. Coordination weighs a path in that list at 0.25 instead of 1.0, so two items that touch step files do not hold each other. The config-keys test (tests/config-keys.test.ts) pins the same list. tests/commands-cursor.test.ts imports step 0042 and has MySQL cases that drive it through a scripted database. tests/coordination.test.ts also relies on the default list: it checks that a step file weighs 0.25 as a mechanical path, so removing the folder from the default breaks it. That test must use a path it sets itself. The MySQL step files stay in place in this phase, so the tests keep passing while the references go. The next phase deletes the folder.

Given values:
- DEFAULT_MECHANICAL after the change, in this order: "src/impl/store/mysql/migrations.ts", "docs/design/", "docs/design.md", "docs/plugins.md", "docs/plugins/"
- DEFAULT_MECHANICAL_WEIGHT stays 0.25
- factory.config.json mechanical_paths after the change: ["src/impl/store/mysql/migrations.ts", "docs/design/", "docs/design.md", "docs/plugins.md", "docs/plugins/"]
- mechanical_weight stays 0.25
- Test environment: SF_TEST_MYSQL_URL unset

## Done criteria
- DEFAULT_MECHANICAL in src/core/coordination.ts no longer lists migrations/mysql/, and its doc comment no longer names the step folder.
- factory.config.json mechanical_paths no longer lists migrations/mysql/.
- tests/config-keys.test.ts defaults list matches DEFAULT_MECHANICAL exactly, in the same order.
- tests/commands-cursor.test.ts has no import from migrations/, and its MySQL step 0042 cases and scripted database helper are removed.
- tests/commands-cursor.test.ts SQLite cases are unchanged and pass.
- tests/coordination.test.ts still checks that a step file weighs mechanical_weight, using a path given in the test's own config instead of migrations/mysql/, and its expected values stay the same.
- npm run typecheck passes with SF_TEST_MYSQL_URL unset while the step files still exist.
- npm test passes with SF_TEST_MYSQL_URL unset while the step files still exist.
- The migrations/mysql/ folder and its files are unchanged by this change.

## Desired output

A diff in the five listed files only: the default list and its doc comment, the repo config list, the config-keys defaults list, the cursor test with the MySQL cases and helper removed, and the coordination test using its own mechanical path.

## Scope

In scope:
- Remove migrations/mysql/ from the default mechanical list and its doc comment in src/core/coordination.ts.
- Remove migrations/mysql/ from mechanical_paths in factory.config.json.
- Make the defaults list in tests/config-keys.test.ts match the new default list.
- Remove the MySQL step 0042 import, cases and scripted database helper from tests/commands-cursor.test.ts; keep its SQLite cases.
- Point the step-file mechanical check in tests/coordination.test.ts at a path set in the test's own config.

Out of scope:
- Deleting the migrations/mysql/ folder or its step files (next phase).
- The path_companions entries in factory.config.json that name migrations/mysql/ (next phase).
- The mechanical merge code in src/core/mechanical.ts, which reads the step folder directly (next phase).
- Comments that name the MySQL step in src/inbound/migrations and src/impl/store/sql/command-proposals.ts (follow-up issue).
- docs/design/05-coordination.md text about the default list (updated with the deletion in the next phase).

## Allowed paths (do not change files outside these)
- src/core/coordination.ts
- factory.config.json
- tests/config-keys.test.ts
- tests/commands-cursor.test.ts
- tests/coordination.test.ts
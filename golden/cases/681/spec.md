# Work item wi_c8b223b921e44f13b4b28e02fec673de

Source: https://github.com/seonWKim/software-factory/issues/677

## Problem

The store is SQLite only since the MySQL code was removed (#576, #663). Twenty design topic files under docs/design/ still describe MySQL in their current decisions. Examples are MySQL step files, the MySQL schema and the MySQL renumbering rule. Some current decisions also quote the old "Before" text inline, which keeps MySQL in the current text. Each of the twenty files must keep its non-MySQL content, state the current decision for SQLite only, and move the replaced MySQL text into a History line. The coordination file (docs/design/05-coordination.md) must record the shared store as paused and say the SQL driver stays the seam for SQL. This is docs only: no code, config, migration or test changes.

Given values:
- History line date: 2026-11-11
- History line names issue: #567
- Coordination file, shared store: paused
- Coordination file, SQL seam: SqlDriver stays the SQL seam

## Done criteria
- Each of the 20 listed design files has a current decision (the text above its History heading) with no MySQL step file, MySQL schema or MySQL renumbering text.
- No text above the History heading of the 20 listed files mentions MySQL, including inline 'Before' quotes inside a current decision. Such quotes move to History.
- Each changed file has a History line dated 2026-11-11 that names issue #567 and holds the replaced MySQL text.
- docs/design/05-coordination.md records the shared store as paused and says SqlDriver stays the SQL seam.
- `grep -ri mysql` over the 20 listed files finds MySQL only in History text.
- Outside the MySQL text, no current decision is reworded, dropped or added to in the 20 files; the diff only removes MySQL text and adds History lines.
- Only the 20 listed files change. No code, migration, prompt, config, test or docs/design.md index change.
- `npm test` passes.

## Desired output

Edits to the 20 listed design topic files only. In each file, remove MySQL text from the current decisions (SQLite only, as the SQLite behaviour already is). Add a History line dated 2026-11-11 naming #567 that holds the replaced text. In docs/design/05-coordination.md, the current decision states the shared store is paused and that SqlDriver stays the SQL seam.

## Scope

In scope:
- Remove MySQL step file, MySQL schema and MySQL renumbering text from the current decisions of the 20 listed design files.
- Move each replaced MySQL text into a History line dated 2026-11-11 that names issue #567.
- docs/design/05-coordination.md: record the shared store as paused and say SqlDriver stays the SQL seam.

Out of scope:
- Other design files that still mention MySQL, for example docs/design/05-merge-conflict.md, 08-permissions.md, 08-enterprise.md, 08-settings.md, 09-dashboard-app.md, 10-event-driven.md and 11-signal-ledger.md. File them as a follow-up issue.
- Any code, migration, schema, prompt, config, test or dependency change, including removing SQLite behaviour.
- Rewording, dropping or adding decisions beyond the MySQL text in the listed files.
- New sections, new topic files or changes to the docs/design.md index.
- Changing the History date or issue number given in the request.

## Allowed paths (do not change files outside these)
- docs/design/02-tasks.md
- docs/design/02-work-item.md
- docs/design/03-risk.md
- docs/design/04-agents.md
- docs/design/04-gate-commands.md
- docs/design/04-pre-push-gates.md
- docs/design/04-split-specs.md
- docs/design/04-triage.md
- docs/design/05-alarms.md
- docs/design/05-ci-gate.md
- docs/design/05-coordination.md
- docs/design/05-interactive-sessions.md
- docs/design/05-merge-conflict.md
- docs/design/05-restarts.md
- docs/design/05-sandbox.md
- docs/design/05-sources.md
- docs/design/05-standing-approvals.md
- docs/design/06-measurement.md
- docs/design/06-token-budget.md
- docs/design/07-self-improvement.md
- docs/design.md
# Work item wi_a28d12ea6e874c7ca62de571b81c282f

Source: https://github.com/seonWKim/software-factory/issues/529

## Problem

The Settings page lists pending standing-approval proposals inside the "Standing approvals" section (web/src/views/standing.tsx), which renders below Mode and the "Settable keys" table in web/src/views/settings.tsx. An owner decision can be missed there. The "Changes by PR only" section lists keys with no explanation of why they are read-only or how to change them. JSON-valued keys (such as model_by and models) are shown minified: the editor is a 4-row textarea with one long line, and the File value cell uses break-all in a narrow column, so long values wrap letter by letter.

## Done criteria
- With one pending proposal, the Pending proposals section renders above the Mode section in the Settings page.
- With no pending proposals, no Pending proposals heading or list renders on the Settings page, and the Standing approvals section still shows its rules.
- The Standing approvals section keeps the rules list and its switches; the Accept and Decline buttons appear only in the top proposals section.
- The PR-only section is titled "Set in factory.config.json only" and shows a one-line intro that says these keys can't be changed here and change only through a reviewed PR to factory.config.json.
- A JSON key's editor shows its value pretty-printed with a 2-space indent (test).
- Saving a JSON key sends compact JSON, the same text as JSON.stringify(JSON.parse(text)) (test).
- Saving text that is not valid JSON sends it unchanged, so the server's refusal shows beside the field.
- The JSON editor's height follows its line count, with a max height after which it scrolls.
- A long JSON file value in the table renders as a one-line summary (for example {triage, implement, review, …}) collapsed by default; clicking Show expands the pretty-printed JSON (test).
- The File value cell no longer uses break-all: long text wraps at word boundaries, not letter by letter.
- Non-JSON values, the Mode switch and the Standing rules switches render as before.
- tests/ui-settings-page.test.tsx and tests/ui-standing-page.test.tsx are updated for the new section name and placement, and pass with `npm test -- tests/ui-settings-page.test.tsx` and `npm test -- tests/ui-standing-page.test.tsx`.
- docs/design/09-dashboard-app.md has a current-decision line for the Settings page order and the PR-only section, with the earlier layout under History.

## Desired output

Changes to web/src/views/settings.tsx: a JSON branch in Editor that pretty-prints the value for display and compacts it on save, sized to content with a max height; a small JSON summary component with a Show toggle for the File value cell; the PR-only intro and new title; and the proposals section placed above Mode. Changes to web/src/views/standing.tsx: export the pending proposals as their own section (rendered null when empty), and keep the rules list in StandingSection. Both sections read the same API query, so no new fetch is added. Tests in tests/ui-settings-page.test.tsx and tests/ui-standing-page.test.tsx cover the new done criteria. Update docs/design/09-dashboard-app.md's current decision line only. The solo default and enterprise setting are the same here, because this is a UI-only change.

## Scope

In scope:
- Pending proposals moved to the top of the Settings page, above Mode, shown only when there are proposals.
- PR-only section: plain title and a one-line explanation.
- Pretty-printed JSON in the editor, with compact JSON saved.
- One-line summary and Show toggle for JSON values in the File value column.
- Tests for the new behaviour and the updated section names.
- Design line in docs/design/09-dashboard-app.md.

Out of scope:
- Any change to the API, the store, or the settings write rules.
- Changing which keys are PR-only.
- Changing the Standing rules list or its switches.
- Changing the Mode switch or the auto-merge tier control.
- A new JSON editor library or a syntax highlighter.
- Changing the History section.

## Allowed paths (do not change files outside these)
- web/src/views/settings.tsx
- web/src/views/standing.tsx
- tests/ui-settings-page.test.tsx
- tests/ui-standing-page.test.tsx
- docs/design/09-dashboard-app.md
- docs/design.md
# Building a page

How to build or change a dashboard page, and how it is checked. Layout rules: `patterns.md`. Words: `writing.md`. Parts: `components.md`, `foundations.md`.

## Build steps

1. Read `patterns.md` and `writing.md`, then find the component you need in `components.md`.
2. Compose the page from `web/src/components/ui/`. A missing piece is a new component there, with a section in `components.md`, not a one-off in the page.
3. Take colours, type, spacing and radius from the token classes. A new token goes in `tokens.json`, then `npm run build:tokens`. Never edit `web/src/tokens.css`.
4. Put every text in `web/src/i18n/en.ts` and read it with `t()`.
5. Run the checks below, then `npm run typecheck` and `npm test`.

## Checks

Run each through its npm script, never the test runner directly.

| Check | File | Run |
|---|---|---|
| Tokens match the generator, text pairs meet WCAG AA, no hex colour or palette class, no default radius or arbitrary type size, the controls share focus ring and disabled look | `tests/design-system.test.ts` | `npm test -- tests/design-system.test.ts` |
| Raw controls: no `<button>`, `<select>`, `<textarea>` or `<input>` under `web/src` outside `components/ui/` (added by wi_5b2b; no ratchet list) | `tests/design-system.test.ts` | `npm test -- tests/design-system.test.ts` |
| Every shared component has a section in `components.md` and renders | `tests/web-ui-components.test.tsx` | `npm test -- tests/web-ui-components.test.tsx` |
| No English text outside the catalog (wi_9b74) | `tests/web-i18n-text.test.ts` | `npm test -- tests/web-i18n-text.test.ts` |
| Two page widths as tokens, `<main>` takes its width from `PageHeader`, no page sets a page width, every view h2 is `CARD_TITLE` and every h3 `SUB_TITLE` | `tests/design-system.test.ts` | `npm test -- tests/design-system.test.ts` |
| Every page at five window sizes, light and dark: the layout rules, and the page template's structure (one h1; h1 and h2 sizes the same on every page; `<main>` at `--page-wide` or `--page-read`; every button 28px or 32px tall, except a chart's bar, `[data-chart-bar]`; no snake_case or `wi_` text outside `[data-raw]`; a row's controls on its text line, `row-align`; one control height per toolbar, `toolbar-height`; an open dialog's or popover's body at least 60px tall while its content is taller, `panel-collapsed`), each failure naming its rule | `scripts/responsive-check.mjs`, `scripts/responsive/rules.mjs`, `scripts/responsive/webkit.mjs` (the same rules in WebKit at 1280 and 390 px; `npm run setup:webkit` once), `scripts/responsive/system-webkit.mjs` (macOS: the Calendar popover pages in the Mac's own WebKit, Safari's and the cmux browser's engine, at 1280, 740 and 390 px; needs `swiftc`) | `npm run check:responsive` (runs at merge, where a browser can start; not in the agent sandbox) |

## Existing pages

The raw-controls check applies to every file under `web/src` outside `components/ui/`, with no list of exceptions. The text check keeps a `BASELINE` list in `tests/web-i18n-text.test.ts` of the files that still hold English text; it must match exactly, so a new file with inline text fails, and when you move a listed file's text into the catalog you delete its line. Moving existing pages onto the components is done in follow-up issues, one page each. The first is the Needs you redesign (wi_fc2c).

## PR checklist for UI changes

- [ ] Composed from `components/ui`; no raw `<button>`, `<select>`, `<textarea>` or `<input>`.
- [ ] A new shared component has a section in `components.md`.
- [ ] Layout follows `patterns.md`: one primary action, a state for loading, empty and error, the page width from `PageHeader`'s `width`, tabs and filters in the `PageToolbar`, h2s from `Card` and h3s in `SUB_TITLE`, text shown as stored inside `[data-raw]`.
- [ ] Text follows `writing.md`: sentence case, a next step, no raw IDs, no command as the main text, compact times, no code names outside Details, the glossary's words.
- [ ] Every text is in `en.ts` and read with `t()`.
- [ ] Colours are token classes; no hex.
- [ ] Usable by keyboard, with a visible focus ring and a visible label on every field.
- [ ] A change of design is recorded in `docs/design/09-dashboard-app.md` and a change of tokens in `design-system/README.md`'s changelog.
- [ ] `npm run typecheck`, `npm test` pass; `npm run check:responsive` passes at merge.

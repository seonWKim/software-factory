# Building a page

How to build or change a dashboard page, and how it is checked. Layout rules: `patterns.md`. Words: `writing.md`. Parts: `components.md`, `foundations.md`.

## Build steps

1. Read `patterns.md` and `writing.md`, then find the component you need in `components.md`. The Design system page (`web/src/views/design.tsx`) shows each one.
2. Compose the page from `web/src/components/ui/`. A missing piece is a new component there, with a section in `components.md` and an entry on the Design system page, not a one-off in the page.
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
| The Design system page uses every exported component | `tests/web-design-system.test.tsx` | `npm test -- tests/web-design-system.test.tsx` |
| No English text outside the catalog (wi_9b74) | `tests/web-i18n-text.test.ts` | `npm test -- tests/web-i18n-text.test.ts` |
| Every page at five window sizes, light and dark | `scripts/responsive-check.mjs` | `npm run check:responsive` (runs at merge, where a browser can start; not in the agent sandbox) |

## Existing pages

The raw-controls check applies to every file under `web/src` outside `components/ui/`, with no list of exceptions. The text check keeps a `BASELINE` list in `tests/web-i18n-text.test.ts` of the files that still hold English text; it must match exactly, so a new file with inline text fails, and when you move a listed file's text into the catalog you delete its line. Moving existing pages onto the components is done in follow-up issues, one page each. The first is the Needs you redesign (wi_fc2c).

## PR checklist for UI changes

- [ ] Composed from `components/ui`; no raw `<button>`, `<select>`, `<textarea>` or `<input>`.
- [ ] A new shared component has a section in `components.md` and is on the Design system page.
- [ ] Layout follows `patterns.md`: one primary action, a state for loading, empty and error.
- [ ] Text follows `writing.md`: sentence case, a next step, no raw IDs, no command as the main text, compact times.
- [ ] Every text is in `en.ts` and read with `t()`.
- [ ] Colours are token classes; no hex.
- [ ] Usable by keyboard, with a visible focus ring and a visible label on every field.
- [ ] A change of design is recorded in `docs/design/09-dashboard-app.md` and a change of tokens in `design-system/README.md`'s changelog.
- [ ] `npm run typecheck`, `npm test` pass; `npm run check:responsive` passes at merge.

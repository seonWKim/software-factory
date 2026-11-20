# design-system

The dashboard's design source. Decisions: `docs/design/09-brand-and-tokens.md`.

- `tokens.json` is the one token source (colours, pills, type with line heights, the type roles, spacing, radius, shadows `sm` and `lg` per theme), all colours as hex.
- `web/src/tokens.css` is generated from it: `npm run build:tokens`. Never edit it.
- `foundations.md` states the colour, type, spacing and radius scales with the values `tokens.json` gives them.
- `components.md` has a section for every shared component under `web/src/components/ui`: purpose, variants, sizes and states.
- `patterns.md` states how a page is laid out: rows, actions, confirmations, states, forms and keyboard.
- `writing.md` states the rules for the words on a page and for `t()`.
- `dx.md` lists the build steps, each check with its test and npm script, and the PR checklist for UI changes.
- `icon.svg` is the master mark of Gongbang.
- Every page is a `PageHeader` (page title `text-xl` semibold) over `Card` blocks (section title `text-base` semibold), with `Badge` for states and `EmptyState` for empty lists (`components.md`).
- `tests/design-system.test.ts` checks the generated file matches, that every text colour and every Badge tone meets WCAG AA (4.5:1) in both themes, and that no raw form element appears in `web/src/` outside `components/ui/`.

## Stays fixed

A UI change keeps these as they are. The triage spec lists them for a change under `web/`, and the review checks the diff against them.

- brand colour
- the one primary action per view
- page header and Card structure
- no raw IDs on a page

## Changelog

- 2026-11-20: `components.md` opens with "Which component for what" (need, component, usage; Checkbox has no component yet, Switch until a follow-up issue adds it), and this file gains "Stays fixed". The triage and review prompts point to both.

- 2026-11-19: `writing.md` gains "Plain words for everyone" (no code or machinery words on a page, values with meaning, local times, events as sentences, problems in three parts, short help, server text included) and a glossary.

- 2026-11-19: the type roles (page title `xl` semibold, section title `base` semibold, body `sm`, meta `xs`) and `shadow-sm` and `shadow-lg` in `tokens.json`; `index.css` maps every type step to `text-<step>`. New `Card` and `CardSection` replace `Section`; `Badge` is the one pill badge (the square `Badge` and `StatusBadge` merged); `EmptyState` gains an icon, takes its text as `description`, and replaces `Empty`; `PageHeader`'s title is `text-xl` semibold. The contrast test also checks pill text on cards and the page, and every Badge tone.

- 2026-11-12: `patterns.md`, `writing.md` and `dx.md`: the guides for pages, words and building a page.
- 2026-11-12: `foundations.md` and `components.md`, and the missing components (OverflowMenu, Notice, EmptyState, Kbd, Tooltip, StatusBadge, PageHeader, DataTable); Select, Input, Textarea, Field, ButtonRow and Radio are the control set's.
- 2026-11-12: the ember dot is drawn at every size (radius at least 2.5 px at small sizes, `data-small-r`) in the new `ember` token `#FB923C` (was `#FF6A2B` from 64 px up); the sidebar mark draws it.
- 2026-11-12: the control set in `web/src/components/ui/`: Button (primary, secondary, ghost, danger; md 32 px, sm 28 px, icon 32 px square), Select, Input, Textarea (32 px fields, padding-x 12 px), Radio, Field and ButtonRow (gap 8 px); the dialog uses them. Adds the `on-solid` token (text on a filled accent or failed background: `#FFFFFF` light, `#17171A` dark).
- 2026-11-12: the palette is Gongbang (owner-approved brand board, 2026-11-11), replacing the zinc and blue Tailwind values. Adds `running`, `done` and `failed` colours; derived `surface-2`, `border-strong`, `text-3`, `focus` and the pill shades (same hue as their base, lighter or darker; warn stays amber). Type steps carry a line height (28/34, 20/26, 15/22, 13/18, 11/14), spacing gains 48 px, radius gains `box` (10 px) and `card` becomes 14 px.
- 2026-11-12: the Gongbang mark, `icon.svg`.
- 2026-11-11: `tokens.json` and the generated `tokens.css`.

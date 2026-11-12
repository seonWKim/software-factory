# design-system

The dashboard's design source. Decisions: `docs/design/09-brand-and-tokens.md`.

- `tokens.json` is the one token source (colours, pills, type with line heights, spacing, radius), all colours as hex.
- `web/src/tokens.css` is generated from it: `npm run build:tokens`. Never edit it.
- `foundations.md` states the colour, type, spacing and radius scales with the values `tokens.json` gives them.
- `components.md` has a section for every shared component under `web/src/components/ui`: purpose, variants, sizes and states.
- `icon.svg` is the master mark of Gongbang.
- `tests/design-system.test.ts` checks the generated file matches and that text pairs meet WCAG AA (4.5:1) in both themes.

## Changelog

- 2026-11-12: `foundations.md` and `components.md`, and the missing components (Select, Input, Textarea, Field, ButtonRow, Radio, OverflowMenu, Notice, EmptyState, Kbd, Tooltip, StatusBadge, PageHeader, DataTable).
- 2026-11-12: the palette is Gongbang (owner-approved brand board, 2026-11-11), replacing the zinc and blue Tailwind values. Adds `running`, `done` and `failed` colours; derived `surface-2`, `border-strong`, `text-3`, `focus` and the pill shades (same hue as their base, lighter or darker; warn stays amber). Type steps carry a line height (28/34, 20/26, 15/22, 13/18, 11/14), spacing gains 48 px, radius gains `box` (10 px) and `card` becomes 14 px.
- 2026-11-12: the Gongbang mark, `icon.svg`.
- 2026-11-11: `tokens.json` and the generated `tokens.css`.

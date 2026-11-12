# design-system

The dashboard's design source. Decisions: `docs/design/09-brand-and-tokens.md`.

- `tokens.json` is the one token source (colours, pills, type with line heights, spacing, radius), all colours as hex.
- `web/src/tokens.css` is generated from it: `npm run build:tokens`. Never edit it.
- `icon.svg` is the master mark of Gongbang.
- `tests/design-system.test.ts` checks the generated file matches, that text pairs meet WCAG AA (4.5:1) in both themes, and that no raw form element appears in `web/src/` outside `components/ui/`.

## Changelog

- 2026-11-12: the ember dot is drawn at every size (radius at least 2.5 px at small sizes, `data-small-r`) in the new `ember` token `#FB923C` (was `#FF6A2B` from 64 px up); the sidebar mark draws it.
- 2026-11-12: the control set in `web/src/components/ui/`: Button (primary, secondary, ghost, danger; md 32 px, sm 28 px, icon 32 px square), Select, Input, Textarea (32 px fields, padding-x 12 px), Radio, Field and ButtonRow (gap 8 px); the dialog uses them. Adds the `on-solid` token (text on a filled accent or failed background: `#FFFFFF` light, `#17171A` dark).
- 2026-11-12: the palette is Gongbang (owner-approved brand board, 2026-11-11), replacing the zinc and blue Tailwind values. Adds `running`, `done` and `failed` colours; derived `surface-2`, `border-strong`, `text-3`, `focus` and the pill shades (same hue as their base, lighter or darker; warn stays amber). Type steps carry a line height (28/34, 20/26, 15/22, 13/18, 11/14), spacing gains 48 px, radius gains `box` (10 px) and `card` becomes 14 px.
- 2026-11-12: the Gongbang mark, `icon.svg`.
- 2026-11-11: `tokens.json` and the generated `tokens.css`.

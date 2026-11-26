# design-system

The dashboard's design source. Decisions: `docs/design/09-brand-and-tokens.md`.

- `tokens.json` is the one token source (colours, pills, type with line heights, the type roles, spacing, radius, shadows `sm` and `lg` per theme), all colours as hex.
- `web/src/tokens.css` is generated from it: `npm run build:tokens`. Never edit it.
- `foundations.md` states the colour, type, spacing and radius scales with the values `tokens.json` gives them.
- `components.md` has a section for every shared component under `web/src/components/ui`: purpose, variants, sizes and states.
- `patterns.md` states how a page is laid out: rows, actions, confirmations, states, where autonomous work shows, forms and keyboard.
- `writing.md` states the rules for the words on a page and for `t()`.
- `dx.md` lists the build steps, each check with its test and npm script, and the PR checklist for UI changes.
- `icon.svg` is the master mark of Gongbang: a white open loop round a plain file on a dark square, ending in the ember dot. It has no letters.
- Every page is a `PageHeader` (page title `text-xl` semibold) over `Card` blocks (section title `text-base` semibold), with `Badge` for states and `EmptyState` for empty lists (`components.md`).
- `tests/design-system.test.ts` checks the generated file matches, that every text colour and every Badge tone meets WCAG AA (4.5:1) in both themes, and that no raw form element appears in `web/src/` outside `components/ui/`.

## Stays fixed

A UI change keeps these as they are. The triage spec lists them for a change under `web/`, and the review checks the diff against them.

- celadon glaze palette
- the one primary action per view
- page header and Card structure
- no raw IDs on a page

## Changelog

- 2026-11-26: `patterns.md` gains "Autonomous work is visible" (owner decision): every actor that acts without the owner has a place on a factory page with its current activity, its recent actions with outcome and reason, and a link to the transcript or log; a new autonomous feature is not done without it. `tests/design-system.test.ts` checks every schedule action kind is named on the Schedules page (`AUTONOMOUS_SURFACES`). No token changes.
- 2026-11-24: `Button` gains `flush` (a ghost Button that opens a block lines its label up with the text above); `READ_WIDTH` (32rem) is the one intro width in place of `max-w-prose`; `LIST_BOX` drops a list box's side border inside a Card below `sm` (the Work tree, a Table's cards); `Field` with no `htmlFor` is a labelled group and its `help` is the hint slot; check:responsive gains `disclosure-align`. No token changes.
- 2026-11-24: new `Popover` (the details of one thing beside it; a `ModalPanel` sheet below `sm`) and `ChipButton` (a content chip that opens one, marked `data-chip`, which check:responsive's button-height rule skips); first used by the Calendar's event chips. No token changes.
- 2026-11-24: `Dialog`'s body scrolls between a fixed title and footer, so Cancel and the confirm stay in view in a tall dialog; `DataTable` gains `select` (a plain text button in the first cell, the selected row `current`) and `Tr` gains `current` (`surface-2` fill and a 2 px `nav-active` bar, like the current sidebar link). No token changes.
- 2026-11-24: `Switch` gains `readOnly` (keeps its on or off colour, focusable, ignores clicks); `opacity-50` stays for a switch disabled while busy. No token changes.
- 2026-11-24: `SegmentedControl` is a radiogroup on one `surface-2` track with equal segments and a sliding raised thumb; `Disclosure`'s summary is a quiet hover target with the new `DisclosureChevron` (14px, `text-3`), which the Work tree's 32px expand button reuses; `Button` exports `buttonClass`. No token changes.
- 2026-11-24: `ModalPanel` (dialog.tsx), the modal with no confirm for the shortcut list and the search, on the same native dialog mechanics as `Dialog`; `Kbd` is at least 20 px wide and centred.
- 2026-11-22: the `sidebar-active` colour (light `#D7DED9`, dark `#29302D`), the fill of the current sidebar link in place of `surface-2`; asserted at 1.1:1 or more against `sidebar` in both themes.
- 2026-11-22: the palette is Celadon glaze (owner decision): a grey-green accent (`#2C6A5C` light, `#8CCDBB` dark) and the ember `#F2A55F`, with new `bg`, `surface`, `surface-2`, `sidebar`, `nav-active`, `border`, `border-strong`, `text`, `text-2`, `text-3` and `on-solid` values. The mark is an open loop round a plain file, ending in the ember, on a `#1A1F1D` square (was the 공 letter); the ember's smallest radius is 2 px. Token names and where the accent is used do not change. In Stays fixed, "brand colour" becomes "celadon glaze palette".
- 2026-11-20: the page widths `page.wide` (77rem, 1232px, lists and tables) and `page.read` (60rem, 960px, forms and reading) in `tokens.json`, generated as `--page-wide` and `--page-read` and mapped to `max-w-page-wide` and `max-w-page-read`. `PageHeader` gains `width`; new `PageToolbar`; `CardSection` and every sub-group h3 use `SUB_TITLE` (`text-xs font-medium text-text-2`); a `Disclosure` trigger is at least 28px tall.
- 2026-11-20: the `nav-active` colour (the `text` ink in both themes), drawn as a 2 px bar on the current sidebar link; contrast asserted at 3:1 against `sidebar`.
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

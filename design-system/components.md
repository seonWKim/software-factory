# Components

The shared pieces in `web/src/components/ui`: plain React and Tailwind on the token classes of `foundations.md`, no component library. Each section gives the purpose, variants, sizes and states; `tests/web-ui-components.test.tsx` renders every one listed for the new components and checks that every exported component has a section here.

## Which component for what

Pick the component by the need, before drawing anything by hand. A UI spec names the row it uses; a hand-made element where a row names a component is a review finding. A need with no component says so and links the item that adds it.

| Need | Component | Usage |
|---|---|---|
| a state | `StatusBadge` for an item, run or worker state, else `Badge` | `StatusBadge` shows the state table's label and tone (`src/shared/states.ts`) with `data-status`; `Badge` any other short status as a pill, tone from a state table key; never a hand-made chip or a bordered Button. |
| an on/off choice in a list | Checkbox (none yet: `Switch` until it exists) | One box per row that turns that row's choice on or off. No Checkbox exists yet; a follow-up issue adds it. Until then use `Switch`, never a Button drawn as a box. |
| a row's extra actions | `OverflowMenu` | The row's secondary actions behind one "more" button at its end, so the row stays one line. |
| a row in a bordered list | `ListRow` | Leading control, one-line title with ellipsis, details line, every action in its ⋯ menu. |
| input inside a list row | `Dialog` | A field a row action needs opens in a Dialog; the row's height never changes. |

## Card

A block of a page (`card.tsx`): the `surface` background, a 1px `border`, the `card` radius, 24px padding (`p-6`; 16px below `sm`, so a 320px window keeps its content width) and `shadow-sm`. Optional h2 `title` in the section title role (`text-base font-semibold`, the exported `CARD_TITLE`), an optional `count` beside it and an optional `action` at the end of the title row. It is a region named by `label`, else by `title` (Data names its table Card "Table <name>" and titles it with the bare name); with neither it is a plain block. `id` gives it an anchor (`#spend`, `#failures`); `live` announces a title that changes (the calendar's period). Cards follow each other 24px apart. No variants or sizes.

## CardSection

A titled part inside a `Card`: an h3 in the same section title role, an optional `count` and `action`. Not a region of its own, so a page's list of regions stays its list of cards. Use it for a sub-heading in a card (Spend's Totals, the read-only file keys) instead of a raw heading.

## Table

A data table at `sm` and up; below it, one card per row. Props: `head`, `label`, optional `numeric[i]` to right-align a heading. States: table, cards (below `SM_PX`).

## Tr

One row of a `Table`: a `<tr>`, or a card below `sm` (first cell the title, the second alone under it, the rest with their column names from the third column; a cell with nothing in it is not listed).

## Td

One cell of a `Tr`; in a card it wraps and drops width classes. Data attributes pass through to the `<td>` or the card's `<div>`.

## DataTable

A `Table` built from `columns` and `rows`, on `Table`, `Tr` and `Td`. A column is `{ key, header, render?, numeric?, className? }` (`className` is added to the column's cells). With `dataKey` each row carries `data-key` set to its `rowKey`, for links and tests that find a row by it. States: number columns right-aligned in `tabular-nums` (header too); a column empty in every row left out; cards below `SM_PX`; no rows shows `empty`.

## Badge

The one pill (`badge.tsx`): a short text as a pill with a dot, `text-xs` medium, in the tone of `level`, a key of the one state table (`src/shared/states.ts`); `TONE_CLASS` maps each tone to the pill tokens (`ok`, `warn`, `bad`, `info`) or neutral (`surface-2` with `text`), and an unknown or missing level is neutral. Carries `data-level`. For any pill that is not an item, run or worker state (plugins, settings, calendar, a task's overdue, a transcript, a thread). One size. `tests/design-system.test.ts` checks every tone it draws at 4.5:1 in both themes.

## StatusBadge

An item's, a run's or a worker's state (`badge.tsx`): `state` is a key of the state table, and the pill shows its label in its tone, or `children` when the words say more (where a Merge is). Carries `data-status` set to the state key. Every item, run and worker state pill is a `StatusBadge`; no view maps a state to a label or a tone itself.

## Notice

An inline message. Variants (`tone`): `info` (default), `ok`, `warn`, `bad`. Optional title. `warn` and `bad` have role alert, the others role status.

## EmptyState

What a list shows when empty, centred in a dashed `rounded-box`: an optional `icon` (a lucide icon, 24px, `text-3`), a `title`, an optional `description` and an optional `action`. Every empty list uses it, `DataTable`'s `empty` too. States: with or without icon, description and action. A list whose action must keep its place in the tree (Plugins' Import, whose dialog stays open as the list fills) draws `EMPTY_BOX` itself.

## Loading

Row-shaped placeholders while the first read is in flight. Prop `rows` (default 3).

## ErrorNote

The "Could not load" message in the `bad` tone, role alert.

## PageHeader

The top of every page: the one h1 in the page title role (`text-xl font-semibold`), an optional `badge` beside it (a Badge with the page's count, such as the Rules page's waiting count; never an action), an optional description under it (`text-sm`, `text-2`) and optional actions at the end, the primary action last. 24px below it. States: with or without badge, with or without description, with or without actions; actions wrap below the title when narrow.

## Input

A one-line field, 32 px high with padding-x 12 px, on the shared field classes of `control.ts` (1 px `border-strong` border, radius `control`, `surface` background, `text-sm`, placeholder in `text-3`). Variants (`type`): `text` (default), `search`, `number`; not for radios (see Radio). One size. States: default, with placeholder, focus-visible (2 px `focus` outline), `disabled` (opacity 0.5).

## Textarea

A multi-line field on the same field classes as Input, padding-x 12 px and padding-y 8 px; its height comes from `rows`. One size. States: default, focus-visible, `disabled`.

## Select

A field 32 px high on the field classes (a `role=combobox` button that shows the current choice) with its own chevron (in `text-2`), which opens its own list, not the browser's: a `role=listbox` in the OverflowMenu's look (`surface`, 1 px `border`, `rounded-control`, shadow; items `text-sm`, hover and highlight `surface-2`, the shared `FOCUS` and `DISABLED` classes), the current choice `aria-selected` with a `text-1` check mark. The list opens directly below the field, or above it when the viewport has no room below (a measured check, no positioning library). Options are `<option>` children (`value`, text, `disabled`, so a disabled placeholder works); `onChange` gets an event whose `target.value` is the picked value. Keys: Enter, Space or an arrow opens; ArrowDown and ArrowUp move the highlight; Enter picks; Esc closes and keeps the focus on the field; letters move the highlight to the first option starting with them. A click outside closes it. `wrapperClassName` sets the box around the field and its chevron (its width, its margin). One size. States: closed, open (below or above), focus-visible, `disabled`; option default, highlighted, selected, `disabled`.

## Field

A label (`text-sm`, font-medium) above its control with a 4 px gap, and optional help text (`text-xs`, `text-2`) below. `htmlFor` ties the label to the control's `id`. No variants or sizes. States: with or without `help`.

## ButtonRow

Buttons side by side with an 8 px gap, wrapping at a narrow width; the primary action goes last (macOS order). No variants or sizes: alignment comes from `className` (for example `justify-end` in the Dialog footer).

## Radio

A 16 px radio circle drawn from the tokens with its label (the radio's accessible name): a `text-2` ring on `surface`, checked an `accent` ring around a `surface` dot. Radios of a group share a `name`. One size. States: unchecked, checked, focus-visible, `disabled`.

## OverflowMenu

A "more" button (a `ghost` Button at size `icon`) that opens a menu of actions: items `{ label, onSelect, danger?, disabled? }`. States: closed, open; item default, `danger` (bad text), `disabled`. Esc, a click outside or choosing an item closes it. The list ends at the button's right edge; when that would put its left part past the left edge of the page content (`main`, else the viewport), so the sidebar would cover its labels, it starts at the button's left edge instead (a measured check when it opens, no positioning library).

## ListRow

One row of a bordered list (`list-row.tsx`; the Tasks page's Needs you, date groups and Done all use it): an optional `leading` control (a task's Checkbox), the `title` on one full-width line cut with an ellipsis (the exported `ROW_TITLE` classes; the element carries the full text in `title`), a `details` line under it in `text-xs text-2` (state Badges, dates, projects, a reason), any `children` below (a form, an error), and the `menu` at the right: one `OverflowMenu` holding every action of the row, the primary first. No buttons beside the title and no raw IDs. 12px padding, 12px gaps; it never wraps the menu under the title. No variants or sizes.

## Kbd

A keyboard key as text, such as Esc. No variants or sizes.

## Tooltip

A short hint on hover and keyboard focus, hidden by Esc or leaving. Variants (`placement`): `top` (default), `bottom`, `beside` (level with the trigger's top, right of it for `align` `start`, left for `end`; for a trigger inside a scroller). States: hidden, shown.

## Button

The dashboard's one button. Variants: `primary` (accent background, `on-solid` text: the one main action of a view), `secondary` (default: `border-strong` border on `surface`), `ghost` (no border, `surface-2` on hover), `danger` (`failed` text); `danger` with `solid` is filled with the failed colour, only for a confirm dialog's destructive confirm. Sizes: `md` (default, at least 32 px high), `sm` (at least 28 px), `icon` (32 px square). States: default, hover (enabled only), focus-visible, pressed (`aria-pressed` or `aria-checked`: `surface-2` background), `disabled` (opacity 0.5). `type` defaults to `button`.

## Checkbox

A native `input type=checkbox` drawn from the tokens: a 16 px box (`size-4`) inside a 32 px hit area, a `text-2` border on `surface`, checked an `accent` border and an `accent` check mark. The label is `children` (visible, the accessible name) or an `aria-label`. `aria-checked` mirrors `checked`. One size. States: unchecked, checked, focus-visible, `disabled`.

## Switch

A `role=switch` button with `aria-checked`, 24 px high (the smallest target) around a drawn 20 by 36 px track; the thumb moves by a class. Controlled by `checked` and `onCheckedChange`. One size. States: on (`text-1` track), off (`border-strong` track), focus-visible, `disabled`.

## SegmentedControl

One choice among a few views (`role=group` with an `aria-label`): a 32 px box with a 1 px `border-strong` edge on `surface`, holding 28 px segments in one row that never wraps. Controlled by `value` and `onChange`; `options` gives each segment's `id` and label. States: selected (`aria-pressed`, `surface` fill, a `border-strong` ring, `text-1` text; neutral, never accent), default (`text-2`), hover (`surface-2`, `text-1`), focus-visible.

## Link and ID

`web/src/components/ui/link-style.ts` holds both. `LINK_CLASS` (`text-text-1 hover:underline`) is every link in the views, item titles included; the sidebar keeps its own. `ID_CLASS` (`font-mono text-text-3 hover:underline`) is an item or source ID, linked or not (source ID links, the item page header ID). Accent is never a text colour: only the primary Button and the selected-tab underline use it, and `tests/ui-link-style.test.tsx` fails on `text-accent` anywhere under `web/src`.

## Tabs

One filter among named choices that may be many, drawn as underline tabs like Grafana's page tabs (`role=tablist` with an `aria-label`, each option a `role=tab` button with `aria-selected`). The row has a 1 px `border` line along its whole width; tabs are plain text, 16 px apart and 32 px tall, with no box or fill: default `text-2`, hover `text-1`, selected `text-1` with a 2 px `accent` bottom border on the row's line. Token colours only and the shared `FOCUS` class. The row never wraps; when the tabs are wider than their box they scroll sideways inside it (`overflow-x-auto`), so the page does not. Controlled by `value` and `onChange`; `options` gives each tab's `id` and label. Roving tabindex: only the selected tab is in the tab order. Keys: ArrowRight and ArrowLeft move to the next and previous tab, wrapping at the ends; Home and End go to the first and last; the tab a key moves to is focused and selected at once. The optional `action` prop draws one quiet action at the end of the same row, inside the border and outside the tablist: pass an icon-only `ghost` Button (32 px, the tabs' height) with an accessible name; it is not a tab and the arrow keys skip it. Use SegmentedControl for a few fixed views, Tabs for a list that grows.

## Pagination

The one pager for a long list (`web/src/components/ui/pagination.tsx`, a `nav` labelled Pagination): the shared Button Previous, a "Page x of y" label (`text-2`, `aria-live=polite`) and the shared Button Next, token colours only. Pages count from 1; `page`, `pages` and `onChange` control it. Previous is disabled on page 1 and Next on the last page. It renders nothing when one page holds everything. The page cuts its own rows (the Tasks page, 20 to a page).

## Dialog

The native modal `<dialog>`, opened on mount and closed on unmount, rendered into `document.body`: radius `card`, padding 24 px, a `text-base` semibold title, optional children and a one-line `consequence`, and a right-aligned ButtonRow footer with Cancel (secondary Button) before the confirm. Variants: default (confirm is a `primary` Button), `danger` (confirm is a `danger` Button with `solid`). States: open, `confirmDisabled`, with an `error` (shown in the dialog, role alert). Esc and a click on the backdrop cancel; Enter in a one-line field confirms; focus returns to `returnFocusTo`, else to the element focused when it opened. `announceStatus` shows a short status line after a send.

## CopyButton

A small bordered `text-xs` button (`border-strong`, `text-2`, hover `surface-2`) that writes `value` to the clipboard; `what` names it in its accessible name and title ("Copy item ID"). States: default ("Copy"), done ("Copied" for 1.5 s), no clipboard (nothing happens; the text stays selectable).

## CopyText

A copy element: the shown text (`children`, else `value`) in `font-mono text-xs` that wraps, then a CopyButton that copies `value`.

## IdDetails

A readable name (`label`, e.g. "worker 3" or "you") as a plain button on the shared Tooltip: the full `id` shows in the tooltip on hover and keyboard focus (not in the DOM while hidden), and a click copies it and shows "Copied" in place of the label for 1.5 s, on the same line, so the row height never changes. No disclosure; with no clipboard a click does nothing. The copy logic is one helper shared with CopyButton. Pages use it so no raw ID shows in running text (design 09-dashboard-app).

## Disclosure

A native `<details>` with a `<summary>`: one chevron marker (turned down when open), one label style (`text-xs text-text-2`, no box). Props: `summary` (the visible label), `children` (the body), `defaultOpen` (starts open; default closed), `lazy` (mount the body only while open, for a body that reads something on demand), `onToggle(open)`, and `className` (a margin only) and `data-*` passed to the `<details>`. `aria-expanded` is on the summary and follows the open state; click, Enter and Space toggle it. Use it only for long content (more than ~3 lines or a list): decision rule 2 in `patterns.md`, never a single value. Write no raw `<details>` in `web/src/views/`; Markdown folds through it too.

## KeyValue

A `dl` of label → value pairs (`items`: `key`, `term`, `value`), `text-xs`, terms in `text-2`. Default: two columns (term, then value that wraps anywhere); `stacked`: term above value, for a dialog. A term with `code` is a code identifier and shows in monospace; values are plain text, monospace only for ids, SHAs, paths, commands, code and SQL. `valueProps` and extra `data-*` props pass through to the dd and dl. No interactive states.

## ValueBlock

The code block for a long value (pretty JSON, a command) beside KeyValue: a `pre` in `surface-2`, `font-mono text-xs`, wraps, scrolls past `max-h-48`. No interactive states.

## Markdown

Renders a markdown string as safe elements. No variants or sizes.

## Brand

The mark and the wordmark at the top of the sidebar; below `sm` only the mark.

## BrandMark

The Gongbang mark alone, decorative; size comes from `className`.

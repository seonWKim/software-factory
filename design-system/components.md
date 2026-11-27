# Components

The shared pieces in `web/src/components/ui`: plain React and Tailwind on the token classes of `foundations.md`, no component library. Each section gives the purpose, variants, sizes and states; `tests/web-ui-components.test.tsx` renders every one listed for the new components and checks that every exported component has a section here.

## Which component for what

Pick the component by the need, before drawing anything by hand. A UI spec names the row it uses; a hand-made element where a row names a component is a review finding. A need with no component says so and links the item that adds it.

| Need | Component | Usage |
|---|---|---|
| a state | `StatusBadge` for an item, run or worker state, else `Badge` | `StatusBadge` shows the state table's label and tone (`src/shared/states.ts`) with `data-status`; `Badge` any other short status as a pill, tone from a state table key; never a hand-made chip or a bordered Button. |
| an on/off choice in a list | `Checkbox` (`web/src/components/ui/checkbox.tsx`) | One box per row that turns that row's choice on or off, such as a task's completion; never a Button drawn as a box. |
| a short notice that goes by itself | `Toast` | Top right for 6 s, paused while hovered or focused, with Dismiss; never for a state the owner must act on (that is a `Notice`). |
| long text in a row or card (a description, a title, an example) | `Clamp` | Clamps to 2 lines and opens in place with Show more / Show less, the button only when the text is cut off; never a hand-written `line-clamp`. Decision rule 7. |
| a row's extra actions | `OverflowMenu` | The row's secondary actions behind one "more" button at its end, so the row stays one line. |
| a row of a list of work items | `ItemRow` (`web/src/views/item-row.tsx`) | Tasks, Needs you, Work (table and tree), Runners' running runs, the item page's Runs: title (the link) · StatusBadge · why · project · worker · age · one primary action · ⋯ menu (the tree: the PR link before the age); Copy ID in the menu, never an ID in the text. Design 09-dashboard-tasks. |
| any other row in a bordered list | `ListRow` | Leading control, one-line title with ellipsis, details line, at most one visible action, the rest in its ⋯ menu. |
| a reference list or a search over the page, with no confirm | `ModalPanel` | Header with the title (or the search field) and a close icon button; the body scrolls. Never a hand-made overlay `div`. |
| the whole details of one thing on a page (a calendar event), opened from it | `Popover`, opened by a `ChipButton` | Beside the chip from `sm` up, a sheet below; never a hand-made floating `div` or a tooltip for content the owner must read. |
| input inside a list row | `Dialog` | A field a row action needs opens in a Dialog; the row's height never changes. |

## Card

A block of a page (`card.tsx`): the `surface` background, a 1px `border`, the `card` radius, 24px padding (`p-6`; 16px below `sm`, so a 320px window keeps its content width) and `shadow-sm`. Optional h2 `title` in the section title role (`text-base font-semibold`, the exported `CARD_TITLE`): Card is the one owner of a page's h2 (the Calendar's period in its toolbar, in `CARD_TITLE`, is the one exception), so every h2 on every page has this one size, an optional `count` beside it and an optional `action` at the end of the title row. It is a region named by `label`, else by `title` (Data names its table Card "Table <name>" and titles it with the bare name); with neither it is a plain block. `id` gives it an anchor (`#spend`, `#failures`); `live` announces a title that changes (the calendar's period). Cards follow each other 24px apart. Its padding is the exported `CARD_PAD`, which any other page-level box uses too (the item page's decision card), so every block's content starts on one left edge. A card's intro paragraph under its title is `CARD_INTRO` (`text-sm` `text-2`, `READ_WIDTH`, 16px above the content). `READ_WIDTH` (`max-w-lg`, 32rem, 512px) is the one width of every intro: a card's, the `PageHeader` and `Notice` descriptions and the Rules group lines; a fixed length, never `max-w-prose`, whose 65ch follows the font size. No variants or sizes.

## CardSection

A titled part inside a `Card`: an h3 in the one sub-group style (`text-xs font-medium text-text-2`, the exported `SUB_TITLE`), an optional `count` and `action`. Every other h3 on a page (a calendar day, a group of task rows) uses `SUB_TITLE` too. Not a region of its own, so a page's list of regions stays its list of cards. Use it for a sub-heading in a card (Spend's Totals, the read-only file keys) instead of a raw heading.

## Table

A data table at `sm` and up; below it, one card per row. Props: `head`, `label`, optional `numeric[i]` to right-align a heading. The cards' list is a `LIST_BOX` (`parts.tsx`): a list box inside a Card, rounded with a 1px `border` from `sm` up and only its top and bottom lines below it, so a phone draws the Card's border and padding once, not a second border 16px inside them (the Work tree uses it too); a card has no side padding (12px when `current`, beside its bar). States: table, cards (below `SM_PX`).

## Tr

One row of a `Table`: a `<tr>`, or a card below `sm` (first cell the title, the second alone under it, the rest with their column names from the third column, each name centred on its value; a cell with nothing in it is not listed). States: default, `current` (the row whose details the page shows: `aria-current="true"`, a `surface-2` fill and a 2 px `nav-active` bar at its start, as the sidebar marks the current page; the row's height does not change).

## Td

One cell of a `Tr`. In a table its content sits in `CELL_LINE` (`parts.tsx`), so every cell of a row shares one centre line, 24px from the row's top (a single-line row is 49px): text starts 6px down (its 20px line centred on the row's 32px line) and keeps that offset when it wraps, a 32px control (icon or md Button) starts at the top, a 28px one (small Button, `IdDetails`) 2px down, a 24px Switch 4px down; a Badge sits on the text line. Never align a cell with its own padding or `align-middle`. In a card it is `CARD_CELL`: it shrinks (`min-w-0`), wraps anywhere (`wrap-anywhere`), caps every link at its width and cuts an ID link (`a[data-id]`, full value in `title`) to one line with an ellipsis; it drops the column's width classes, `whitespace-nowrap` and `break-words`. Data attributes pass through to the `<td>` or the card's `<div>`.

## DataTable

A `Table` built from `columns` and `rows`, on `Table`, `Tr` and `Td`. A column is `{ key, header, render?, numeric?, className? }` (`className` is added to the column's cells). With `dataKey` each row carries `data-key` set to its `rowKey`, for links and tests that find a row by it. With `select` (`{ key, onSelect, label }`) the rows are selectable: the first cell is a plain text button (`font-medium`, underlined on hover, 32 px tall, the cell's whole first line, so its text sits on the other cells' centre line, the shared `FOCUS` ring, `aria-pressed`, named by `label(row)`) that calls `onSelect` with the row's key, and the row whose key is `select.key` is `current` (Tr). Never a ghost Button in the cell: its pressed fill is a pill and it sits below the other cells. States: number columns right-aligned in `tabular-nums` (header too); a column empty in every row left out; cards below `SM_PX`, where long text and links stay inside the card (prose wraps anywhere, a link marked `data-id` with its full value in `title` is cut with an ellipsis; give an ID link both); no rows shows `empty`; with `select`, one row or none current.

## Chart

A small bar chart from plain elements on token colours (`chart.tsx`), as Efficiency's mini charts: `points` (`key`, `value`, `caption`, `text`) and a `label` naming its list. One bar (`bg-accent`, `rounded-t-control`) per point in a 96 px high row, its height `value` over `max` (default: the largest value; a rate passes `max={1}`); the first and last `caption` sit under it in `text-xs text-text-2`. Every point is also text: its `text` is in the bar's `title` and in a screen-reader line, so the chart is a list of sentences too. Not interactive; use a Button bar (Efficiency) when a bar must pick something. One size. States: with points, no points (draws nothing: the page shows an `EmptyState`).

## Badge

The one pill (`badge.tsx`): a short text as a pill with a dot, `text-xs` medium, in the tone of `level`, a key of the one state table (`src/shared/states.ts`); `TONE_CLASS` maps each tone to the pill tokens (`ok`, `warn`, `bad`, `info`) or neutral (`surface-2` with `text`), and an unknown or missing level is neutral. Neutral's fill is the selected table row's fill (`surface-2`), so inside a `current` row (`aria-current="true"`) a neutral pill takes `surface` (`NEUTRAL_IN_CURRENT`) and stays a pill. Carries `data-level`. For any pill that is not an item, run or worker state (plugins, settings, calendar, a task's overdue, a transcript, a thread). One size. `tests/design-system.test.ts` checks every tone it draws at 4.5:1 in both themes.

## StatusBadge

An item's, a run's or a worker's state (`badge.tsx`): `state` is a key of the state table, and the pill shows its label in its tone, or `children` when the words say more (where a Merge is). Carries `data-status` set to the state key. Every item, run and worker state pill is a `StatusBadge`; no view maps a state to a label or a tone itself.

## Notice

An inline message. Variants (`tone`): `info` (default), `ok`, `warn`, `bad`. Optional title. `warn` and `bad` have role alert, the others role status.

## Toast

A transient notice that goes by itself (`toast.tsx`): a `surface` box with a 1 px `border`, the `box` radius, 12 px padding and `shadow-lg`, fixed at the top right under the top bar (22rem wide; below `sm` the full width less 16 px each side), its content beside a ghost `sm` Dismiss Button. A live region (`role="status"`). It fades in, and after `TOAST_MS` (6 s) fades out (200 ms, none with reduced motion) and calls `onClose`; the timer waits while the pointer is over it or focus is inside it, so a list being read never vanishes. Dismiss closes it at once. One size, no variants. States: shown, paused (hovered or focused), fading. For a status line after a send use `announceStatus` (Dialog); a state that stays until it changes is a `Notice`.

## EmptyState

What a list shows when empty, centred in a dashed `rounded-box`: an optional `icon` (a lucide icon, 24px, `text-3`), a `title`, an optional `description` and an optional `action`. Every empty list uses it, `DataTable`'s `empty` too. States: with or without icon, description and action. A list whose action must keep its place in the tree (Plugins' Import, whose dialog stays open as the list fills) draws `EMPTY_BOX` itself.

## Loading

Row-shaped placeholders while the first read is in flight. Prop `rows` (default 3).

## ErrorNote

The "Could not load" message in the `bad` tone, role alert.

## PageHeader

The top of every page: the one h1 in the page title role (`text-xl font-semibold`), an optional `badge` beside it (a Badge with the page's count, such as the Rules page's waiting count; never an action), an optional description under it (`text-sm`, `text-2`) and optional actions at the end, the primary action last. 24px below it. `width` picks the page's width: `wide` (the default, `--page-wide`, 1232px) for lists and tables, `read` (`--page-read`, 960px) for forms and reading (Settings, Rules). It marks the header `data-page-width`, and `<main>` takes its `max-width` from it (`max-w-page-wide`, `has-[[data-page-width=read]]:max-w-page-read`); no page or page wrapper sets a `max-w-*` of its own (field, cell and prose widths stay). States: with or without badge, with or without description, with or without actions; actions wrap below the title when narrow.

## PageToolbar

The slot for a page's controls, right under its `PageHeader` (`notice.tsx`): `tabs` on the first row, then the search, view switch and filters (`children`) on the second, wrapping when narrow; 24px below it. The controls row (`data-toolbar`) holds one control height, 32px (`CONTROL_HEIGHT.md` in `control.ts`): a `sm` Button in it is drawn `md` through the `InToolbar` context, level with the search Input, a Select and the SegmentedControl's track (the responsive check's `toolbar-height`). Every page with tabs, a search, a view switch or filters puts them here, never between its content blocks or inside a Card (Health's Failures window, Workers' window, Calendar's view switch and period buttons, the Transcript's step filters, the Settings Advanced and Rules searches included). A page with none renders no toolbar. States: tabs only, controls only, both.

## Input

A one-line field, 32 px high with padding-x 12 px, on the shared field classes of `control.ts` (1 px `border-strong` border, radius `control`, `surface` background, `text-sm`, placeholder in `text-3`). Variants (`type`): `text` (default), `search`, `number`, `date`, `time` (the browser's own picker, on the same field classes); not for radios (see Radio). One size. States: default, with placeholder, focus-visible (2 px `focus` outline), `disabled` (opacity 0.5).

## Textarea

A multi-line field on the same field classes as Input, padding-x 12 px and padding-y 8 px; its height comes from `rows`. One size. States: default, focus-visible, `disabled`.

## Select

A field 32 px high on the field classes (a `role=combobox` button that shows the current choice) with its own chevron (in `text-2`), which opens its own list, not the browser's: a `role=listbox` (`surface`, 1 px `border`, `rounded-control`, shadow; items `text-sm`, hover and highlight `surface-2`, the shared `FOCUS` and `DISABLED` classes), the current choice `aria-selected` with a `text-1` check mark. The list opens directly below the field, or above it when the viewport has no room below (a measured check, no positioning library). Options are `<option>` children (`value`, text, `disabled`, so a disabled placeholder works); `onChange` gets an event whose `target.value` is the picked value. Keys: Enter, Space or an arrow opens; ArrowDown and ArrowUp move the highlight; Enter picks; Esc closes and keeps the focus on the field; letters move the highlight to the first option starting with them. A click outside closes it. `wrapperClassName` sets the box around the field and its chevron (its width, its margin). One size. States: closed, open (below or above), focus-visible, `disabled`; option default, highlighted, selected, `disabled`.

## Field

A label (`text-sm`, font-medium) above its control with a 4 px gap, and the hint slot `help` (`text-xs`, `text-2`) under the control: a format, a range, what each value means (a list is fine). `htmlFor` ties the label, a `<label>`, to the control's `id`; with no `htmlFor` the Field is a `role=group` named by its label (a `<span>`), for a control with no single id (a Switch and its state word, a list of switches, a file picker). A page never places a field's label or hint by hand. No variants or sizes. States: with or without `help`; one control or a group.

## ButtonRow

Buttons side by side with an 8 px gap, wrapping at a narrow width; the primary action goes last (macOS order). No variants or sizes: alignment comes from `className` (for example `justify-end` in the Dialog footer).

## Radio

A 16 px radio circle drawn from the tokens with its label (the radio's accessible name): a `text-2` ring on `surface`, checked an `accent` ring around a `surface` dot. Radios of a group share a `name`. One size. States: unchecked, checked, focus-visible, `disabled`.

## OverflowMenu

A "more" button (a `ghost` Button at size `icon`, `surface-2` while open) that opens a menu in the look of a native macOS menu. Entries (`MenuEntry`): items `{ label, onSelect, icon?, shortcut?, checked?, danger?, disabled?, action?, item? }`, separators `{ separator: true }` and group labels `{ group }`.

- **Panel** (`MENU_PANEL`): `surface` at 95% with a background blur, 1 px `border`, radius `box`, `shadow-lg`, 4 px inside, at least 192 px wide and never wider than the viewport less 16 px; 4 px from the button.
- **Item** (`MENU_ITEM`): 28 px high, 8 px side padding, `text-sm`, one line cut with an ellipsis (a label over 40 characters carries it whole in `title`); hover and keyboard focus show one highlight pill (radius `control`, `surface-2`; a `danger` item's is `pill-bad-bg` on `pill-bad-fg` text); the shared `FOCUS` ring for the keyboard and `DISABLED` look.
- **Columns:** a check column when any item has `checked` (then each such item is a `menuitemradio`), a 16 px icon column (lucide icons in `text-2`) when any item has `icon`, so the labels line up; the `shortcut` at the end as a `Kbd` `hint` (the same key cap as the shortcut list), named by `aria-keyshortcuts`. Only pass a shortcut that exists in the `?` list.
- **Separator:** a 1 px `border` line, 8 px in from each side. **Group label:** `text-xs` semibold `text-2` over its items.
- **Keys:** Enter, Space or ArrowDown on the button opens it on the first item, ArrowUp on the last; ArrowDown and ArrowUp move round the enabled items, Home and End jump, a letter moves to the next item starting with it; Esc closes it (and not the dialog it sits in), Tab closes it. The pointer moves the same highlight. Choosing an item closes the menu and gives the focus back to the button before the item acts, so a dialog it opens returns the focus there.
- **Placement:** the panel is `fixed` at a measured place (measured again on scroll and resize), so a scrolling box it sits in, such as a DataTable's, never clips it; it ends at the button's right edge; when that would put its left part past the left edge of the page content (`main`, else the viewport), so the sidebar would cover its labels, it starts at the button's left edge instead; it opens above the button when the viewport has no room below and more above (measured when it opens, no positioning library).

States: closed, open (below or above, end or start); item default, highlighted, checked, `danger`, `disabled`.

## ListRow

One row of a bordered list that is not a work item (`list-row.tsx`; the Check and alarm rows of Needs you, Rules and Standing rules; a work item's row is `ItemRow`): an optional `leading` control (a Switch or Checkbox), the `title` on one full-width line cut with an ellipsis (the exported `ROW_TITLE` classes; the element carries the full text in `title`), a `details` line under it in `text-xs text-2` (state Badges, dates, projects, a reason), any `children` below (a form, an error), and at the right an optional `action`, the row's one visible next step (a `size="sm"` Button, as ItemRow's primary action: Promote, Accept), then the `menu`: one `OverflowMenu` holding the row's other actions. The 32px leading control, the action (`data-row-action`) and the menu (`data-row-menu`) are pulled up 6px, so they centre on the title's 20px line; below `sm` the action takes a line of its own under the content and the ⋯ stays top right. No other buttons beside the title and no raw IDs. 12px padding, 12px gaps; it never wraps the menu under the title. No variants or sizes.

## ItemRow

One row of a list of work items (`web/src/views/item-row.tsx`): Tasks, Needs you, Work (table and tree), Runners' running runs and the item page's Runs. Slots in order: title (the link to the item; plain text for an unbuilt task) · `StatusBadge` · why · project · worker · age · one primary action · ⋯ menu; the title first, so the titles of a list start on one left edge whatever badge a row has (a table keeps the State column first). The tree puts the PR link (its action, on a 24px line with the text centred) before the age, so the age always ends the meta (an `OverflowMenu`; Copy ID lives there, never an ID in the row text). A second line only for "held behind X" or an error. The row carries `data-item-id` (an unbuilt task carries `data-task` instead). Variants `compact` (Work, Runners) and `comfortable` (Tasks) change spacing only. A done row is `text-2`, never struck through. In the list layout the title is one 32px line, text centred (`LIST_TITLE`, `font-medium`), and the badge slot is at least 32px tall, so the Checkbox, title, badge, action and ⋯ button share one centre line with 12px above and below; below `sm` the title's base width is its text's (`basis-auto`), so a short title keeps its line with the badge, a long one takes the line alone (cut) with the badge under it, and the details start the next line; a linked title is `ROW_LINK_CLASS` (underlined on hover only). Tables and the tree keep `LINK_CLASS`.

## Kbd

A keyboard key as text, such as Esc: a chip at least 20 px wide, centred, `text-xs` on `surface-2` with a `border-strong` edge and radius `control`. A key sequence (`g w`) is one Kbd per key. No variants or sizes.

## Tooltip

A short hint on hover and keyboard focus, hidden by Esc or leaving. Variants (`placement`): `top` (default), `bottom`, `beside` (level with the trigger's top, right of it for `align` `start`, left for `end`; for a trigger inside a scroller). States: hidden, shown.

## Button

The dashboard's one button. Variants: `primary` (accent background, `on-solid` text: the one main action of a view), `secondary` (default: `border-strong` border on `surface`), `ghost` (no border, `surface-2` on hover), `danger` (`failed` text); `danger` with `solid` is filled with the failed colour, only for a confirm dialog's destructive confirm. Sizes: `md` (default, at least 32 px high), `sm` (at least 28 px; drawn `md` inside a PageToolbar, `InToolbar`), `icon` (32 px square). `flush` pulls the button's start back by its inline padding (`-ms-3` md, `-ms-2` sm; never `icon`), so the label starts on the text edge of the block above it: every ghost Button that opens a block (Show earlier messages, Show more, Show result, About Google's sign-in warning, `Clamp`'s Show more) is flush; its hover fill reaches out round the label. `buttonClass({ variant, size, flush })` returns the same classes for a control that must be another library's button (react-aria's Tree chevron slot). States: default, hover (enabled only), focus-visible, pressed (`aria-pressed` or `aria-checked`: `surface-2` background), `disabled` (opacity 0.5). `type` defaults to `button`.

## Checkbox

A native `input type=checkbox` drawn from the tokens: a 16 px box (`size-4`) inside a 32 px hit area, a `text-2` border on `surface`, checked an `accent` border and an `accent` check mark. The label is `children` (visible, the accessible name) or an `aria-label`. Its role is `checkbox` (the native input) and `aria-checked` mirrors `checked`. A click and Space toggle it, as on any checkbox, and so does Enter; a `disabled` one ignores all three. Use it for a task's completion (before the `ItemRow` title) and a choice in a list; never a Button drawn as a box. One size. States: unchecked, checked, focus-visible, `disabled`.

## Switch

A `role=switch` button with `aria-checked`, 24 px high (the smallest target) around a drawn 20 by 36 px track; the thumb moves by a class. Controlled by `checked` and `onCheckedChange`. One size. States: on (`text-1` track), off (`border-strong` track), focus-visible, `readOnly` (keeps the on or off colour, stays focusable, ignores clicks, `aria-readonly`; never faded; pair it with a lock and a description saying where to change it), `disabled` (`opacity-50`, for a switch busy with a write).

## SegmentedControl

One choice among a few views, drawn like a macOS segmented control (`role=radiogroup` with an `aria-label`, each segment a `role=radio` with `aria-checked`): one 32px `surface-2` track (`rounded-control`, 2px padding) holding equal-width 28px segments (`auto-cols-fr`) in one row that never wraps, `text-sm` medium. A raised thumb (`surface`, `shadow-sm`, a 1px `border` ring; `border-strong` with no ring in dark, lighter than the track) sits under the checked segment and slides to it (150ms, motion-safe). Controlled by `value` and `onChange`; `options` gives each segment's `id`, label and optional `data-*`. Roving tabindex: only the checked segment is in the tab order (the first when none matches); ArrowRight/ArrowDown and ArrowLeft/ArrowUp move to the next and previous segment, wrapping, Home and End to the first and last, and the segment a key reaches is focused and checked at once. For a choice, never for actions that send something (use Buttons). States: checked (`text-1` on the thumb; neutral, never accent), default (`text-2`), hover (`text-1`), focus-visible, no value (no thumb).

## StatTile

One figure in a tile, inside a `<dl>` grid of tiles 12px apart (`stat-tile.tsx`): a `rounded-box` box with a 1px `border` on `surface` and 12px of padding, the label in meta type (`dt`, `text-xs` `text-2`), the figure 4px under it (`dd`, `text-lg` semibold, `tabular-nums`) and any further lines as children (`dd`, `STAT_NOTE`: `text-xs` `text-2`). `data-*` props go on the tile. Work's Last 24 hours and Spend's totals use it; a tile that holds more than a figure (Efficiency's charts) uses its class constants (`STAT_TILE`, `STAT_LABEL`, `STAT_VALUE`). One size. States: with or without notes; a figure may be a link.

## Link and ID

`web/src/components/ui/link-style.ts` holds both. `LINK_CLASS` (`text-text-1 underline`) is every link in the views, item titles in tables and the tree included (a list row's title is `ROW_LINK_CLASS`, `text-text-1 hover:underline`: it stands alone on its row, never in a sentence), underlined at rest so a link in a sentence is told apart by more than colour (buttons that use the class are underlined too); the sidebar keeps its own. `ID_CLASS` (`font-mono text-text-3 hover:underline`) is an item or source ID, linked or not (source ID links, the item page header ID). Accent is never a text colour: only the primary Button and the selected-tab underline use it, and `tests/ui-link-style.test.tsx` fails on `text-accent` anywhere under `web/src`.

## Tabs

One filter among named choices that may be many, drawn as underline tabs like Grafana's page tabs (`role=tablist` with an `aria-label`, each option a `role=tab` button with `aria-selected`). The row has a 1 px `border` line along its whole width; tabs are plain text, 16 px apart and 32 px tall, with no box or fill: default `text-2`, hover `text-1`, selected `text-1` with a 2 px `accent` bottom border on the row's line. Token colours only and the shared `FOCUS` class. The row never wraps; when the tabs are wider than their box they scroll sideways inside it (`overflow-x-auto`), so the page does not. Controlled by `value` and `onChange`; `options` gives each tab's `id` and label. Roving tabindex: only the selected tab is in the tab order. Keys: ArrowRight and ArrowLeft move to the next and previous tab, wrapping at the ends; Home and End go to the first and last; the tab a key moves to is focused and selected at once. The optional `action` prop draws one quiet action at the end of the same row, inside the border and outside the tablist: pass an icon-only `ghost` Button (32 px, the tabs' height) with an accessible name; it is not a tab and the arrow keys skip it. Use SegmentedControl for a few fixed views, Tabs for a list that grows.

## Pagination

The one pager for a long list (`web/src/components/ui/pagination.tsx`, a `nav` labelled Pagination): the shared Button Previous, a "Page x of y" label (`text-2`, `aria-live=polite`) and the shared Button Next, token colours only. Pages count from 1; `page`, `pages` and `onChange` control it. Previous is disabled on page 1 and Next on the last page. It renders nothing when one page holds everything. The page cuts its own rows (the Tasks page, 20 to a page).

## Dialog

The native modal `<dialog>`, opened on mount and closed on unmount, rendered into `document.body`: radius `card`, padding 24 px, a `text-base` semibold title, a body (optional children, a one-line `consequence` and the `error`, 12 px apart), and a right-aligned ButtonRow footer with Cancel (secondary Button) before the confirm. At most the window's height less 16 px each side; when the content is taller only the body scrolls, so the title and the footer (Cancel and the confirm) stay in view, also on a phone. The form and the body keep their content height and only shrink to fit (never `flex-1`: WebKit sizes a fit-content `<dialog>` from a zero flex basis and draws it as a 2px line). Variants: default (confirm is a `primary` Button), `danger` (confirm is a `danger` Button with `solid`). States: open, `confirmDisabled`, with an `error` (shown in the dialog, role alert). Esc and a click on the backdrop cancel; Enter in a one-line field confirms; focus returns to `returnFocusTo`, else to the element focused when it opened. `announceStatus` shows a short status line after a send.

## ModalPanel

A modal with no confirm, for a reference list (the shortcut list) or a search: the same native `<dialog>` as Dialog (showModal, so the page behind is inert and Tab stays inside; rendered into `document.body`). A header row (12 px top and bottom, 20 px left, a bottom `border`) holds the `text-base` semibold title, or `header` in its place (the search field; the title stays as a hidden heading), and a ghost icon Button with an X (Close) at its right; under it the body (20 px across, 16 px down, `text-sm`) keeps its content height, shrinks to the panel's max height and scrolls by itself, so the header stays put. Radius `card`, `shadow-lg`, the Dialog's backdrop. Sizes: `lg` (42rem, default) and `md` (32rem); both leave a 16 px gutter on a phone. Placement: `center` (default) or `top` (10% down, at most 80% of the window high, so a list that filters as you type does not move it). Esc, a click on the backdrop and the close button close it; a press that starts inside and ends on the backdrop does not. Focus goes to its first field, else its body, and back to `returnFocusTo`, else the element focused when it opened, without scrolling the page.

## Popover

The details of one thing, anchored beside it (`popover.tsx`): a non-modal native `<dialog>` opened with `show()`, rendered into `document.body`, so the page stays usable. From `sm` up it sits right of its `anchor`, else left of it, else under it (flipped over it when it would run past the window's bottom), 8 px from the anchor and always whole inside the window; beside the anchor its top is the anchor's top, flipped (its bottom on the anchor's bottom) when it would run past the window's bottom, then shifted inside (`place`) (a measured check when it opens and on scroll, resize and its own size change; no positioning library). Being fixed in `document.body`, no scrolling or clipping box of the page cuts it. 20rem wide (`w-80`), at most 32rem tall and the window's height less 8 px each side (so it can sit beside its anchor), radius `box`, 1 px `border`, `surface`, `shadow-lg`. A header (a bottom `border`; 8 px top and bottom, 16 px left) holds the whole `title` (`text-base` semibold, wraps, never cut; the h2) and a ghost icon Button with an X (Close); the body (16 px across, 12 px down, `text-sm`) keeps its content height and scrolls by itself only past the max height (`flex: 0 1 auto` with `min-h-0`, never `flex-1`: Safari and the cmux browser took its zero basis as the body's height and drew it 24 px tall, owner #92); an optional `footer` (a top `border`, a link out such as "Open in Google Calendar") is pinned under the body, always in view. Below `sm` it is a `ModalPanel` (`md`, which takes the same `footer`) with the same body and the title wrapped whole in its header. Esc, the close button and a press outside it (not on the anchor) close it; a Popover opened from inside another (an event in a month day's list) stacks over it: a press in the later one keeps the earlier open, and Esc closes the top one only. Focus goes to its body and back to the anchor, unless the owner moved it to another control. One size, no variants. States: beside (right, left or under its anchor), sheet (below `sm`).

## ChipButton

A content chip that opens a `Popover` (`popover.tsx`), such as a calendar event: a plain `<button>` as tall as its content (at least 24 px, `min-h-6`), full width, text left-aligned, radius `control`, the shared `FOCUS` ring, `aria-haspopup="dialog"` and `aria-expanded` from `open`. The caller gives its fill and hover (the Calendar: an all-day event a filled pill in its calendar's colour, a timed one `hover:bg-surface-2`). Marked `data-chip`: check:responsive's `button-height` rule (28 or 32 px) is for controls, not for content whose height is its text's; `small-target` still holds it to 24 px. `CHIP_TITLE` cuts its title at 2 lines with no `Clamp`, because the chip opens the whole text. States: closed, open (`aria-expanded`), hover, focus-visible.

## CopyButton

A small bordered `text-xs` button (`border-strong`, `text-2`, hover `surface-2`) that writes `value` to the clipboard; `what` names it in its accessible name and title ("Copy item ID"). States: default ("Copy"), done ("Copied" for 1.5 s), no clipboard (nothing happens; the text stays selectable).

## CopyIcon

A ghost icon `Button` (`size-8`, lucide Copy icon) that writes `value` to the clipboard; `what` names it in its accessible name and title ("Copy reply"). Beside it a `text-xs` `aria-live="polite"` element says "Copied" for 1.5 s. States: default, done, no clipboard (nothing shows; the text stays selectable). Used under each chat reply, own message and fenced code block, in a `ButtonRow`.

## CopyText

A copy element: the shown text (`children`, else `value`) in `font-mono text-xs` that wraps, then a CopyButton that copies `value`.

## IdDetails

A readable name (`label`, e.g. "worker 3" or "you") as a plain button on the shared Tooltip: the full `id` shows in the tooltip on hover and keyboard focus (not in the DOM while hidden), and a click copies it and shows "Copied" in place of the label for 1.5 s, on the same line, so the row height never changes. No disclosure; with no clipboard a click does nothing. The copy logic is one helper shared with CopyButton. Pages use it so no raw ID shows in running text (design 09-dashboard-app).

## Clamp

Long row text (`web/src/components/ui/clamp.tsx`): a `<p>` clamped to 2 lines with `line-clamp-2`, and under it a small flush ghost `Button` ("Show more", then "Show less"; both from the i18n catalog, `clamp.more` and `clamp.less`) that opens the full text in place. The button appears only when the text is actually cut off, so a short text shows no control. It has `aria-expanded`. Props: the children (the text), `className` (the text style: size, colour) and `data-*`, both passed to the `<p>`. Write no `line-clamp` in `web/src/views/`: decision rule 7 in `patterns.md`. A whole block of long content (more than ~3 lines or a list) is a `Disclosure` instead.

## Disclosure

A native `<details>` with a `<summary>` at least 28px tall (`min-h-7`, like a small Button): the `DisclosureChevron` (turned down when open), then the label in `text-xs` medium `text-2`. The summary is a quiet hover target: `rounded-control`, pulled 6px left by its own padding (`-ml-1.5 px-1.5`) so the chevron starts where the text above it does (under a bordered list, on the list's left edge: the responsive check's `disclosure-align`), `surface-2` fill and `text-1` on hover. An open body starts 4px below the summary and ends 4px above what follows. Props: `summary` (the visible label), `children` (the body), `defaultOpen` (starts open; default closed), `lazy` (mount the body only while open, for a body that reads something on demand), `onToggle(open)`, `summaryTone` (the label colour on a pill fill), and `className` (a margin only) and `data-*` passed to the `<details>`. `aria-expanded` is on the summary and follows the open state; click, Enter and Space toggle it. Use it only for long content (more than ~3 lines or a list): decision rule 2 in `patterns.md`, never a single value. Write no raw `<details>` in `web/src/views/`; Markdown folds through it too.

## DisclosureChevron

The one expand mark (`disclosure.tsx`): lucide's ChevronRight at 14px (`size-3.5`; a caller may pass `size-4`), `text-3`, `text-2` when its trigger (marked `group`) is hovered, turned down (`rotate-90`) when `open` with a 150ms ease-out rotate (motion-safe). Carries `data-chevron`. The Disclosure summary, the Work tree's expand button (inside the ghost `icon` Button, 32px) and project folder rows draw it; never a ▸ text triangle. States: closed, open.

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

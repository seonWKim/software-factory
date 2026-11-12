# Components

The shared pieces in `web/src/components/ui`: plain React and Tailwind on the token classes of `foundations.md`, no component library. Each section gives the purpose, variants, sizes and states; `tests/web-ui-components.test.tsx` renders every one listed for the new components and checks that every exported component has a section here.

## Section

A titled block of a page: an h2, an optional count and an optional action at the end. No variants or sizes.

## Table

A data table at `sm` and up; below it, one card per row. Props: `head`, `label`, optional `numeric[i]` to right-align a heading. States: table, cards (below `SM_PX`).

## Tr

One row of a `Table`: a `<tr>`, or a card below `sm` (first cell the title, next two under it, the rest with their column names).

## Td

One cell of a `Tr`; in a card it wraps and drops width classes.

## DataTable

A `Table` built from `columns` and `rows`, on `Table`, `Tr` and `Td`. A column is `{ key, header, render?, numeric? }`. States: number columns right-aligned in `tabular-nums` (header too); a column empty in every row left out; cards below `SM_PX`; no rows shows `empty`.

## Badge

A small label tinted by `level` (from `LEVEL_TONE`); an unknown level is neutral. Keeps its name for existing pages; new code uses `StatusBadge`.

## StatusBadge

A level's name as a pill with a dot, tone from `LEVEL_TONE`. Variants: one per level in `LEVEL_TONE`, and neutral for an unknown level. Sizes: `sm`, `md` (default).

## Notice

An inline message. Variants (`tone`): `info` (default), `ok`, `warn`, `bad`. Optional title. `warn` and `bad` have role alert, the others role status.

## EmptyState

What a list shows when empty: a title, optional explanation, optional action. States: with or without explanation, with or without action.

## Empty

A one-line dashed box for an empty list. Plain text only; use `EmptyState` when there is an action.

## Loading

Row-shaped placeholders while the first read is in flight. Prop `rows` (default 3).

## ErrorNote

The "Could not load" message in the `bad` tone, role alert.

## PageHeader

A page's h1 with an optional description and optional actions. States: with or without description, with or without actions; actions wrap below the title when narrow.

## Input

A one-line field, 32 px high with padding-x 12 px, on the shared field classes of `control.ts` (1 px `border-strong` border, radius `control`, `surface` background, `text-sm`, placeholder in `text-3`). Variants (`type`): `text` (default), `search`, `number`; not for radios (see Radio). One size. States: default, with placeholder, focus-visible (2 px `focus` outline), `disabled` (opacity 0.5).

## Textarea

A multi-line field on the same field classes as Input, padding-x 12 px and padding-y 8 px; its height comes from `rows`. One size. States: default, focus-visible, `disabled`.

## Select

A native select 32 px high on the field classes, drawing its own chevron (in `text-2`) instead of the browser's; options are children. `wrapperClassName` sets the box around the select and its chevron (its width, its margin). One size. States: default, focus-visible, `disabled`.

## Field

A label (`text-sm`, font-medium) above its control with a 4 px gap, and optional help text (`text-xs`, `text-2`) below. `htmlFor` ties the label to the control's `id`. No variants or sizes. States: with or without `help`.

## ButtonRow

Buttons side by side with an 8 px gap, wrapping at a narrow width; the primary action goes last (macOS order). No variants or sizes: alignment comes from `className` (for example `justify-end` in the Dialog footer).

## Radio

A 16 px radio circle drawn from the tokens with its label (the radio's accessible name): a `text-2` ring on `surface`, checked an `accent` ring around a `surface` dot. Radios of a group share a `name`. One size. States: unchecked, checked, focus-visible, `disabled`.

## OverflowMenu

A "more" button (a `ghost` Button at size `icon`) that opens a menu of actions: items `{ label, onSelect, danger?, disabled? }`. States: closed, open; item default, `danger` (bad text), `disabled`. Esc, a click outside or choosing an item closes it.

## Kbd

A keyboard key as text, such as Esc. No variants or sizes.

## Tooltip

A short hint on hover and keyboard focus, hidden by Esc or leaving. Variants (`placement`): `top` (default), `bottom`. States: hidden, shown.

## Button

The dashboard's one button. Variants: `primary` (accent background, `on-solid` text: the one main action of a view), `secondary` (default: `border-strong` border on `surface`), `ghost` (no border, `surface-2` on hover), `danger` (`failed` text); `danger` with `solid` is filled with the failed colour, only for a confirm dialog's destructive confirm. Sizes: `md` (default, at least 32 px high), `sm` (at least 28 px), `icon` (32 px square). States: default, hover (enabled only), focus-visible, pressed (`aria-pressed` or `aria-checked`: `surface-2` background), `disabled` (opacity 0.5). `type` defaults to `button`.

## Switch

A `role=switch` button with `aria-checked`, 20 by 36 px; the thumb moves by a class. Controlled by `checked` and `onCheckedChange`. One size. States: on (`text-1` track), off (`border-strong` track), focus-visible, `disabled`.

## SegmentedControl

One choice among a few views (`role=group` with an `aria-label`): a 32 px box with a 1 px `border-strong` edge on `surface`, holding 28 px segments in one row that never wraps. Controlled by `value` and `onChange`; `options` gives each segment's `id` and label. States: selected (`aria-pressed`, `accent` fill, `on-solid` text), default (`text-2`), hover (`surface-2`, `text-1`), focus-visible.

## Dialog

The native modal `<dialog>`, opened on mount and closed on unmount, rendered into `document.body`: radius `card`, padding 24 px, a `text-base` semibold title, optional children and a one-line `consequence`, and a right-aligned ButtonRow footer with Cancel (secondary Button) before the confirm. Variants: default (confirm is a `primary` Button), `danger` (confirm is a `danger` Button with `solid`). States: open, `confirmDisabled`, with an `error` (shown in the dialog, role alert). Esc and a click on the backdrop cancel; Enter in a one-line field confirms; focus returns to `returnFocusTo`, else to the element focused when it opened. `announceStatus` shows a short status line after a send.

## Markdown

Renders a markdown string as safe elements. No variants or sizes.

## Brand

The mark and the wordmark at the top of the sidebar; below `sm` only the mark.

## BrandMark

The Gongbang mark alone, decorative; size comes from `className`.

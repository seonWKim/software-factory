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

A single-line text control. Sizes: `sm`, `md` (default). States: default, `invalid` (aria-invalid, bad border), `disabled`.

## Textarea

A multi-line text control, `rows` default 4. States: default, `invalid`, `disabled`.

## Select

A native select; options are children. Sizes: `sm`, `md` (default). States: default, `invalid`, `disabled`.

## Field

A label, one control (Input, Textarea or Select), an optional hint and an optional error. It sets the control's id, `aria-describedby` and, with an error, `aria-invalid`. States: with or without hint, with or without error.

## ButtonRow

A form's buttons in a wrapping row. Variants (`align`): `end` (default), `start`.

## Radio

One radio with its label; radios of a group share a `name`. States: checked, unchecked, `disabled`.

## OverflowMenu

A "more" button that opens a menu of actions: items `{ label, onSelect, danger?, disabled? }`. States: closed, open; item default, `danger`, `disabled`. Esc, a click outside or choosing an item closes it.

## Kbd

A keyboard key as text, such as Esc. No variants or sizes.

## Tooltip

A short hint on hover and keyboard focus, hidden by Esc or leaving. Variants (`placement`): `top` (default), `bottom`. States: hidden, shown.

## Button

An icon-sized button. Variants: `ghost` (default), `outline`. States: default, hover, focus-visible, `disabled`.

## Switch

A role=switch toggle. States: on, off, `disabled`.

## Dialog

The native modal dialog with a confirm and cancel. Variants: default, `danger` (the confirm button in the failed colour). States: closed, open, `confirmDisabled`, with an `error`. Esc and a click outside cancel; focus returns to `returnFocusTo`.

## Markdown

Renders a markdown string as safe elements. No variants or sizes.

## Brand

The mark and the wordmark at the top of the sidebar; below `sm` only the mark.

## BrandMark

The Gongbang mark alone, decorative; size comes from `className`.

# Patterns

How a dashboard page is put together from the shared components (`components.md`) and the scales (`foundations.md`). The Design system page of the dashboard (`web/src/views/design.tsx`, menu entry "Design system") shows every component; `tests/web-design-system.test.tsx` checks it uses every exported component. Text rules: `writing.md`. How to build and check a page: `dx.md`.

These are rules for new and changed pages. Existing pages move onto them in follow-up issues; the first is the Needs you redesign (wi_fc2c), see `dx.md`.

## Page layout

- One `PageHeader` at the top: the page title, an optional count, the page's one primary action at the end.
- Below it, `Section` blocks, each with an h2. One column of content at `sm` and below; the page never scrolls sideways.
- Spacing comes from the scale in `foundations.md` (gap and padding classes), never a pixel value.
- Colours are token classes. No hex colour, no Tailwind palette class (`tests/design-system.test.ts`).

## List rows

- A row starts with what the owner recognises: the item's title, not an ID.
- Then its state as a `StatusBadge`, then the facts that decide what to do next, then the time (`writing.md`, compact times).
- A table of rows uses `DataTable`: a table at `sm` and up, one card per row below it.
- The row opens the item page. Row actions sit at the end of the row.

## Actions

- One primary `Button` per page or box: the next step. Other actions are `secondary`; a link-like or tertiary action is `ghost`.
- `danger` is for an action that cannot be undone or closes work (Reject).
- Buttons sit in a `ButtonRow` (gap 8 px). Three or more actions on a row: the main one stays visible, the rest go into an `OverflowMenu`.
- A disabled button says why in a `Tooltip` or the line beside it.
- Never a raw `<button>`: the control set in `web/src/components/ui/` is the only place one appears.

## Confirmations

- An action that cannot be undone asks first in a `Dialog`, whose title names the action and the target by its readable name, and whose primary button repeats the action ("Reject").
- An action that can be undone, or retried, does not ask. It acts and says what happened.
- The dialog takes its fields from `Field`, `Input`, `Textarea`, `Select` and `Radio`.

## Status and system state

- An item's state is a `StatusBadge`, with the level word the lists use. State is never colour alone: the badge carries a word.
- A factory-wide state (paused, host asleep, a failing plugin) is a `Notice` at the top of the page, with the next step in it.
- A short, harmless remark is a `Notice` at the info level; a failure that needs the owner is the failed level.

## Loading, empty and error states

- Loading: `Loading` in the place the content will be. The page keeps its header.
- Empty: `EmptyState` says what the page is for and what makes something appear here, with the next step as an action when there is one. `Empty` is the one-line version inside a section.
- Error: `ErrorNote` says what failed in plain words and how to retry. It never shows a stack trace or a raw status code alone.
- A refused action shows its reason beside the button that was pressed.

## Forms and keyboard

- Every field is a `Field` with a visible label. The accessible name matches the label, or the label is longer.
- A form's primary button is the form's submit; Enter in a single-line `Input` submits it, and Escape closes a dialog.
- Controls share one focus ring and one disabled look (`tests/design-system.test.ts`). Never remove the focus ring.
- A keyboard shortcut is shown with `Kbd`, listed in the shortcuts view, and never the only way to do something.
- Every control is reachable by Tab in reading order, and a menu opens and closes by keyboard.

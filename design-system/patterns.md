# Patterns

How a dashboard page is put together from the shared components (`components.md`) and the scales (`foundations.md`). `components.md` lists each component, and `tests/web-ui-components.test.tsx` checks each exported one has a section. Text rules: `writing.md`. How to build and check a page: `dx.md`.

These are rules for new and changed pages. Existing pages move onto them in follow-up issues; the first is the Needs you redesign (wi_fc2c), see `dx.md`.

## Page layout

- One `PageHeader` at the top: the page title, an optional count, the page's one primary action at the end. Each page renders its own `PageHeader` (on the item and transcript pages with the item's or run's title); the app shell draws no title, so every page has exactly one h1. Chat is the one page with no visible title (owner, 2026-11-28): no `PageHeader`, only an `sr-only` h1, so its conversation starts at the top.
- One of two page widths, chosen by `PageHeader`'s `width`: `wide` (`--page-wide`, 1232px, the default) for lists and tables, `read` (`--page-read`, 960px) for forms and reading (Settings, Rules). `<main>` takes its `max-width` from it; no page or page wrapper sets a `max-w-*` of its own. Field, table-cell and prose widths (`max-w-md`, `max-w-[75ch]`) stay.
- Right under the header, one `PageToolbar` when the page has tabs, a search, a view switch or filters: the tabs on its first row, the search, view switch and filters on its second. Never between blocks of content, inside a Card or below them, even when it narrows one list (Health's Failures window, Workers' window, Calendar's switch and period buttons, the Transcript's step filters, Settings Advanced's and Rules' searches).
- Below it, `Card` blocks, each with an h2 in the one section title size (`CARD_TITLE`); Card is the only place a page's h2 comes from, except the Calendar's period heading, which sits in its toolbar line in the same `CARD_TITLE` type (09-dashboard-tasks-calendar). A sub-group inside a card (a `CardSection`, a calendar day, a group of task rows) is an h3 in the one sub-group style (`SUB_TITLE`, `text-xs font-medium text-text-2`), never a raw heading class. One column of content at `sm` and below; the page never scrolls sideways.
- Every button on a page is 28px (`sm`, the segments, a Disclosure's trigger) or 32px (`md`, `icon`, tabs, a Select) tall. Controls on one toolbar row are one height, 32px: a `sm` Button in a `PageToolbar` is drawn `md`.
- Text a page shows as stored or as written (a title, a body, a check's message, an error detail, a stored code, a transcript, a Data table) sits inside `[data-raw]`; outside it a page shows no snake_case name and no `wi_` ID.
- Blocks of one page are stacked in one flex column with a `gap-6` (the Card gap), not with `mb-*` or `mt-*` on each block.
- Spacing comes from the scale in `foundations.md` (gap and padding classes), never a pixel value.
- Colours are token classes. No hex colour, no Tailwind palette class (`tests/design-system.test.ts`).

## List rows

- A row starts with what the owner recognises: the item's title, not an ID.
- Then its state as a `Badge`, then the facts that decide what to do next, then the time (`writing.md`, compact times).
- A table of rows uses `DataTable`: a table at `sm` and up, one card per row below it.
- A table fits the window: its buttons and links never end past the right edge inside the table's sideways-scrolling wrapper, because there the owner can neither see nor reach them (`check:responsive` reports it as `offscreen`). Fix the row the shared way (wrap or stack its actions, as the item page Runs do). Only a table meant to scroll sideways, a wide grid of data read by scrolling, marks its wrapper `data-scroll-x`; never add it to hide a cut-off action.
- The row opens the item page. Row actions sit at the end of the row.
- **C-050** (2026-11-15). An action's error shows on its own line below the row's content, full width, or in the shared `Notice` or toast; never in the actions column. The title keeps its space and truncates only at the row's real width; the status badge and the actions never overlap, at every `check:responsive` size. The Tasks page's Factory work row follows it (`SendErrors` on a `basis-full` line); so do the Needs you rows, a merge's refusal included (2026-11-22).

## Actions

- One primary `Button` per page or box: the next step. Other actions are `secondary`; a link-like or tertiary action is `ghost`.
- `danger` is for an action that cannot be undone or closes work (Reject).
- Buttons sit in a `ButtonRow` (gap 8 px). Three or more actions on a row: the main one stays visible, the rest go into an `OverflowMenu`.
- A disabled button says why in a `Tooltip` or the line beside it.
- Copy: each reply, own message and code block has a `CopyIcon` (a ghost icon `Button`, named "Copy reply", "Copy your message" or "Copy code") in a `ButtonRow`; its "Copied" line sits beside it in an `aria-live="polite"` element for 1.5 s.
- Never a raw `<button>`: the control set in `web/src/components/ui/` is the only place one appears.

## Confirmations

- An action that cannot be undone asks first in a `Dialog`, whose title names the action and the target by its readable name, and whose primary button repeats the action ("Reject").
- An action that can be undone, or retried, does not ask. It acts and says what happened.
- The dialog takes its fields from `Field`, `Input`, `Textarea`, `Select` and `Radio`.

## Status and system state

- An item's state is a `Badge`, with the level word the lists use. State is never colour alone: the badge carries a word.
- A factory-wide state (paused, host asleep, a failing plugin) is a `Notice` at the top of the page, with the next step in it.
- A short, harmless remark is a `Notice` at the info level; a failure that needs the owner is the failed level.

## Autonomous work is visible

Owner decision (2026-11-26): "Visibility is also important for this autonomous tasks and add it as a design rule if needed."

- Every actor that acts without the owner has a place on a factory page: worker runs, schedules, personas, the improve and self-update loops, the chat back end (RFC 0025), and anything new that runs on its own.
- That place shows what the actor is doing now, in plain words (`writing.md`); its recent actions, each with its outcome and the reason for it; and a link to each action's transcript or log.
- Nothing that changes state is invisible: every item, rule, setting, branch, merge or sync write an actor makes shows in one of those places.
- A new autonomous feature is not done until it has this place. Its topic file in `docs/design/` names the page. A new schedule action kind (a persona is a feedback schedule) is named on the Schedules page and listed in `AUTONOMOUS_SURFACES` (`tests/design-system.test.ts`).

## Loading, empty and error states

- Loading: `Loading` in the place the content will be. The page keeps its header.
- Empty: `EmptyState` says what the page is for and what makes something appear here, with the next step as an action when there is one. Inside a card, an empty list is an `EmptyState` with its title alone.
- Error: `ErrorNote` says what failed in plain words and how to retry. It never shows a stack trace or a raw status code alone.
- A refused action shows its reason beside the button that was pressed; in a list row, on its own line below the row (C-050).

## Forms and keyboard

- Every field is a `Field` with a visible label. The accessible name matches the label, or the label is longer.
- A form's primary button is the form's submit; Enter in a single-line `Input` submits it, and Escape closes a dialog.
- Controls share one focus ring and one disabled look (`tests/design-system.test.ts`). Never remove the focus ring.
- A keyboard shortcut is shown with `Kbd`, listed in the shortcuts view, and never the only way to do something.
- Every control is reachable by Tab in reading order, and a menu opens and closes by keyboard.

## Decision rules

Seven short rules from the owner's review of 2026-11-15. Each can be checked on a page or in a diff; a reviewer names a broken rule by its number ("breaks decision rule 2"). Rule 1 puts the primary action first; `components.md` (`ButtonRow`, the `Dialog` footer) still shows it last until a follow-up issue aligns them.

1. **One decision = one action row. Primary action first, the rest in the same row or in the "…" menu. No wrapping into stacked rows at desktop width.**
   - Good: the item page shows Approve, then Revise, in one `ButtonRow`, with Reject in the `OverflowMenu`.
   - Bad: Approve on one row, Revise and Reject on a second row under it, and a third row for Retry, all for the same decision.
2. **Only collapse what is long (more than ~3 lines or a list). Never put a single value behind a disclosure.**
   - Good: Health shows "Merged by you (github:69591622)" as plain text, and a list of twelve runs behind "Show runs".
   - Bad: Health shows "Merged by ▶ you", and the reader opens the triangle to see one short value, github:69591622.
3. **A page with more than 3 unrelated sections uses the shared underline Tabs, one section per tab, tab in the URL.**
   - Good: Health puts Merges, Plugins, Stalls and Budget on four `Tabs`, and a link to the Stalls tab opens that tab.
   - Bad: Health stacks Merges, Plugins, Stalls and Budget on one long page, and the reader scrolls past three to reach the fourth.
4. **A decision dialog shows what the decision is based on (evidence, source, before/after) above the inputs.**
   - Good: the Rules promote dialog shows the pushbacks the rule came from and the rule text before and after, then the note field and Promote.
   - Bad: the Rules promote dialog shows only a note field and Promote, so the owner decides without seeing what is promoted or why.
5. **One input per purpose; no second box that does the same thing.**
   - Good: one `Textarea` labelled "Note" takes the owner's words.
   - Bad: a note box and a second "Say it in your own words" box on the same form, both sent as the owner's text.
6. **Show only actions that apply now; no "what you need to decide" box when nothing waits on the person.**
   - Good: an item that waits on an agent shows its state and the next step the factory takes, with no decision box.
   - Bad: an item that waits on an agent still shows a "What you need to decide" box, with buttons that do nothing yet.

7. **Long row text clamps to 2 lines with `Clamp` and opens in place.**
   - Good: Plugins → Skills shows two lines of each description, and "Show more" opens the rest of that row.
   - Bad: a row prints a 10-line description, so only three skills fit on the screen; or a view writes `line-clamp-2` by hand.

## History

- **A page's views and filters went "in the row under the page title"** (until 2026-11-20, the page template decision in docs/design/09-dashboard-shell.md). Before: each page placed its tabs, search and switches itself (Work's search above its state tabs, Calendar's switch in a column of its own, Health's failure window in the middle of the page), pages set their own widths (Rules `max-w-3xl`) and sub-group h3s had three styles.

- **A list row's failed send showed in its actions column** (until 2026-11-15, replaced by C-050). Before: the row's error text sat in the actions cell beside the primary button, so a long error shrank the title ("Tas…" in Factory work) and pushed the button onto the status badge.

# Writing

The words on a dashboard page. Layout and components: `patterns.md`.

## Rules

- **Sentence case.** "Needs you", "Work items", "Approve". Capitalise the first word and proper names only, in headings, buttons, labels and badges.
- **The next step.** Every message that says something is wrong or waiting also says what to do: "Approve to merge", not "Waiting for a decision". A state with no next step says so ("Nothing to do").
- **No raw IDs.** Never `wi_…` or a full ID in running text. Show the item's title, else its short number `#N`, else the 8-character local id. People and workers have names too: "you", "worker 2", "the factory". The full ID is one click away in `IdDetails` with `CopyText`.
- **Slash commands and CLI syntax are never the main text.** A box leads with a sentence and a button. The command, such as `factory approve 123`, is a secondary line ("From a terminal: …") with a copy button.
- **Compact times.** "5m", "3h", "2d" (`ago` in `web/src/lib/format.ts`), never "5 minutes ago" or an ISO timestamp. The full time goes in a `title` or a `Tooltip`.
- **Short.** One idea per sentence. Say what the page shows, not how it works.

## Text goes through t()

Every English text the app shows lives in the catalog, `web/src/i18n/en.ts`, and is read with `t("key", vars)` (`web/src/i18n/index.ts`), so a locale is one new file. Do not write English text in JSX, nor in `aria-label`, `title` or `placeholder` attributes: `tests/web-i18n-text.test.ts` fails on it. A text with a value in it takes a variable, `t("format.in", { time })`, never string concatenation. This is the text-catalog work of wi_9b74.

Keys are grouped by page or component. Add a key beside its neighbours, not at the end of the file.

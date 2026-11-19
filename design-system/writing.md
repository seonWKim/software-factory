# Writing

The words on a dashboard page. Layout and components: `patterns.md`.

## Rules

- **Sentence case.** "Needs you", "Work items", "Approve". Capitalise the first word and proper names only, in headings, buttons, labels and badges.
- **The next step.** Every message that says something is wrong or waiting also says what to do: "Approve to merge", not "Waiting for a decision". A state with no next step says so ("Nothing to do").
- **No raw IDs.** Never `wi_…` or a full ID in running text. Show the item's title, else its short number `#N`, else the 8-character local id. People and workers have names too: "you", "worker 2", "the factory". The full ID is in the tooltip of the name (`IdDetails`: hover or focus, click to copy), or in `CopyText`.
- **Slash commands and CLI syntax are never the main text.** A box leads with a sentence and a button. The command, such as `factory approve 123`, is a secondary line ("From a terminal: …") with a copy button.
- **Compact times.** "5m", "3h", "2d" (`ago` in `web/src/lib/format.ts`), never "5 minutes ago" or an ISO timestamp. The full time goes in a `title` or a `Tooltip`.
- **Short.** One idea per sentence. Say what the page shows, not how it works.

## Plain words for everyone

Write for a reader who has never seen the code: the owner on a busy day, or someone they show the page to. Before you add a text, ask: would a person who does not program understand it and know what to do? If not, rewrite it.

- **No code names in the text.** Field names, reason and error codes, setting keys, environment variables, table names, file paths, API routes and event names (`blocked_on`, `max_attempts`, `spec_conflict`, `rule_of_two`, `approve_merge`, `ANTHROPIC_API_KEY`, `recently_closed`) never appear in a heading, label, badge, button or sentence. Each has a plain label in the catalog. The raw name may sit only in a "Details" disclosure, in a `code` element the reader asked to see, or on a developer page (Data).
  - Bad: "failed: spec_conflict". Good: "The plan doesn't allow a file the work needs. Change the plan or allow the file."
  - Bad: "Waiting for a person: rule_of_two". Good: "Plan approved automatically. Start building?"
- **No machinery words.** Do not explain the system's insides on a page: controller, tick, lease, claim, heartbeat, replica, slot, draining, broker, forge, egress, outbox, ledger, pass, poll. Say what the reader sees happen ("the factory", "within a minute", "this computer"). If a setting can only be explained in machinery words, it goes under a "For developers" group.
- **Say what a value means.** A number has a unit and a reading, not only a value. "Risk: high (tier 4)", not "Tier 4". "98% merged with no fix from you", not "Autonomy: 0.98". "3 of 3 running", not "3 busy, 0 idle, 3 slots". Tokens go with their cost where the cost is known. Say a count once: no "Checks (27)", then "27", then "27 ok".
- **Times for people.** A time of day or a date shows in the viewer's local time in a short form ("9:51 PM", "Nov 13"), never ISO ("2026-11-19T12:51:02.000Z") and never "UTC" in the main text. If a total is grouped by UTC day, say that once in the section's help text.
- **Events are sentences.** A history or timeline line says who did what in words: "You asked for a retry", not "retry_requested by you — blocked_on: human → none". Field changes ("restart_count: 3 → 4") go under Details, or are left out.
- **Problems in three parts.** What happened, in the reader's words; why, if it helps decide; what to do now, as a button. "Failed 3 times, so the factory stopped. Retry, change the plan, or close it." The error code and the raw message go under Details.
- **Short help, not a manual.** Help under a heading or a setting is one or two sentences on what it does for the reader. The full rules of a command or setting belong in `/help` or the docs, linked, not pasted in. A command list in a message names each command with a few words; its fine print goes behind "More".
- **One word per thing.** Use the glossary's word for each thing, the same on every page, button and message. No synonyms (task / item / issue / ticket for the same thing). A new term needs a glossary line first.
- **Text the server writes follows these rules too.** Why sentences, failure descriptions, health check lines, refusals and agent-written summaries shown on a page (`src/ui/`, `src/core/commands.ts`, the improve report) are page text. When an agent writes the text, its prompt asks for plain words.

## Glossary

The factory's words, as the reader meets them. Explain a word in a `Tooltip` or a short phrase the first time a page uses it, where a reader may not know it.

| Word on the page | What it means for the reader | Not |
|---|---|---|
| Task | Something you asked for, in your list. | ticket |
| Work item | A task the factory is working on: planning, building, reviewing or merging it. | issue (unless it is the GitHub issue), job |
| Plan (spec) | What the factory will change and how it checks it is done. You approve it before building starts. | spec alone, without "plan" on first use |
| Step | One stage of a work item's work: planning, building, review, fixing a conflict. | run kind, `triage`, `implement`, `resolve` |
| Try | One attempt at a step. Counted from 1. | attempt 0 |
| Worker | A part of the factory that works on one task at a time. | slot, lease, replica |
| Risk level | How careful the factory must be with a change, from 0 (low) to 4 (high). High risk always waits for you. | tier alone, gate |
| Needs you | Waiting for your decision. | blocked on human |
| Waiting for another task | Starts when the named task finishes. | blocked by dependency, held behind |
| Auto mode / Manual mode | Whether the factory may approve and merge low-risk work itself. | |
| Rule | Guidance added to every agent's instructions, learned from your corrections. | ledger entry, class, candidate |
| Check | A test the factory runs on itself or on a change. | probe |

## Text goes through t()

Every English text the app shows lives in the catalog, one file per area under `web/src/i18n/en/` (`web/src/i18n/en.ts` joins them and is generated by `npm run i18n:catalog`), and is read with `t("key", vars)` (`web/src/i18n/index.ts`), so a locale is one new file. Do not write English text in JSX, nor in `aria-label`, `title` or `placeholder` attributes: `tests/web-i18n-text.test.ts` fails on it. A text with a value in it takes a variable, `t("format.in", { time })`, never string concatenation. This is the text-catalog work of wi_9b74.

Keys are grouped by page or component. Add a key beside its neighbours, not at the end of the file.

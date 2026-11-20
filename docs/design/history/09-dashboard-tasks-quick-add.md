## History

- **Quick add showed only the server's refusal, and a timed row showed 30 min with no stored duration** (until 2026-11-20, wi_a03550f9; replaced by the quick-add preview decision at the top). `QuickAdd` posted the raw words and showed nothing until the server refused them, so words it did not read (an `every week` before other tokens) went into the title unseen; `TaskCard` showed `DEFAULT_MINUTES` (30) for a timed task with no stored duration, and drew no project on the row.
- **Quick add on a project tab sent no project** (decision changed 2026-11-18, the quick-add decision above). Before: the page posted `{ id, words }` whatever the tab, so the task was stored with no project unless the words had `+slug`, and the tab's list did not show it.

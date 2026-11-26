## History

- 2026-11-13 (wi_199b), replaced 2026-11-16: the daily chart was one bar per UTC day with a native title and a screen-reader label ("2026-11-07: $568.79"); below it the first date, the most costly day's amount and the last date. No y-axis, no top items, no filter.
- 2026-11-20, replaced: the Page bullet said the Spend section shows today, this week and the last 30 days, one daily bar chart and the tasks by cost; the totals showed no budget and the answer carried none.
- 2026-11-13 (wi_199b), replaced 2026-11-24 (local-task-tk_956892cd phase 2 of 3): the counted runs were `SPEND_KINDS`: triage, implement, review, resolve, update. Routine runs were left out of every total, day, item and budget.
- 2026-11-13 (wi_199b), replaced 2026-11-26 (local-task-tk_eea9af6d phase 2 of 2): spend had no table of its own and no migration; it was read only from the stored run outcomes, and the LLM provider's own calls (chat turns) were not counted.
- 2026-11-26 (local-task-tk_eea9af6d phase 2 of 2), replaced 2026-11-27 (local-task-tk_f8e0e9d6 phase 1 of 3): every `controller_chat_spend` row was a chat turn, with no kind column, and the chat total read every row of the range.

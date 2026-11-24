# History of 09-dashboard-rules: one file per replaced decision

- **Replaced decisions of the Rules page go into one file each** (decision changed 2026-11-24).
- Before: each replaced decision was added as a new bullet at the top of `docs/design/history/09-dashboard-rules.md`, so two items changing this page in parallel edited the same lines and conflicted (5 conflict runs in 7 days).
- Now: a replaced decision is a new file `docs/design/history/09-dashboard-rules/<yyyy-mm-dd>-<slug>.md`. The old file is frozen and its bullets stay where they are.

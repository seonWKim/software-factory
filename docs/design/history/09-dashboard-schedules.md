# History: 9. Status page: dashboard Schedules page

- **The two Cards sat in a flex column with the Section gap** (decision 2026-11-24, local-task-tk_0ae5a8e9 phase 2 of 2; replaced 2026-11-24, owner UI review). Before: "Under it two Cards in one flex column with the Section gap"; the column's `gap-6` added to the Card's own `mt-6`, so the space between the schedules and the runs Card was double the other pages'. Now: the Cards are siblings after the header, spaced by the Card's margin alone, as on Health, Settings and Routines.

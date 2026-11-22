## History

- **Nothing calls the scheduler and no action is defined** (decision 2026-11-22, wi_a519d81a, phase 1 of 2; replaced 2026-11-23, wi_9a35f49052e147d9bd48df8ecb40eb94). Before: "Nothing calls the scheduler yet and no action is defined: this phase is the records, the cadences and the claim." `runDueSchedules` had no caller, and a fired occurrence ran nothing.

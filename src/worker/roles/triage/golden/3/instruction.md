Phase 1 of 3 of the settings split: move the budget settings into their own file

The settings catalog is one large file. Split it by subject over three phases: (1) budgets, (2) models, (3) sandbox. Each phase moves its keys and their tests, and must merge on its own. Phase 2 waits for phase 1, phase 3 for phase 2. The catalog stays in `src/settings/`.

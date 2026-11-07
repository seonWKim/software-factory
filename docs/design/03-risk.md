# 3. Risk

- **Tier** = max(agent judgment, human floors). Rechecked at review; never lowered.
- **Floors cover every credential reader (decision changed 2026-11-07; before: see History).** A floor is a path prefix in `factory.config.json`, a folder or a single file. Besides the folders (runner, broker, egress, secrets, auth, `.claude/`), the two GitHub credential files have their own tier-4 file floors: `src/impl/github/app-credentials.ts` and `src/impl/github/token-credentials.ts`. The rest of `src/impl/github/` keeps no floor. `tests/credential-floors.test.ts` reads the floors from the checked config and fails for any src file that imports the SecretStore interface or names a secret with `secretName()` unless a tier-4 floor covers it or it is on the test's exempt list with a reason. The other secret readers (Slack, MySQL, Claude and OpenAI-compatible providers, `src/setup.ts`, `src/main.ts`) are exempt as "follow-up" until a separate task floors them. Solo and enterprise are the same: floors change only through a reviewed PR to the checked config.
- Tier ≥ 3: human approval. Tier 5: rollout plan.
- `spec_gate_min_tier`, `auto_merge_max_tier` start fully gated (auto-merge at 0).
- **Ratchet:** moving a dial toward safety is automatic + notify. Loosening or any structural change is a human decision backed by a number.

## History

- Until 2026-11-07: floors were folders only, and no test checked that credential readers sit under one. The GitHub App and token credential files fell outside every floor, so a change to them could pass at tier 2 or 3. Changed to give each a tier-4 file floor and to add the credential-floor test.

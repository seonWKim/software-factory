# Backlog (seed issues for Phase 2)

Each line becomes a GitHub issue labeled `factory` once Phase 1 works. Order matters; see `PLAN.md`.

## Phase 1 PoC (before the exit criterion)

Built by hand, not by the factory.

- P1. `/revise <feedback>` on a pending spec: keep the item open, re-run triage with the feedback, post a new spec. `/reject` comments on and closes the source issue. Found on issue #4: `/reject <reason>` closed the item and dropped the reason. Update `docs/design.md` (gate commands) in the same change.

## Phase 2 seed issues

1. CI gate: fail when the diff touches files outside the work item's `allowed_paths`
2. CI gate: diff-size limit and protected paths (floor directories)
3. Human verdict form: verdict + severity + reason, recorded against the work item
4. Weighted human feedback rate per tier, with a per-tier min sample
5. Revert and fix-forward tracking (`merge_sha`, `fixes_pr`) into `state_changes`
6. Per-tier token budgets → `blocked_on: budget`
7. `restart_count`, exponential backoff, dead-letter to a human at `max_restart`
8. Golden PR set from rejected / reverted / held-up PRs; catch and false-alarm rate per agent
9. Parallel workers: per-worker ports and test DB; merge-conflict → `merge_conflict_pending`
10. Progressive disclosure layout + `CapabilitySearch` (BM25)

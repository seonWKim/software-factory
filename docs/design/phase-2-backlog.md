# Phase 2 backlog

Design-side order of the Phase 2 work; `BACKLOG.md` seeds the issues.

1. **CI gate** (§5 CI gate): the `test` workflow on PRs and pushes to `main`, `test` required by branch protection, and the controller's check gate before `merge_pending`. Built 2026-11-01.
2. CI scope gate: fail when the diff touches files outside the work item's `allowed_paths` (BACKLOG.md #1).

## History

No earlier decision is recorded for this topic.

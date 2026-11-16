## History

- **`/retry` releases a held phase** (2026-11-12). Before: a held phase fell under the generic "other blocked" command phase, so `/retry` did nothing on it, and a phase whose previous phase closed without a merge (rejected as superseded by other work) stayed held forever and had to be refiled by hand (#598, phase 3 of #569 after #595 was rejected).

- **A split spec is approved on an item from any source** (2026-11-12). Before: `/approve` on a split spec whose parent's source had no `fileSubIssue` (a Slack thread) was refused ("this source cannot file sub-issues, so a split spec cannot be approved here; reply `/revise <feedback>` to get a spec without phases"), and "Local tasks split too" listed Slack as not built, so a large Slack ask had to be refiled by hand as local tasks.

- **Phases are filed through outbound** (2026-11-09, RFC 0015 M7). Before: `/approve` filed every phase inline (the phases unit called `fileSubIssue`, the last entry of the `forge-writes` ratchet), in one pass; a failure refused the approval (`split_filing_failed`, back at the spec gate, "filing stopped after k of N; reply `/approve` again"), and a claim older than 10 minutes (`SPLIT_FILING_STALE_MS`), left by a process that stopped mid-filing, could be taken over by `/approve`.

- **Local tasks split too** (2026-11-07). Before: only the GitHub source offered `fileSubIssue`, so `/approve` on a local task's split spec was refused (`local-d8e25824`), and neither `task show` nor the item page listed sub-tasks.

- **One approval files a split** (2026-11-07). Before: every pass that read the spec at the gate filed the phases and only the final transition was conditional, so two controllers applying one `/approve` (a draining process and its successor) filed phases 2..N twice when the marker lookup missed.

- **Only recorded phases count** (2026-11-07). Before: every work item linked to the parent counted, so a duplicate phase closed as not planned kept the parent open forever (#172 and #252 got duplicate phases from two approvals racing).

- **Phase issues** (2026-11-07, issue #229). Before: the title could read "Phase 2/4: Phase 2: …", and the body opened with "Phase N of M of owner/repo#163 (https://…)" and had no In short.

- **Split specs** (decision changed 2026-11-01, issue #102). Before: triage returned no size estimate and one spec for the whole issue, so a change too big to review was found only by the size gate after an implement run had spent its tokens, and the size-check comment asked for a smaller spec without saying how.
- **Phase spec approval** (changed 2026-11-07). Before: each phase always waited for its own `/approve`, though the owner had already approved the split on the parent. It still does by default; `phases_auto_approve` turns that off.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: local task sub-tasks were read on "the shared MySQL store"; the phases store was "one migration, SQLite 13 and MySQL step 13 (`work-item-phases`)", followed by: "MySQL step 13 is an inline step (`INLINE_STEPS` in `src/impl/store/mysql/migrations.ts`), not a file in `migrations/mysql/`, because that folder was outside this change's allowed paths. It is numbered, checked for gaps and duplicates, and applied by `npm run migrate` exactly like a `0013-work-item-phases.sql` file, so moving it into that file later changes nothing for a database that already ran it."

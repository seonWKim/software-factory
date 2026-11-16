# 09-status-page

- **Seven functions each derived an item's state** (until 2026-11-16, the one-phase decision at the top). Before: `statusOf`, `commandPhase`, `awaitingMerge`, the API's `readyToMerge` (a copy of `awaitingMerge`), `levelOf`, the web's `detailLevel` and `noticeKind` each read stage, blocked_on, blocked_reason and close_reason with their own checks.
- **`max_revisions` by surface** (until 2026-11-16). Before: the status label said needs human, the level Needs you, the item page Needs approval, the notice kind other.
- **merge_pending and spec_pending at any stage** (until 2026-11-16). Before: `levelOf`, `detailLevel` and `noticeKind` read the reason without the stage.
- **Work counted running items by level** (until 2026-11-16). Before: the Work summary's "N running" counted listed items whose level was running, Activity counted running runs, so they could differ ("0 running" and "3 running").
- **Open items and All by different rules** (until 2026-11-16). Before: Activity's Open items summed the stage counts, Work's All counted the listed rows (at most 200, closed ones included in the read), so they could differ ("Open items 15" and "All 11").
- **The why sentence in English on the server** (until 2026-11-16). Before: `src/ui/why.ts` and `src/ui/need.ts` wrote the reason in English ("Too many review loops…", "review found bugs too many times"), the API sent it as `why.text`, and a held item read "Held behind <holder ref>", a raw local id for a local holder.

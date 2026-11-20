## History

- **Four relative-time shapes and raw names in page text** (decision changed 2026-11-19, the plain words decision at the top of 09-dashboard-shell.md). Before: `ago` ("12s", "4m") and `until` ("in 4m", "now") were wrapped at each call site ("4m ago", "since 4m ago", "(as of 4m ago)", "started 4m ago") with no tooltip; pages printed field and reason codes as text (`blocked_on: none → human`, `agent_needs_human`, `checks_failed`), a run status as stored ("succeeded"), lower-case done and closed words, and `⌘K` listed Data like any page.

- **The catalog barrel was a hand-written list** (replaced 2026-11-18 by the generated barrel decision at the top of 09-dashboard-shell.md). Before: `web/src/i18n/en.ts` imported the eight area files by hand and spread them on one line, so every item that added an area file edited the same import list and spread line.

- **The remaining views kept English inline** (decision changed 2026-11-13). Before: `item-commands.tsx`, `item-decisions.tsx`, `rules.tsx`, `transcript.tsx` and `tree.tsx` held English text and were listed on the baseline of `tests/web-i18n-text.test.ts`; new UI text had no written rule.

- **The catalog held the app shell's text only** (decision changed 2026-11-12). Before: `web/src/i18n/en.ts` held the text of the sidebar, top bar, Refresh, theme control and the Needs you heading; the Pages, Settings, Standing approvals, Tasks and Data views kept English inline, listed on the baseline of `tests/web-i18n-text.test.ts`.

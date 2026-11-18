# 9. Status page: dashboard Activity page

- **Work and Activity sit under System in the sidebar (decision changed 2026-11-15; current; replaces "Work and Activity are in the Factory group", from the menu-groups decision of 2026-11-11, see History).** `PAGES` in `web/src/pages.ts` gives Work (`/app/items`) and Activity (`/app/activity`) group `system`, as the first two System entries, before Health: System reads Work, Activity, Health, Failures, Spend, Rules, Runners, Data. The Factory group is gone with the Needs you page (the 2026-11-15 landing decision above). Paths, redirects, page content and `web/src/App.tsx` are unchanged.

- Replaced decisions of this topic: [history/09-dashboard-activity.md](history/09-dashboard-activity.md).

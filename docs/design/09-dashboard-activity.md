# 9. Status page: dashboard Activity page

- **Running now is drawn on Work's Activity section only (decision changed 2026-11-22, wi_149faba7; current; replaces Running now on both Work and the Runners page, see History).** `ActivityPage` (`web/src/views/pages.tsx`) is the one place the Running now table shows; Health's Runners tab has the worker processes only ([09-health.md](09-health.md)). The "Runs failed" figure links to `/app/health?tab=failures&window=24h`. Work's `PageHeader` reads "Work = what the factory is doing".

- **Work and Activity sit under System in the sidebar (decision changed 2026-11-15; current; replaces "Work and Activity are in the Factory group", from the menu-groups decision of 2026-11-11, see History).** `PAGES` in `web/src/pages.ts` gives Work (`/app/items`) and Activity (`/app/activity`) group `system`, as the first two System entries, before Health: System reads Work, Activity, Health, Failures, Spend, Rules, Runners, Data. The Factory group is gone with the Needs you page (the 2026-11-15 landing decision above). Paths, redirects, page content and `web/src/App.tsx` are unchanged.

- Replaced decisions of this topic: [history/09-dashboard-activity.md](history/09-dashboard-activity.md).

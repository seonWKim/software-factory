## History

- **The help dialog listed only the shortcuts, and the search only pages and items** (decision changed 2026-11-19, the command help decision at the top of 09-dashboard-shell.md). Before: `?` showed the keyboard shortcuts and `⌘K` searched the pages and the loaded items; the item commands were explained only on the item page (button titles with their `/command` usage and "From a terminal: `factory <command> <short number>`").
- **The catalog barrel was a hand-written list** (replaced 2026-11-18 by the generated barrel decision at the top of 09-dashboard-shell.md). Before: `web/src/i18n/en.ts` imported the eight area files by hand and spread them on one line, so every item that added an area file edited the same import list and spread line.

- **Show/hide sections were hand-written `<details>` and a button** (replaced 2026-11-18 by the shared Disclosure decision at the top of 09-dashboard-shell.md). Before: each view wrote its own `<details>` with its own classes (a bordered box for "How this works", a bare triangle for "Show applied rules", `mt-2`/`mt-6` margins), and a Rules card's "Why and where" was a ghost button with a chevron and `aria-expanded`.

- **The top bar showed a Needs you chip, "updated Ns ago" and three theme buttons** (replaced 2026-11-18 by the top bar decision at the top of 09-dashboard-shell.md). Before: a "Needs you (N)" link repeating the sidebar Tasks badge, an "updated Ns ago" or "not updated yet" text, three System, Light and Dark icon buttons as a radio group, a mode switch with only a `title`, and a Refresh icon that never spun.

- **A server-rendered page beside the app at `/classic` and `/items/<id>`** (until 2026-11-16, the app-only decision at the top). Before: `/classic` served the server-rendered status page (`src/ui/pages.ts`: the factory banner, open alarms, GitHub API, Running now, Queue, Paused, the filter form, the ranked items, Health with Run now, the improve report, Totals, Merges and Cost) and `/items/<id>` its item page; an inline script, allowed by hash, refreshed them every 5 s under an "updated N s ago" bar, the Run now script added its own hash to the CSP, and the error pages shared that shell with a home link to `/classic`.

- **A readable name opened to its ID** (decision changed 2026-11-15, IDs in a tooltip). Before: `IdDetails` showed the name as a details summary that opened to the full ID and a Copy button (the readable-names decision of 2026-11-12). Opening made rows taller.

- **The app shell drew the page title** (decision changed 2026-11-14, the PageHeader decision at the top). Before: `web/src/App.tsx` drew a plain h1 with the page name on every page except Needs you (and the item and transcript views, which had none); Needs you and Rules drew a `PageHeader` too, so Rules had two h1. Runners showed the factory state as a hand-made coloured paragraph (`BANNER_TONE`, `mb-4`).

- **Users page** (new decision 2026-11-08, issue #445; page removed 2026-11-11; API removed 2026-11-13, #577). The decision was: local users and roles can be read and changed from the dashboard (`GET`/`POST /api/v1/users`, `src/ui/users-api.ts`, through the CLI's `users` actions; the page `web/src/views/users.tsx` at `/app/users`). On 2026-11-11 the page and its sidebar entry went and `/app/users` redirected to `/app/`; on 2026-11-13 the API, the redirect and the local users themselves went (08-permissions).

- **System group always open** (decision changed 2026-11-13). Before: System was a collapsed `details` with a wrench icon and a chevron, open only when clicked or while one of its pages showed.

- **Inline approve confirm, three-button verdict, ID titles, lowercase row buttons** (decision changed 2026-11-13, UI review). Before: on the item page approve in an approve phase showed an inline confirm (Confirm left, Cancel right, focus did not move) and verdict was a severity select with Accept, Changes and Reject buttons sending the note box's text, Accept enabled with no reason; a Needs-you row's verdict dialog was a free-text field whose placeholder was the command usage; dialog titles named the item's ID (`Reject wi_1`); the confirm buttons of non-danger dialogs looked like Cancel; rows listed lowercase command names with the buttons in the Why column, "⋯" before Merge; the dark backdrop was `text` at 50%.

- **Server revision = folder git HEAD** (decision changed 2026-11-13). Before: `server_rev` was `git rev-parse HEAD` of the UI server's code root, so after a docs-only update moved the checkout without a build it differed from the page's built-in revision and the "Dashboard out of date" banner showed with advice that could not clear it.

- **The remaining views kept English inline** (decision changed 2026-11-13). Before: `item-commands.tsx`, `item-decisions.tsx`, `rules.tsx`, `transcript.tsx` and `tree.tsx` held English text and were listed on the baseline of `tests/web-i18n-text.test.ts`; new UI text had no written rule.

- **Sidebar scrolled away, untitled groups, Settings in the top bar, queued items** (decision changed 2026-11-13). Before: the `aside` scrolled with the page on the `surface` colour, as did the page behind it; the Tasks and Factory groups had only `aria-label` names; the System summary had no chevron; Settings was a link in the top bar; Work's summary counted items at level `queued` while the Queue page and `overview.queued` counted queued runs; tree rows indented with an inline `style`.

- **The catalog held the app shell's text only** (decision changed 2026-11-12). Before: `web/src/i18n/en.ts` held the text of the sidebar, top bar, Refresh, theme control and the Needs you heading; the Pages, Settings, Standing approvals, Tasks and Data views kept English inline, listed on the baseline of `tests/web-i18n-text.test.ts`.

- **The responsive check ignored the console** (decision changed 2026-11-12). Before: `check:responsive` looked only at layout; `cdp.mjs` did not enable the Log domain or record console output, so the two console errors per page from the refused favicon (app CSP `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`) never failed it.

- **No automated responsive check** (decision changed 2026-11-10). Before: only the ui-reviewer agent looked at other widths, by hand, at 1280px and 390px wide, and no check ran on a PR, so changes made without a browser (background agents, the factory's own PRs) could break a narrow or short window unnoticed.

- **No improve run from the dashboard** (decision changed 2026-11-10, issue #508). Before: the dashboard had five write routes and no way to start an improve run; the Health panel was read-only and every classic page allowed exactly one script by hash.

- **No users view** (decision changed 2026-11-08, issue #445). Before: the dashboard had no users view and no write route for users; `factory users` (owner only) was the only way to read or change local roles, and nothing showed whether a role came from a local row, a static grant or GitHub.

- **The mode in the top bar and on the Settings page** (decision changed 2026-11-08, issue #444). Before: there was no mode; the top bar showed Needs you, the update time, refresh and the theme switch, and the Settings link was only in the sidebar.

- **Revisions, system actions and the tab title** (decision changed 2026-11-07, issue #311). Before: the overview returned only the supervisor's revision (`factory.rev`), the web build had no revision built in, so a tab or a page server on old code was not shown; `needs_you` counted only human-blocked and deadlocked items; the tab title had no count.

- **Where `/` goes** (changed 2026-11-07). Before: `/` served the server-rendered page and the app was only at `/app/`, with placeholder pages.

- **The dashboard is read-only** (decision changed 2026-11-07, issue #236). Before: the JSON API answered only `GET`/`HEAD` ("Read-only JSON API"), and the Settings page was read-only, pointing at `factory settings`. Now `POST /api/v1/settings` is the one write route and the Settings page edits and resets settable keys.

- **PR link in the API** (decision changed 2026-11-07, issue #240). Before: `pr_url` was built from the stored project key (`github:host:id`), giving a malformed host; now it is built from the stored label, as the classic page already did.

- **A single theme toggle** (decision changed 2026-11-12). Before: one button switched between light and dark, read the stored value or the system preference once at load and stored `light` or `dark`, so a click pinned the page and a change of the system scheme was ignored. The toggle labels were "Switch to dark theme" and "Switch to light theme".

- **Menu names and the Users page** (decision changed 2026-11-11). Before: the sidebar listed Floor, Work items, Workers, Queue, Health, Failures, Settings and Users, then Data in a Tools group; the Floor showed Needs you, Running now, Queue and the last 24 hours on one page; `/app/users` showed the local users with owner controls (issue #445); the shell had no keyboard handling.

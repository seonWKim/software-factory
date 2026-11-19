# 09-health

- **Health's tabs were Sections; Claim pauses a bare list** (until 2026-11-19, the Cards decision at the top). Before: each tab was a `Section` with no surface, and the Claim pauses tab showed its list with no heading.
- **Health checks ran inside the request** (until 2026-11-19, the background snapshot decision at the top). Before: when the last run started 60 s ago or more, a `GET /api/health` or `/api/v1/health` ran the checks (GitHub calls included) and waited for them, so a read took about 4.5 s; a throwing check replaced the last report with one FAIL row. That behaviour remains for a monitor that is not started.
- **A Health section on the server-rendered page** (until 2026-11-16, the API-only decision at the top). Before: `/` (later `/classic`) showed the checks as a Health section with a refresh link (`?health=refresh`, still at most one run a minute) and, for a user who may approve, the Run now button; `HealthMonitor.section` built it, and page loads counted toward the 60 s limit beside the API.

## History

- **Health page on one page** (decision changed 2026-11-15). Before: Checks, Claim pauses, Host sleeps and Merged without review were stacked on one page; the sleep list had one row per worker entry (so one sleep hitting five workers filled five rows); Merged by used `PersonName`, "you" behind a disclosure with the user ID and a Copy button.
- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the first decision was titled "No MySQL check"; the Host sleeps paragraph named a MySQL database without step 0028; the first decision said "had a MySQL check"; the schema probe said MySQL treated a missing `schema_migrations` as version 0 and that the MySQL check was gone.
- **MySQL check** (decision changed 2026-11-11, issue #590). Before: with a MySQL store, doctor read `schemaVersion()` and printed "MySQL <user>@<host>:<port>/<db> reachable, schema up to date" (or behind: FAIL with `npm run migrate`; unreachable: FAIL with the connection fix from `storeErrorCheck`).
- **App token expiry** (decision changed 2026-11-08, issue #434). Before: an App token's expiry came from its mint response and went through the same day thresholds, so the hour-long expiry failed on every App factory and told the owner to run the rotate command.

- **Thresholds** (decision changed 2026-11-07, issue #311). Before: the token check warned only above 30 days (rounded to the nearest day), so a token expiring in 2 days showed ok; a schema behind the code was a warn, "schema at version X of Y (the factory migrates it when it starts)".
- **Claim pauses on the Health page** (new decision, 2026-11-07, issue #291). Before: the Health page showed only the checks, so a timed pause (`rate_limit`, `forge_auth`, `preflight_access`) was not visible and could not be ended from the app.
- **Read-only schema probe** (decision changed, 2026-11-01). Before: doctor's MySQL check ran `store.migrate()`, so doctor, and `setup` through it, created or upgraded the schema.

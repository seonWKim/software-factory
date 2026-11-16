# 09-health

- **A Health section on the server-rendered page** (until 2026-11-16, the API-only decision at the top). Before: `/` (later `/classic`) showed the checks as a Health section with a refresh link (`?health=refresh`, still at most one run a minute) and, for a user who may approve, the Run now button; `HealthMonitor.section` built it, and page loads counted toward the 60 s limit beside the API.

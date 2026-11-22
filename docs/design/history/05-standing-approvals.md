## History

- **Last fired replaces last used** (decision changed 2026-11-21, wi_1cf90455). Before: each rule showed "last
  used", always null and shown as "not recorded". After: `last_fired_at` and `recent` (items of the last 7 days) come
  from the stored `standing_approved` state changes.
- **A rule acts at the spec gate** (decision changed 2026-11-07, issue #299). Before: spec decisions were recorded and
  checked and nothing acted on them; no command accepted or declined a rule, no proposal was posted, and
  `standing_approvals.threshold` was named as a config key to be wired later.
- **The page shows and changes rules** (decision changed 2026-11-08, issue #300). Before: phase 3 was named as a
  separate item; rules and proposals were shown and changed only through `/standing`, and the status page had no route
  for them.
- **Guard code on the protected list** (changed 2026-11-09, runtime review H3). Before: only `src/identity/settings/` of identity was listed, and `src/compose.ts` (G1, the passport broker wrapper), `src/outbound/outbound.ts` (G5, the delivery passport) and the default broker files under `src/impl/github/` were not, so auto mode could merge an agent change to them with no person.
- **MySQL text removed from the current decisions** (decision changed 2026-11-11, issue #567). Before: the store methods were "implemented once in the shared SQL store for SQLite and MySQL" and the schema was "SQLite migration 32 and MySQL step `0032-standing-approvals.sql`, same tables and columns".

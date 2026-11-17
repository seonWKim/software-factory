## History

- **Three classes, the inbox cleanup on its own** (decision 2026-11-11, issue #462; replaced 2026-11-16). Before: the daily pass deleted delivered `outbound_intents`, handled `inbound_commands` and claim decisions, host sleeps and alerts (the store's `pruneRecords`); `authz_audit`, the outbound action and batch tables, passports and revocations, claim pauses and the controller inbox were never pruned, every owner-check decision was audited, raw records were kept `inbox_retention_days` (default 14), and the schema had no change for retention.
- **Current text names SQLite only** (decision changed 2026-11-11, issue #567). Before: the Three classes decision said solo and enterprise got the same defaults and that the MySQL store ran the same SQL code as SQLite.

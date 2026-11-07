-- One sync per project and a shared forge budget (design 05-coordination, sync lease; 05-sources, call budget): the
-- same tables and column as SQLite migration 38. `sync_leases`: the lease `sync:<type>:<project>` whose holder polls a
-- sync source and delivers its outbox, like `listener_leases` but keyed by name. `forge_budget`: the forge's rate
-- limit per (project_key, plugin); a write with a newer `updated_at` wins. `item_thread.actor`: the account ID of a
-- message that came from a source, NULL otherwise.
-- Safe to rerun after a failure midway: each table is created only when missing, and the one ALTER comes last.

CREATE TABLE IF NOT EXISTS sync_leases (
  name        VARCHAR(255) NOT NULL PRIMARY KEY,
  owner       VARCHAR(255) NOT NULL,
  token       BIGINT NOT NULL,
  expires_at  CHAR(24) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS forge_budget (
  project_key VARCHAR(255) NOT NULL,
  plugin      VARCHAR(64) NOT NULL,
  remaining   INT NOT NULL,
  `limit`     INT NOT NULL,
  reset_at    CHAR(24) NOT NULL,
  updated_at  CHAR(24) NOT NULL,
  PRIMARY KEY (project_key, plugin)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
ALTER TABLE item_thread ADD COLUMN actor VARCHAR(128) NULL;

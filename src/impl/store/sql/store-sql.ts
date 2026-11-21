// The store's SQL database, for a component that owns its own tables (RFC 0015 §6.3, e.g. Identity's
// identity_profiles) while the legacy FactoryStore still opens the connection. Goes when the runtime hands
// components their driver.
//
// The SQL store marks itself with SQL_DRIVER, so reading the driver does not load the store class: a component that
// needs only its tables (the worker's journal, hook audit and pack grants) stays off the whole SQL store (RFC 0023 R1).

import type { FactoryStore } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";

/** The key under which a SQL-backed FactoryStore exposes its driver. */
export const SQL_DRIVER: unique symbol = Symbol.for("software-factory.sql-driver");

/** The store's driver, or null when the selected store plugin is not a SQL store. */
export function storeSqlOrNull(store: FactoryStore): SqlDriver | null {
  // An object only: a stand-in store (a Proxy that answers every key with a function) is not a SQL store.
  const db: unknown = (store as { [SQL_DRIVER]?: unknown })[SQL_DRIVER];
  return typeof db === "object" && db !== null ? (db as SqlDriver) : null;
}

export function storeSql(store: FactoryStore): SqlDriver {
  const db = storeSqlOrNull(store);
  if (db) return db;
  throw new Error("the selected store plugin is not a SQL store");
}

// The store's SQL database, for a component that owns its own tables (RFC 0015 §6.3, e.g. Identity's
// identity_profiles) while the legacy FactoryStore still opens the connection. Goes when the runtime hands
// components their driver.

import type { FactoryStore } from "../../../interfaces/factory-store.js";
import type { SqlDriver } from "../../../state/index.js";
import { SqlFactoryStore } from "./sql-factory-store.js";

export function storeSql(store: FactoryStore): SqlDriver {
  if (store instanceof SqlFactoryStore) return store.db;
  throw new Error("the selected store plugin is not a SQL store");
}

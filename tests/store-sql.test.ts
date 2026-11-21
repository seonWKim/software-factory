import { describe, expect, it } from "vitest";
import { storeSql, storeSqlOrNull } from "../src/impl/store/sql/store-sql.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { newStore } from "./helpers/store.js";

// storeSql reads the driver the SQL store marks with a key, without importing the store class (RFC 0023 R1).
describe("storeSql", () => {
  it("returns the SQL store's driver", async () => {
    const { store } = await newStore();
    expect(storeSqlOrNull(store)).toBe(storeSql(store));
    expect(storeSqlOrNull(store)).not.toBeNull();
  });

  it("refuses a stand-in store that answers every key with a function", () => {
    // The shape of the store a plugin set builds when no store plugin can be used: any key gives a rejecting function.
    const standIn = new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : () => Promise.reject(new Error("no store"))) }) as FactoryStore;
    expect(storeSqlOrNull(standIn)).toBeNull();
    expect(() => storeSql(standIn)).toThrow("not a SQL store");
  });
});

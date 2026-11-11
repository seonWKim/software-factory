import { describe, expect, it } from "vitest";
import type { UserId } from "../../src/core/types.js";
import { newStore } from "../helpers/store.js";

// Inbound relays `inbound_commands` through a seq cursor (`seq > cursor`). Every writer takes the `commands` lock row
// first, so their inserts commit in seq order.

const command = (key: string) => ({ key, actor: "local:owner", command: "approve", args: {} });

describe("inbound_commands sequence", () => {
  it("every writer takes the commands lock row (SQLite: the row the migration seeds)", async () => {
    const { store } = await newStore();
    await store.appendCliCommand(command("k1"));
    await store.db.run("DELETE FROM inbound_sequence_locks");
    await expect(store.appendCliCommand(command("k2"))).rejects.toThrow("inbound_sequence_locks has no commands row");
    await expect(store.recordAppCommandRequest({ key: "app:1", actor: "local:u" as UserId, command: "approve", args: {} })).rejects.toThrow(
      "inbound_sequence_locks has no commands row",
    );
  });
});

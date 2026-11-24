import { describe, expect, it } from "vitest";
import { buildLocalCliDeps } from "../src/cli/handlers/local/deps.js";
import type { Loaded } from "../src/load-config.js";
import { newStore } from "./helpers/store.js";

describe("buildLocalCliDeps", () => {
  it("builds the runLocalCli dependencies with their keys", async () => {
    const { store } = await newStore();
    const loaded = { config: { repo: { owner: "o", name: "n" }, settings: [] }, file: {} } as unknown as Loaded;
    const identity = { user: "local:me", from: "OS user" } as never;
    const d = await buildLocalCliDeps(store, loaded, identity, "factory", { action: "show", id: "wi_x" } as never);
    expect(Object.keys(d)).toEqual(expect.arrayContaining(["store", "identity", "project", "read", "newId", "cli", "ui", "answers", "caps"]));
    expect(d.cli).toBe("factory");
    expect(d.ui).toEqual({});
    expect(d.newId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});

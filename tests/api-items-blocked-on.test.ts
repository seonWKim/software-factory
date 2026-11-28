// items.list's optional blocked_on filter (design 04-chat-agent, call_feature): the chat gets the items blocked on the
// owner in one call. Through respond(), the server's whole request handling, and through the registry in-process.

import { describe, expect, it } from "vitest";
import { registryOf } from "../src/api/index.js";
import { callCapability } from "../src/api/registry.js";
import { Withholder } from "../src/ui/withhold.js";
import { get, json, seeded } from "./ui-api-fixtures.js";

type Row = { id: string; blocked_on: string | null };

describe("items.list blocked_on", () => {
  it("lists only the items whose blocked_on is the given value", async () => {
    const { d, items } = await seeded();
    const all = await json<{ items: Row[] }>(d, "/api/v1/items");
    const human = await json<{ items: Row[]; total: number }>(d, "/api/v1/items?blocked_on=human");
    expect(all.items.some((r) => r.blocked_on !== "human")).toBe(true);
    expect(human.items.length).toBeGreaterThan(0);
    expect(human.items.every((r) => r.blocked_on === "human")).toBe(true);
    expect(human.total).toBe(human.items.length);
    // Every owner-blocked row of the unfiltered list is kept, in the same order.
    expect(human.items.map((r) => r.id)).toEqual(all.items.filter((r) => r.blocked_on === "human").map((r) => r.id));
    expect(human.items.map((r) => r.id)).toContain(items.approve.id);
    expect(human.items.map((r) => r.id)).not.toContain(items.running.id);
  });

  it("absent or empty, it does not filter", async () => {
    const { d } = await seeded();
    const all = await json<{ items: Row[] }>(d, "/api/v1/items");
    const empty = await json<{ items: Row[] }>(d, "/api/v1/items?blocked_on=");
    expect(empty.items.map((r) => r.id)).toEqual(all.items.map((r) => r.id));
  });

  it("an unknown value answers 400", async () => {
    const { d } = await seeded();
    const r = await get(d, "/api/v1/items?blocked_on=martians");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ error: "Unknown blocked_on." });
  });

  it("the registry's in-process call takes it as the chat sends it", async () => {
    const { d } = await seeded();
    const r = await callCapability(registryOf(d), d, "items.list", { blocked_on: "human" }, new Withholder(d.scanner));
    expect(r.status).toBe(200);
    const rows = (r.value as { items: Row[] }).items;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.blocked_on === "human")).toBe(true);
  });
});

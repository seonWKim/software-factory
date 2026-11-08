import { describe, expect, it } from "vitest";
import { ProfileStore } from "../src/identity/index.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";
import { issue, newStore, system } from "./helpers/store.js";

// M9: where the status page shows a user id, it shows the display name from identity_profiles beside it, read by
// id. The stored ids are unchanged, and a user with no name is shown by id alone.

async function setup(named: boolean) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const { item } = await store.createWorkItem(issue(1), system);
  const profiles = new ProfileStore(store.db);
  if (named) await profiles.set(system.id, "Test Robot", "local", clock.now().toISOString());
  const d: UiDeps = {
    store,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 60_000,
    health: new HealthMonitor(async () => [], clock),
    displayNames: (ids) => profiles.displayNames(ids),
  };
  const get = (url: string) => respond(d, { method: "GET", url, host: "127.0.0.1:4310" });
  return { item, get };
}

describe("display names on the status page", () => {
  it("shows the name beside the id on the item page and in the item API", async () => {
    const { item, get } = await setup(true);
    expect((await get(`/items/${item.id}`)).body).toContain(`Test Robot (${system.id})`);
    const api = JSON.parse((await get(`/api/v1/items/${item.id}`)).body) as { timeline: { actor: unknown }[] };
    expect(api.timeline[0]!.actor).toEqual({ kind: "system", id: system.id, name: "Test Robot" });
  });

  it("shows the id alone for a user with no name", async () => {
    const { item, get } = await setup(false);
    expect((await get(`/items/${item.id}`)).body).not.toContain("(system:");
    const api = JSON.parse((await get(`/api/v1/items/${item.id}`)).body) as { timeline: { actor: unknown }[] };
    expect(api.timeline[0]!.actor).toEqual({ kind: "system", id: system.id, name: null });
  });
});

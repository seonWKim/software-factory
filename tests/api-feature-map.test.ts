// The feature map (design 09-api-registry): GET /api/v1/feature-map/areas, /capabilities and /capabilities/<id>
// answer from the registry's declarations, through the request shell, with no list kept by hand.

import { describe, expect, it } from "vitest";
import { buildRegistry, declare } from "../src/api/registry.js";
import { boolean, nullable, object, string } from "../src/api/schema.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { respond } from "../src/ui/server.js";
import { newStore } from "./helpers/store.js";

const fixture = (id: string, area: string, method: "GET" | "POST") =>
  declare({
    id, area, description: `The ${id} fixture.`, permission: method === "GET" ? "read" : "owner", method, path: `/api/v1/fixture-map/${id}`,
    input: object({ name: string() }), output: object({ found: boolean(), note: nullable(string()) }),
    run: () => ({ found: true, note: null }),
  });

const REGISTRY = buildRegistry([fixture("beta.write", "beta", "POST"), fixture("alpha.read", "alpha", "GET"), fixture("alpha.list", "alpha", "GET")]);

async function get(url: string) {
  const clock = new FakeClock("2026-11-26T12:00:00.000Z");
  const { store } = await newStore(clock);
  const d = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), api_registry: REGISTRY };
  const r = await respond(d, { method: "GET", url, host: "127.0.0.1:4310" });
  return { status: r.status, value: JSON.parse(r.body) };
}

describe("the feature map", () => {
  it("lists the areas, each with its capability ids, sorted", async () => {
    expect(await get("/api/v1/feature-map/areas")).toEqual({
      status: 200,
      value: { areas: [{ id: "alpha", capabilities: ["alpha.list", "alpha.read"] }, { id: "beta", capabilities: ["beta.write"] }] },
    });
  });

  it("lists the capabilities with their area, description, permission, method and path", async () => {
    const r = await get("/api/v1/feature-map/capabilities");
    expect(r.status).toBe(200);
    expect(r.value.capabilities).toContainEqual({ id: "beta.write", area: "beta", description: "The beta.write fixture.", permission: "owner", method: "POST", path: "/api/v1/fixture-map/beta.write" });
    expect(r.value.capabilities.map((c: { id: string }) => c.id)).toEqual(["alpha.list", "alpha.read", "beta.write"]);
  });

  it("gives one capability with its input and output schemas; an unknown id or path is a 404", async () => {
    const r = await get("/api/v1/feature-map/capabilities/alpha.read");
    expect(r).toMatchObject({ status: 200, value: { capability: { id: "alpha.read", method: "GET" } } });
    expect(r.value.capability.input).toEqual({ type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false });
    expect(r.value.capability.output.properties.note).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(await get("/api/v1/feature-map/capabilities/nope.none")).toEqual({ status: 404, value: { error: "No such capability." } });
    expect(await get("/api/v1/feature-map/capabilities/%E0")).toEqual({ status: 404, value: { error: "No such capability." } });
    expect((await get("/api/v1/feature-map/other")).status).toBe(404);
  });
});

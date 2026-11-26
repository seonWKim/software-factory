// The OpenAPI document (design 09-api-registry): docs/api/openapi.json is what `npm run gen:api` writes from the
// declarations, so a schema changed without regenerating fails here; and the items output schema (owner answer 3)
// types its top-level fields and types nested objects as JSON objects.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REGISTRY } from "../src/api/index.js";
import { buildRegistry, declare, openApiText } from "../src/api/registry.js";
import { integer, object, string } from "../src/api/schema.js";
import { ITEMS_OUTPUT, ITEM_ROW } from "../src/api/schemas/items.js";

const OPENAPI = join(import.meta.dirname, "..", "docs", "api", "openapi.json");

const echo = (output: ReturnType<typeof object>) =>
  buildRegistry([declare({ id: "fixture.echo", area: "fixture", description: "Echo.", permission: "read", method: "GET", path: "/api/v1/fixture/echo", input: object({}), output, run: () => ({}) })]);

describe("docs/api/openapi.json", () => {
  it("is the document of the declared capabilities (npm run gen:api)", () => {
    expect(readFileSync(OPENAPI, "utf8")).toBe(openApiText(REGISTRY));
  });

  it("goes stale when a capability's schema changes: the regenerated document differs", () => {
    const checkedIn = openApiText(echo(object({ note: string() })));
    expect(openApiText(echo(object({ note: integer() })))).not.toBe(checkedIn);
    expect(openApiText(echo(object({ note: string(), more: string() })))).not.toBe(checkedIn);
    expect(openApiText(echo(object({ note: string() })))).toBe(checkedIn);
  });
});

describe("the items output schema", () => {
  const props = (s: { json(): Record<string, unknown> }) => s.json().properties as Record<string, Record<string, unknown>>;

  it("types the answer's top-level fields, and the list's rows", () => {
    const top = props(ITEMS_OUTPUT);
    expect(top.as_of).toEqual({ type: "string" });
    expect(top.total).toEqual({ type: "integer" });
    expect(top.items).toEqual({ type: "array", items: ITEM_ROW.json() });
    const row = props(ITEM_ROW);
    expect(row.id).toEqual({ type: "string" });
    expect(row.version).toEqual({ type: "integer" });
    expect(row.title).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
    expect(ITEM_ROW.json().required).toEqual(expect.arrayContaining(["id", "title", "stage", "updated_at", "why"]));
    expect(ITEM_ROW.json().required).not.toContain("need");
  });

  it("types nested objects as JSON objects", () => {
    const top = props(ITEMS_OUTPUT), row = props(ITEM_ROW);
    for (const nested of [top.facets, top.counts, row.source, row.why, row.conflicts]) expect(nested).toEqual({ type: "object" });
    for (const nested of [row.issue, row.merge_check, row.run, row.claim]) expect(nested).toEqual({ anyOf: [{ type: "object" }, { type: "null" }] });
  });
});

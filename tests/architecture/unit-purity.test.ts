import { basename, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { UNIT_FILE, type UnitDescriptor } from "../../src/controller/router/unit.js";
import { findDescriptorFiles } from "../../src/state/index.js";
import { SRC, codeOnly, importsOf, ratchet, read } from "./lib.js";

// RFC 0015 §9 unit-purity: a controller unit decides; it does no I/O. A unit fails when it imports I/O (node's
// fs, net, http or child_process, a state or bus implementation, a plugin) or reaches an I/O dependency through
// the kernel (the store, an auth plugin, the forge, a source adapter, the sandbox, the LLM, the network probe, the restart
// list).
//
// M5 moved the legacy controller into units as it was: their decisions still read and write inline. Each such
// unit is listed in known-violations/unit-purity.json with what it reaches; the list shrinks as units get their
// pure load/decide split (the router runs `load`, the unit returns a decision, the router commits it).

const IO_IMPORT = /^node:(?:fs|net|http|https|child_process)(?:\/|$)|\/(?:state|bus)\/(?!index\.js$)|\/plugins\/|\/impl\//;
const IO_REACH: readonly [string, RegExp][] = [
  ["store", /\.d\.store\b/],
  ["auth", /\.d\.(?:auth|local_auth|service_auth)\b/],
  ["forge", /\.k\.forge\b|\.d\.forge\b/],
  ["sources", /\.k\.(?:sources|byType|adapterFor)\b/],
  ["sandbox", /\.d\.sandbox\b/],
  ["llm", /\.d\.llm\b/],
  ["network", /\.d\.network_probe\b/],
  ["restarts", /\.d\.restarts\b/],
];

function unitFiles(): string[] {
  return findDescriptorFiles(SRC, UNIT_FILE).map((f) => f.slice(SRC.length + 1));
}

function violations(): string[] {
  const out: string[] = [];
  for (const file of unitFiles()) {
    const text = read(file);
    for (const spec of importsOf(text)) if (IO_IMPORT.test(spec)) out.push(`imports-io|${file}|${spec}`);
    const code = codeOnly(text);
    for (const [what, re] of IO_REACH) if (re.test(code)) out.push(`reaches-io|${file}|${what}`);
  }
  return out;
}

describe("unit-purity", () => {
  it("no new I/O in a controller unit (ratchet)", () => {
    ratchet("unit-purity", violations());
  });

  it("catches an I/O import and a store reached through the kernel", () => {
    expect(IO_IMPORT.test("node:fs")).toBe(true);
    expect(IO_IMPORT.test("../../../impl/store/sql/sql-factory-store.js")).toBe(true);
    expect(IO_IMPORT.test("../../router/unit.js")).toBe(false);
    expect(IO_REACH.find(([w]) => w === "store")![1].test("await this.c.k.d.store.getWorkItem(id)")).toBe(true);
  });
});

describe("unit layout", () => {
  it("each unit is src/controller/units/<name>/<name>.unit.ts, named after its folder, and an event kind has one unit", async () => {
    const kinds = new Map<string, string[]>();
    const bad: string[] = [];
    for (const rel of unitFiles()) {
      const d = ((await import(pathToFileURL(`${SRC}/${rel}`).href)) as { default: UnitDescriptor }).default;
      const folder = basename(dirname(rel));
      if (!/^controller\/units\/[a-z0-9-]+\/[a-z0-9-]+\.unit\.ts$/.test(rel) || basename(rel, ".unit.ts") !== folder || d.name !== folder) {
        bad.push(rel);
      }
      for (const k of Object.keys(d.events ?? {})) kinds.set(k, [...(kinds.get(k) ?? []), d.name]);
    }
    expect(bad).toEqual([]);
    expect([...kinds].filter(([, us]) => us.length > 1)).toEqual([]);
    expect(kinds.size).toBeGreaterThan(0);
  });
});

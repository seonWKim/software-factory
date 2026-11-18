import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ratchet, ratchetCounts } from "./lib.js";

// Shrink mode (design 04-pre-push-gates, pre-push checks): SF_RATCHET_SHRINK=1 lowers a known-violations list to what
// the code really has, and only lowers it. Each test works on its own list in a temporary folder.

const SHRINK = { SF_RATCHET_SHRINK: "1" };

function list(value: unknown): { dir: string; read: () => unknown; text: () => string } {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-shrink-"));
  const file = join(dir, "rule.json");
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
  return { dir, read: () => JSON.parse(readFileSync(file, "utf8")), text: () => readFileSync(file, "utf8") };
}

/** What the failing ratchet compared: its assertion's actual value. Fails the test when the ratchet passed. */
function drift(check: () => void): unknown {
  try {
    check();
  } catch (err) {
    return (err as { actual?: unknown }).actual;
  }
  throw new Error("the ratchet passed");
}

describe("ratchetCounts in shrink mode", () => {
  it("lowers a fallen count to the real count, removes one that fell to 0, and passes", () => {
    const l = list({ "a.ts": 10, "b.ts": 4, "c.ts": 2 });
    ratchetCounts("rule", { "a.ts": 7, "b.ts": 4 }, { dir: l.dir, env: SHRINK });
    expect(l.read()).toEqual({ "a.ts": 7, "b.ts": 4 });
    expect(Object.keys(l.read() as object)).toEqual(["a.ts", "b.ts"]);
  });

  it("never raises a value and never adds a key: a grown count still fails as grew", () => {
    const l = list({ "a.ts": 10, "b.ts": 4 });
    expect(drift(() => ratchetCounts("rule", { "a.ts": 11, "b.ts": 3, "new.ts": 1 }, { dir: l.dir, env: SHRINK }))).toEqual({
      grew: ["a.ts: 10 → 11", "new.ts: 0 → 1"], fell_but_list_not_lowered: [],
    });
    // b.ts fell and is lowered; a.ts is not raised and new.ts is not added.
    expect(l.read()).toEqual({ "a.ts": 10, "b.ts": 3 });
  });

  it("leaves the file as it is when nothing fell", () => {
    const l = list({ "a.ts": 10 });
    const before = l.text();
    ratchetCounts("rule", { "a.ts": 10 }, { dir: l.dir, env: SHRINK });
    expect(l.text()).toBe(before);
  });

  it("without SF_RATCHET_SHRINK=1 a fall still fails with fell_but_list_not_lowered and the list stays", () => {
    const l = list({ "a.ts": 10 });
    expect(drift(() => ratchetCounts("rule", { "a.ts": 7 }, { dir: l.dir, env: {} }))).toEqual({ grew: [], fell_but_list_not_lowered: ["a.ts: 10 → 7"] });
    expect(l.read()).toEqual({ "a.ts": 10 });
  });
});

describe("ratchet (name list) in shrink mode", () => {
  it("removes a name no longer found and changes nothing else in the list", () => {
    const l = list(["x -> y", "a -> b", "m -> n"]);
    ratchet("rule", ["x -> y", "m -> n"], { dir: l.dir, env: SHRINK });
    expect(l.read()).toEqual(["x -> y", "m -> n"]);
  });

  it("never adds a name: a new violation still fails and is not listed", () => {
    const l = list(["a -> b", "c -> d"]);
    expect(drift(() => ratchet("rule", ["c -> d", "new -> one"], { dir: l.dir, env: SHRINK }))).toEqual({ new_violations: ["new -> one"], fixed_but_still_listed: [] });
    expect(l.read()).toEqual(["c -> d"]);
  });

  it("without SF_RATCHET_SHRINK=1 a fixed name still fails as fixed_but_still_listed", () => {
    const l = list(["a -> b", "c -> d"]);
    expect(drift(() => ratchet("rule", ["c -> d"], { dir: l.dir, env: {} }))).toEqual({ new_violations: [], fixed_but_still_listed: ["a -> b"] });
    expect(l.read()).toEqual(["a -> b", "c -> d"]);
  });
});

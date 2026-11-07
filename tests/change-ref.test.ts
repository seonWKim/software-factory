import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prNumber } from "../src/core/change-ref.js";

const CORE = join(import.meta.dirname, "..", "src", "core");

describe("change_ref in the core (design 02)", () => {
  it("prNumber converts change_ref to the forge's PR number, null without one", () => {
    expect(prNumber({ change_ref: "42" })).toBe(42);
    expect(prNumber({ change_ref: null })).toBeNull();
    expect(prNumber({ change_ref: "MR-7" })).toBeNull();
    expect(prNumber({ change_ref: "" })).toBeNull();
  });

  it("no file under src/core reads a work item's pr_number field", () => {
    // The work item variable names the core uses; events, outcomes and forge inputs keep their own pr_number.
    const itemRead = /\b(?:it|item|cur|next|current|known|original|existing)\.pr_number\b/;
    const hits = readdirSync(CORE, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .flatMap((e) => readFileSync(join(e.parentPath, e.name), "utf8").split("\n").map((l, i) => [`${e.name}:${i + 1}`, l] as const))
      .filter(([, line]) => itemRead.test(line))
      .map(([at]) => at);
    expect(hits).toEqual([]);
  });
});

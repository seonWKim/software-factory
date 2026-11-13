import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type RetireRule, repoPaths, retireSuggestions } from "../src/core/rule-retirement.js";

// Retire suggestions for the Applied group: three signals from data the page already reads (the rules file's blocks,
// the class's incident count from evolve show, the other applied rules and the repo's paths), no model call.

const NOW = new Date("2026-11-14T09:00:00Z");
const RULE: RetireRule = { id: "C-001", default: "Open every summary with one line.", incidents: ["T-1", "T-2"], judged: "2026-10-01" };
const all = (o: { applied?: RetireRule[]; incidents?: number; exists?: (p: string) => boolean } = {}) => ({
  applied: o.applied ?? [RULE],
  ...(o.incidents !== undefined ? { incidents: o.incidents } : {}),
  exists: o.exists ?? (() => true),
  now: NOW,
});

describe("stale", () => {
  it("fires when judged at least 30 days ago and the class has no incident beyond its 근거 line", () => {
    expect(retireSuggestions(RULE, all({ incidents: 2 }))).toEqual(["no new incident for 44 days since judged on 2026-10-01"]);
    expect(retireSuggestions({ ...RULE, judged: "2026-10-15" }, all({ incidents: 2 }))).toEqual(["no new incident for 30 days since judged on 2026-10-15"]);
  });

  it("does not fire: a new incident, judged under 30 days ago, no judged date, or no count read", () => {
    expect(retireSuggestions(RULE, all({ incidents: 3 }))).toEqual([]);
    expect(retireSuggestions({ ...RULE, judged: "2026-10-16" }, all({ incidents: 2 }))).toEqual([]);
    const { judged: _, ...noDate } = RULE;
    expect(retireSuggestions(noDate, all({ incidents: 2 }))).toEqual([]);
    expect(retireSuggestions(RULE, all())).toEqual([]);
  });
});

describe("duplicate", () => {
  const wide: RetireRule = { id: "C-002", default: "Always  OPEN every summary with one line. Then the detail." };
  it("fires when another applied rule's default, normalized, equals or contains this one's", () => {
    expect(retireSuggestions(RULE, all({ applied: [RULE, wide] }))).toEqual(["covered by C-002"]);
    const same: RetireRule = { id: "C-003", default: "open every   summary with ONE line." };
    expect(retireSuggestions(RULE, all({ applied: [RULE, same] }))).toEqual(["covered by C-003"]);
    expect(retireSuggestions(same, all({ applied: [RULE, same] }))).toEqual(["covered by C-001"]);
  });

  it("does not fire: the other rule is narrower, unrelated, or the shorter text is under 20 characters", () => {
    expect(retireSuggestions(wide, all({ applied: [RULE, wide] }))).toEqual([]);
    expect(retireSuggestions(RULE, all({ applied: [RULE, { id: "C-004", default: "Keep every CLI flag." }] }))).toEqual([]);
    const short: RetireRule = { id: "C-005", default: "Be brief." };
    expect(retireSuggestions(short, all({ applied: [short, { id: "C-006", default: "Be brief. Always." }] }))).toEqual([]);
  });
});

describe("gone from the repo", () => {
  const named: RetireRule = { id: "C-007", default: "Keep `src/impl/old-store.ts` small.", exceptions: "when docs/old.md says so", scope: "web/src/views/, README.md, lib/x.ts" };
  it("fires for each path under src/, web/, docs/, prompts/, tests/ or scripts/ the checkout lacks", () => {
    const exists = (p: string) => p === "web/src/views";
    expect(retireSuggestions(named, all({ applied: [named], exists }))).toEqual([
      "names src/impl/old-store.ts, which this repo does not have",
      "names docs/old.md, which this repo does not have",
    ]);
  });

  it("does not fire when each named path exists, or for a path outside those folders", () => {
    const asked: string[] = [];
    expect(retireSuggestions(named, all({ applied: [named], exists: (p) => (asked.push(p), true) }))).toEqual([]);
    expect(asked).toEqual(["src/impl/old-store.ts", "docs/old.md", "web/src/views"]);
    expect(repoPaths("mysrc/x and ./lib/src/y and README.md")).toEqual([]);
  });
});

it("meets several signals: one reason each, stale first", () => {
  const r: RetireRule = { ...RULE, scope: "scripts/gone.sh" };
  const other: RetireRule = { id: "C-009", default: "Open every summary with one line." };
  expect(retireSuggestions(r, all({ applied: [r, other], incidents: 1, exists: () => false }))).toEqual([
    "no new incident for 44 days since judged on 2026-10-01",
    "covered by C-009",
    "names scripts/gone.sh, which this repo does not have",
  ]);
});

it("makes no model call: the module imports nothing", () => {
  const src = readFileSync(new URL("../src/core/rule-retirement.ts", import.meta.url), "utf8");
  expect(src).not.toMatch(/^\s*import\b/m);
  expect(src).not.toMatch(/LLMProvider|fetch\(/);
});

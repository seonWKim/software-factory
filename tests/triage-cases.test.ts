import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIAGE_CHECK_KINDS, loadTriageCases } from "../src/controller/golden-gate/triage-replay.js";
import { goldenCasesByRole } from "../src/runtime/index.js";
import triageRole from "../src/worker/roles/triage.role.js";
import { REPO } from "./architecture/lib.js";

const ROLES = join(REPO, "src", "worker", "roles");
const ids = () => [...(goldenCasesByRole(ROLES).get("triage") ?? [])];

describe("committed triage golden cases", () => {
  it("has at least six cases and the role's minimum matches", () => {
    expect(ids().length).toBeGreaterThanOrEqual(6);
    expect(triageRole.golden?.min_cases).toBeGreaterThanOrEqual(6);
    expect(ids().length).toBeGreaterThanOrEqual(triageRole.golden?.min_cases ?? 0);
  });

  it("parses every case, each with an intake, should_pass and the triage prompt", () => {
    const cases = loadTriageCases(ROLES);
    expect(cases.size).toBe(ids().length);
    for (const id of ids()) {
      const dir = join(ROLES, "triage", "golden", id);
      const meta = JSON.parse(readFileSync(join(dir, "case.json"), "utf8")) as { expect: string; uses: string[] };
      expect(meta.expect).toBe("should_pass");
      expect(meta.uses).toEqual(["prompt:triage.md"]);
      expect(readFileSync(join(dir, "instruction.md"), "utf8").trim()).not.toBe("");
    }
  });

  it("uses all five check kinds across the cases", () => {
    const used = new Set([...loadTriageCases(ROLES).values()].flatMap((c) => c.checks.map((k) => k.kind)));
    for (const kind of TRIAGE_CHECK_KINDS) expect(used.has(kind)).toBe(true);
  });

  it("no longer lists triage as short of cases, and keeps resolve", () => {
    const list = JSON.parse(readFileSync(join(REPO, "tests/architecture/known-violations/rule-of-two.json"), "utf8")) as string[];
    expect(list).not.toContain("golden-cases-missing|worker/roles/triage.role.ts|triage");
    expect(list).toContain("golden-cases-missing|worker/roles/resolve.role.ts|resolve");
  });
});

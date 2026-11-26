import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as barrel from "../src/core/types.js";
import type { BudgetCheckpoint, ClaimDecision, ImproveReport, Run, RunOutcome, StandingRule, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import type { BudgetCheckpoint as CoordBudget, ClaimDecision as CoordClaim } from "../src/core/types/coordination.js";
import type { Timestamp as IdTimestamp, WorkItemId as IdWorkItemId } from "../src/core/types/ids.js";
import type { ImproveReport as ImpReport, StandingRule as ImpRule } from "../src/core/types/improve.js";
import * as runs from "../src/core/types/runs.js";
import * as workItem from "../src/core/types/work-item.js";

// src/core/types.ts is a barrel over src/core/types/, one file per domain (issue #857), so items that touch
// different domains stop conflicting on one file. Callers keep importing from src/core/types.ts.

const CORE = join(import.meta.dirname, "..", "src", "core");
const DOMAIN_FILES = ["ids", "work-item", "runs", "improve", "coordination"];

describe("src/core/types.ts barrel", () => {
  it("holds only re-export lines that point into src/core/types/", () => {
    const lines = readFileSync(join(CORE, "types.ts"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^export (?:type )?(?:\*|\{[^}]*\}) from "\.\/types\/[a-z-]+\.js";$/);
  });

  it("re-exports every domain file, each of which exists", () => {
    const text = readFileSync(join(CORE, "types.ts"), "utf8");
    for (const f of DOMAIN_FILES) {
      expect(existsSync(join(CORE, "types", `${f}.ts`))).toBe(true);
      expect(text).toContain(`"./types/${f}.js"`);
    }
  });

  it("keeps the runtime exports with the same values and behaviour", () => {
    expect(barrel.RECURRING_FAILURE).toBe("recurring_failure");
    expect(barrel.RECURRING_FAILURE).toBe(workItem.RECURRING_FAILURE);
    expect(barrel.usageTokens).toBe(runs.usageTokens);
    expect(barrel.outcomeTokens).toBe(runs.outcomeTokens);
    expect(barrel.runTokenCount).toBe(runs.runTokenCount);
    expect(barrel.outcomeCost).toBe(runs.outcomeCost);
    const usage = { input_tokens: 1, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, cost_usd: 0.5, model: null };
    const failed: RunOutcome = { status: "failed", error_code: "x", detail: "", infra: false, usage };
    expect(barrel.usageTokens(usage)).toBe(10);
    expect(barrel.outcomeTokens(failed)).toBe(10);
    expect(barrel.outcomeTokens({ status: "succeeded", summary: "", data: { tokens: 7 } })).toBe(7);
    expect(barrel.runTokenCount({ kind: "interactive", outcome: null, session_tokens: 5 })).toBe(5);
    expect(barrel.outcomeCost(failed)).toBe(0.5);
    expect(barrel.outcomeCost(null)).toBeNull();
  });

  it("re-exports the domain types with the same shape", () => {
    expectTypeOf<WorkItemId>().toEqualTypeOf<IdWorkItemId>();
    expectTypeOf<Timestamp>().toEqualTypeOf<IdTimestamp>();
    expectTypeOf<WorkItem>().toEqualTypeOf<workItem.WorkItem>();
    expectTypeOf<Run>().toEqualTypeOf<runs.Run>();
    expectTypeOf<ImproveReport>().toEqualTypeOf<ImpReport>();
    expectTypeOf<StandingRule>().toEqualTypeOf<ImpRule>();
    expectTypeOf<BudgetCheckpoint>().toEqualTypeOf<CoordBudget>();
    expectTypeOf<ClaimDecision>().toEqualTypeOf<CoordClaim>();
  });

  it("does not re-export the internal Brand helper", () => {
    expect(readFileSync(join(CORE, "types.ts"), "utf8")).not.toMatch(/\bBrand\b/);
  });
});

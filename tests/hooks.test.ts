import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { HOOK_PATH, SqlHookAudit, type HookDecision, loadHooks, runHooks } from "../src/runtime/index.js";
import { type HookDescriptor, type HookInput, type Timer, defineHook } from "../src/shared/hook.js";
import type { SqlExecutor } from "../src/state/index.js";
import { MYSQL_URL, newMigratedMysqlDriver } from "./helpers/store.js";

// RFC 0015 §8 hooks: discovered, time-budgeted, veto or annotate only, never past a guard's refusal, off until
// enabled, every decision audited (runtime_hook_decisions). SQLite always; MySQL when SF_TEST_MYSQL_URL is set.

const INPUT: HookInput = { point: "before_merge", subject: "wi_1", project_id: "p1", passport_id: "pp_1", at: "2026-11-08T12:00:00.000Z" };
const NEVER: Timer = { after: () => new Promise(() => {}) };
const NOW: Timer = { after: async () => {} };
const ALLOW = { allowed: true } as const;

const hook = (name: string, run: HookDescriptor["run"], point: HookDescriptor["point"] = "before_merge") => defineHook({ name, point, budget_ms: 50, run });
const pass = hook("a-pass", async () => ({ kind: "pass" }));
const veto = hook("b-veto", async () => ({ kind: "veto", reason: "frozen branch" }));
const note = hook("c-note", async () => ({ kind: "annotate", note: "touches docs only" }));

describe("hooks", () => {
  it("are discovered at <component>/hooks/<name>/<name>.hook.ts; src/ ships none yet", async () => {
    const found = await loadHooks(join(import.meta.dirname, "fixtures", "hooks"));
    expect(found.map((h) => [h.file, h.descriptor.name])).toEqual([["runtime/hooks/sample/sample.hook.ts", "sample"]]);
    for (const h of [...found, ...(await loadHooks())]) {
      const m = HOOK_PATH.exec(h.file);
      expect(m && m[2] === m[3] && m[3] === h.descriptor.name, h.file).toBe(true);
    }
  });

  it("refuses a bad name, point or budget", () => {
    expect(() => defineHook({ name: "Bad", point: "before_merge", budget_ms: 1, run: pass.run })).toThrow(/kebab-case/);
    expect(() => defineHook({ name: "x", point: "after_merge" as never, budget_ms: 1, run: pass.run })).toThrow(/point/);
    expect(() => defineHook({ name: "x", point: "before_run", budget_ms: 60_000, run: pass.run })).toThrow(/budget_ms/);
  });

  it("run only when enabled, and only at their point (off by default)", async () => {
    const r = await runHooks({ input: INPUT, hooks: [veto], enabled: new Set(), guard: ALLOW, timer: NEVER });
    expect(r).toMatchObject({ allowed: true, reason: null, decisions: [] });
    const other = hook("d-run", async () => ({ kind: "veto", reason: "no" }), "before_run");
    expect((await runHooks({ input: INPUT, hooks: [other], enabled: new Set(["d-run"]), guard: ALLOW, timer: NEVER })).allowed).toBe(true);
  });

  it("veto with a reason or annotate; a pass and a note leave the action allowed", async () => {
    const all = new Set(["a-pass", "b-veto", "c-note"]);
    const r = await runHooks({ input: INPUT, hooks: [note, veto, pass], enabled: all, guard: ALLOW, timer: NEVER });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe("hook b-veto: frozen branch");
    expect(r.notes).toEqual([{ hook: "c-note", note: "touches docs only" }]);
    expect(r.decisions.map((d) => [d.hook, d.outcome])).toEqual([["a-pass", "pass"], ["b-veto", "veto"], ["c-note", "annotate"]]);
    const ok = await runHooks({ input: INPUT, hooks: [pass, note], enabled: all, guard: ALLOW, timer: NEVER });
    expect(ok).toMatchObject({ allowed: true, reason: null });
  });

  it("never approve what a guard refused: no hook runs then", async () => {
    let ran = false;
    const approve = hook("e-yes", async () => ((ran = true), { kind: "pass" }));
    const r = await runHooks({ input: INPUT, hooks: [approve], enabled: new Set(["e-yes"]), guard: { allowed: false, reason: "egress_blocked" }, timer: NEVER });
    expect(r).toEqual({ allowed: false, reason: "egress_blocked", notes: [], decisions: [] });
    expect(ran).toBe(false);
  });

  it("fail closed: a hook over its budget or one that throws counts as a veto, and is aborted", async () => {
    let aborted = false;
    const slow = hook("f-slow", (_i, signal) => new Promise(() => signal.addEventListener("abort", () => (aborted = true))));
    const r = await runHooks({ input: INPUT, hooks: [slow], enabled: new Set(["f-slow"]), guard: ALLOW, timer: NOW });
    expect(r.allowed).toBe(false);
    expect(r.decisions[0]).toMatchObject({ outcome: "timeout", text: "hook_timeout: over its 50 ms budget" });
    expect(aborted).toBe(true);
    const broken = hook("g-throw", async () => {
      throw new Error("boom");
    });
    const e = await runHooks({ input: INPUT, hooks: [broken], enabled: new Set(["g-throw"]), guard: ALLOW, timer: NEVER });
    expect(e).toMatchObject({ allowed: false, reason: "hook g-throw: hook_error: boom" });
  });

  it("clip a long reason to 200 characters", async () => {
    const long = hook("h-long", async () => ({ kind: "veto", reason: "x".repeat(500) }));
    const r = await runHooks({ input: INPUT, hooks: [long], enabled: new Set(["h-long"]), guard: ALLOW, timer: NEVER });
    expect(r.decisions[0]!.text!.length).toBe(200);
  });
});

async function sqlite(): Promise<SqlExecutor> {
  const d = new SqliteDriver(":memory:");
  await d.migrate();
  return d;
}


const BACKENDS: [string, boolean, () => Promise<SqlExecutor>][] = [
  ["sqlite", true, sqlite],
  ["mysql", Boolean(MYSQL_URL), newMigratedMysqlDriver],
];

for (const [name, enabled, open] of BACKENDS) {
  describe.skipIf(!enabled)(`hook audit (${name})`, () => {
    it("stores one row per decision, ids only", async () => {
      const audit = new SqlHookAudit(await open());
      await runHooks({ input: INPUT, hooks: [pass, veto], enabled: new Set(["a-pass", "b-veto"]), guard: ALLOW, timer: NEVER, audit });
      const rows: HookDecision[] = await audit.forSubject("wi_1");
      expect(rows.map((r) => [r.hook, r.outcome, r.text])).toEqual([["b-veto", "veto", "frozen branch"], ["a-pass", "pass", null]]);
      expect(rows[0]).toMatchObject({ point: "before_merge", project_id: "p1", passport_id: "pp_1", at: INPUT.at });
    });
  });
}

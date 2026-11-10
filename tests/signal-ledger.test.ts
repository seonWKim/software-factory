import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { ControllerDeps } from "../src/core/controller-deps.js";
import type { RunId, RunKind, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { loadSignals, roleOfRun } from "../src/controller/signals/signal.js";
import { Kernel } from "../src/controller/units/kernel.js";
import signalsUnit, { OVERLAP_MS, readFrom } from "../src/controller/units/signals/signals.unit.js";
import { Router } from "../src/controller/router/router.js";
import { loadDescriptors } from "../src/runtime/registry/registry.js";
import { CODE_ROOT, findDescriptorFiles } from "../src/state/index.js";
import { tickAt } from "../src/shared/ticks/tick-generator.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { human, issue, newStore, system, w1 } from "./helpers/store.js";

// Design 11-signal-ledger (issue #491): the `signals` unit writes one controller_signals row per stored signal.

const STEP = "signal ledger";
const COLUMNS = ["id", "source", "source_ref", "kind", "work_item_id", "role", "rule", "at"];
const SECRET = "finding text that must never reach the ledger";

type Store = Awaited<ReturnType<typeof newStore>>["store"];

/** A kernel and router over `store` with only the signals unit: a fresh writer, as a new process or replica builds it. */
function writer(store: FactoryStore, clock: FakeClock, root?: string) {
  const deps = { store, clock, config, scanner: cleanScanner, log: silent, auth: {} } as unknown as ControllerDeps;
  const none = async () => { throw new Error("the signal ledger writes no intent or message"); };
  const k = new Kernel(deps, { record: none, announce: none, emit: none, actions: none, byKey: none }, { beforeMerge: none }, root);
  const r = new Router([signalsUnit], k, {
    kinds: [], messages: [], guard: async (_w, fn) => fn(), reader: k.reader, commit: (d) => k.commit(d), now: () => tickAt("event", 1, clock.now().getTime()),
  });
  return { step: () => r.step(STEP, tickAt("poll", 1, clock.now().getTime())) };
}

async function rows(store: Store) {
  return (await store.db.all("SELECT source, source_ref, kind, work_item_id, role, rule, at FROM controller_signals ORDER BY source, source_ref"));
}

async function count(store: Store, table: string): Promise<number> {
  return Number((await store.db.all(`SELECT COUNT(*) AS n FROM ${table}`))[0]!.n);
}

/** A change with `reason` on the item, no field changed. */
async function change(store: Store, clock: FakeClock, it: WorkItem, reason: string, actor = human, detail?: Record<string, string>): Promise<WorkItem> {
  clock.advance(1000);
  const r = await store.transition({ id: it.id, expected_version: it.version, patch: {}, actor, reason, ...(detail ? { detail } : {}) });
  if (!r.ok) throw new Error(`transition ${reason}: ${r.reason}`);
  return r.item;
}

/** A run of `kind` on the item, claimed and finished with `outcome`. */
async function finishedRun(store: Store, clock: FakeClock, it: WorkItem, kind: RunKind, outcome: Parameters<Store["completeRun"]>[2]): Promise<{ item: WorkItem; run: RunId }> {
  clock.advance(1000);
  const t = await store.transition({ id: it.id, expected_version: it.version, patch: {}, actor: system, reason: "test_enqueue", enqueue: { kind, idempotency_key: `${it.id}:${kind}` } });
  if (!t.ok) throw new Error("enqueue");
  const run = await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 });
  clock.advance(1000);
  await store.completeRun(run!.id, run!.lease!.token, outcome);
  return { item: t.item, run: run!.id };
}

/** One record of every kind the shipped sources write, across two items; the second approved by a standing rule. */
async function seed(store: Store, clock: FakeClock) {
  let a = (await store.createWorkItem(issue(1), system)).item;
  let b = (await store.createWorkItem(issue(2), system)).item;
  for (const reason of ["spec_approved", "spec_rejected", "floor_tier_approved", "rule_of_two_approved", "spec_revision_requested", "retry_requested", "pr_revise_requested", "pr_changes_requested", "reverted", "fixed_forward"]) {
    a = await change(store, clock, a, reason);
  }
  a = await change(store, clock, a, "spec_approved", { kind: "system", id: "system:auto" });
  // Not a signal: an ordinary transition the source leaves out.
  a = await change(store, clock, a, "implemented", system);
  b = await change(store, clock, b, "standing_approved", { kind: "system", id: "system:standing:spec-t1" }, { standing_rule: "spec-t1" });
  clock.advance(1000);
  const v1 = await store.recordVerdict({ id: a.id, expected_version: a.version, actor: human, verdict: "changes", severity: "minor", reason: SECRET, comment_id: "c1", target: "pr", implicit: false, pr_head: "h1" });
  if (!v1.ok) throw new Error("verdict");
  a = v1.item;
  clock.advance(1000);
  const v2 = await store.recordVerdict({ id: b.id, expected_version: b.version, actor: system, verdict: "accept", severity: "none", reason: null, comment_id: "implicit:merged:b", target: "pr", implicit: true, pr_head: "h2" });
  if (!v2.ok) throw new Error("verdict");
  b = v2.item;
  const failed = await finishedRun(store, clock, a, "implement", { status: "failed", error_code: "tests_failed", detail: SECRET, infra: false });
  a = failed.item;
  const review = await finishedRun(store, clock, b, "review", {
    status: "succeeded", summary: SECRET, data: { review: { verdict: "bug", tier: 1, summary: SECRET, findings: [{ kind: "code", text: SECRET }, { kind: "spec", text: SECRET }] } },
  });
  return { a: a.id, b: b.id, failed: failed.run, review: review.run };
}

/** The ledger rows the seeded records should give, each from its source record. */
async function expected(store: Store, s: Awaited<ReturnType<typeof seed>>) {
  const reasons = (await loadSignals()).find((x) => x.name === "state_changes")!.kinds;
  const changes = [...(await store.listStateChanges(s.a)), ...(await store.listStateChanges(s.b))].filter((c) => reasons.includes(c.reason));
  const verdicts = [...(await store.listVerdicts(s.a)), ...(await store.listVerdicts(s.b))];
  const runs = [...(await store.listRuns(s.a)), ...(await store.listRuns(s.b))];
  const ruleOf = (id: WorkItemId) => (id === s.b ? "spec-t1" : null);
  const failed = runs.find((r) => r.id === s.failed)!;
  const review = runs.find((r) => r.id === s.review)!;
  return [
    ...changes.map((c) => ({ source: "state_changes", source_ref: c.id, kind: c.reason, work_item_id: c.work_item_id, role: null, rule: ruleOf(c.work_item_id), at: c.at })),
    ...verdicts.map((v) => ({ source: "verdicts", source_ref: v.id, kind: v.implicit ? "implicit_verdict" : "human_verdict", work_item_id: v.work_item_id, role: null, rule: ruleOf(v.work_item_id), at: v.at })),
    { source: "failed_runs", source_ref: failed.id, kind: "run_failed", work_item_id: s.a, role: "implement", rule: null, at: failed.finished_at },
    { source: "review_findings", source_ref: `${review.id}:0`, kind: "review_finding_code", work_item_id: s.b, role: "review", rule: "spec-t1", at: review.finished_at },
    { source: "review_findings", source_ref: `${review.id}:1`, kind: "review_finding_spec", work_item_id: s.b, role: "review", rule: "spec-t1", at: review.finished_at },
  ].sort((x, y) => (x.source + x.source_ref).localeCompare(y.source + y.source_ref));
}

const sortRows = (r: readonly Record<string, unknown>[]) => [...r].sort((x, y) => (String(x.source) + String(x.source_ref)).localeCompare(String(y.source) + String(y.source_ref)));

describe("signal ledger (design 11-signal-ledger)", () => {
  it("the first tick backfills one row per stored signal, each tagged from its source record", async () => {
    const { store, clock } = await newStore();
    const s = await seed(store, clock);
    await writer(store, clock).step();
    expect(sortRows(await rows(store))).toEqual(await expected(store, s));
    const kinds = new Set((await rows(store)).map((r) => r.kind));
    for (const k of ["spec_approved", "spec_rejected", "floor_tier_approved", "rule_of_two_approved", "standing_approved", "spec_revision_requested", "retry_requested",
      "pr_revise_requested", "pr_changes_requested", "reverted", "fixed_forward", "human_verdict", "implicit_verdict", "run_failed", "review_finding_code", "review_finding_spec"]) {
      expect(kinds, k).toContain(k);
    }
    expect(kinds).not.toContain("implemented");
  });

  it("a second tick, and a fresh writer on the same store, add no row", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    await writer(store, clock).step();
    const first = await rows(store);
    await writer(store, clock).step();
    expect(await rows(store)).toEqual(first);
    // A second replica, started fresh: nothing in memory, the same keys.
    clock.advance(OVERLAP_MS * 3);
    await writer(store, clock).step();
    expect(await rows(store)).toEqual(first);
  });

  it("a signal stored after the first tick is written on the next one", async () => {
    const { store, clock } = await newStore();
    let it = (await store.createWorkItem(issue(1), system)).item;
    it = await change(store, clock, it, "spec_approved");
    const w = writer(store, clock);
    await w.step();
    it = await change(store, clock, it, "retry_requested");
    await w.step();
    expect((await rows(store)).map((r) => r.kind).sort()).toEqual(["retry_requested", "spec_approved"]);
  });

  it("writes no state change, verdict, run, outbound intent or item field", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    const tables = ["controller_state_changes", "controller_verdicts", "worker_runs", "outbound_actions", "controller_outbox", "controller_work_items"];
    const before = await Promise.all(tables.map((t) => count(store, t)));
    const items = await store.db.all("SELECT * FROM controller_work_items ORDER BY id");
    const runs = await store.db.all("SELECT * FROM worker_runs ORDER BY id");
    await writer(store, clock).step();
    expect(await Promise.all(tables.map((t) => count(store, t)))).toEqual(before);
    expect(await store.db.all("SELECT * FROM controller_work_items ORDER BY id")).toEqual(items);
    expect(await store.db.all("SELECT * FROM worker_runs ORDER BY id")).toEqual(runs);
    expect(await count(store, "controller_signals")).toBeGreaterThan(0);
  });

  it("a row holds IDs, codes and times only: no text, no display name, no transcript", async () => {
    const { store, clock } = await newStore();
    await seed(store, clock);
    await writer(store, clock).step();
    const all = await store.db.all("SELECT * FROM controller_signals");
    expect(Object.keys(all[0]!).sort()).toEqual([...COLUMNS].sort());
    for (const r of all) expect(JSON.stringify(r)).not.toContain(SECRET.slice(0, 20));
    // The transcript is referenced by run ID only: no source or the unit reads a file or names a transcript.
    const files = [...findDescriptorFiles(join(CODE_ROOT, "controller"), /\.signal\.ts$/), join(CODE_ROOT, "controller/units/signals/signals.unit.ts")];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/from "node:fs/);
      expect(text.replace(/\/\/[^\n]*/g, ""), f).not.toMatch(/transcript/i);
    }
  });

  it("each source reads from its newest stored signal less the overlap, read from the store", async () => {
    expect(readFrom(null)).toBeNull();
    expect(readFrom("2026-11-11T12:00:00.000Z" as never)).toBe("2026-11-11T11:50:00.000Z");
    const { store, clock } = await newStore();
    let it = (await store.createWorkItem(issue(1), system)).item;
    it = await change(store, clock, it, "spec_approved");
    await writer(store, clock).step();
    // A record stored late with a time inside the overlap is still read; one older than the overlap is not.
    const latest = (await store.latestSignalAt("state_changes"))!;
    const late = new Date(Date.parse(latest) - OVERLAP_MS / 2).toISOString();
    const old = new Date(Date.parse(latest) - OVERLAP_MS * 2).toISOString();
    it = await change(store, clock, it, "retry_requested");
    it = await change(store, clock, it, "reverted");
    await store.db.run("UPDATE controller_state_changes SET at = ? WHERE reason = 'retry_requested'", [late]);
    await store.db.run("UPDATE controller_state_changes SET at = ? WHERE reason = 'reverted'", [old]);
    await writer(store, clock).step();
    expect((await rows(store)).map((r) => r.kind).sort()).toEqual(["retry_requested", "spec_approved"]);
  });

  it("the shipped sources are found by the runtime registry's discovery, and their roles come from the run kind", async () => {
    const byRegistry = (await loadDescriptors<{ kind: "signal"; name: string }>(CODE_ROOT, "signal")).map((d) => d.descriptor.name);
    expect((await loadSignals()).map((s) => s.name)).toEqual(byRegistry);
    expect(byRegistry).toEqual(expect.arrayContaining(["state_changes", "verdicts", "failed_runs", "review_findings"]));
    expect(roleOfRun("review")).toBe("review");
    expect(roleOfRun("update")).toBeNull();
  });
});

describe("a new signal source (design 11-signal-ledger)", () => {
  const dir = mkdtempSync(join(tmpdir(), "signal-fixture-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("a *.signal.ts file found by discovery gets its rows written, with no change to the writer", async () => {
    const api = pathToFileURL(join(CODE_ROOT, "controller/signals/signal.ts")).href;
    writeFileSync(join(dir, "fixture.signal.ts"), [
      `import { defineSignal } from ${JSON.stringify(api)};`,
      "export default defineSignal({",
      '  name: "fixture", kinds: ["fixture_seen", "fixture_other"],',
      "  async read(r, since) {",
      '    const changes = await r.listStateChangesSince({ reasons: ["intake"], since });',
      '    return [...changes.map((c) => ({ source_ref: c.id, kind: "fixture_seen", work_item_id: c.work_item_id, role: null, at: c.at })),',
      '      // Not in its kinds: left out.',
      '      ...changes.map((c) => ({ source_ref: `x:${c.id}`, kind: "unlisted", work_item_id: c.work_item_id, role: null, at: c.at }))];',
      "  },",
      "});",
      "",
    ].join("\n"));
    const { store, clock } = await newStore();
    const a = (await store.createWorkItem(issue(1), system)).item;
    const intake = (await store.listStateChanges(a.id))[0]!;
    await writer(store, clock, dir).step();
    expect(await rows(store)).toEqual([{ source: "fixture", source_ref: intake.id, kind: "fixture_seen", work_item_id: a.id, role: null, rule: null, at: intake.at }]);
  });
});

describe("store reads of the signal ledger", () => {
  it("recordSignal skips a stored (source, source_ref)", async () => {
    const { store } = await newStore();
    const s = { source: "x", source_ref: "r1", kind: "k", work_item_id: "wi_1" as WorkItemId, role: null, rule: null, at: "2026-11-11T00:00:00.000Z" as never };
    expect(await store.recordSignal(s)).toBe(true);
    expect(await store.recordSignal({ ...s, kind: "other" })).toBe(false);
    expect(await store.latestSignalAt("x")).toBe("2026-11-11T00:00:00.000Z");
    expect(await store.latestSignalAt("y")).toBeNull();
  });

  it("the unit is pure: load reads, decide returns the writes", () => {
    const step = signalsUnit.steps![0]!;
    expect("load" in step && "decide" in step).toBe(true);
  });
});

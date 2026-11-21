// Design 05-interactive-sessions (2026-11-21): `worker_kinds`, the run kinds a worker claims, read live at each
// claim. Default: all eight, as the fixed list was. Left out of it, a queued implement or resolve run stays queued
// for an interactive session, while reviews and merge checks keep flowing; the item says it waits for a session.

import { describe, expect, it, vi } from "vitest";
import { LiveSettings, WORKER_KINDS, baseFromConfig } from "../src/core/settings.js";
import type { Run, RunKind, WorkItemId, WorkerId } from "../src/core/types.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { runSettings } from "../src/settings-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import { readClaimPauses } from "../src/ui/list.js";
import type { UiDeps } from "../src/ui/server.js";
import { type UiSettings, newCsrfToken, writeSettings } from "../src/ui/settings-api.js";
import { whyWaiting } from "../src/ui/why.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { cleanScanner, config, prompts, silent } from "./helpers/fakes/config.js";
import { issue, newStore, system } from "./helpers/store.js";

const NARROW: readonly RunKind[] = ["triage", "review", "merge-check", "update", "restart", "improve"];
const REPO = { owner: "o", name: "r" };

/** A worker on `store` with live settings (8 slots, so the slot cap never stops a claim here); execute is a no-op that records the claimed kind. */
async function worker(store: FactoryStore) {
  const settings = new LiveSettings({ config, base: { ...baseFromConfig(config), max_workers: 8 }, source: store, log: silent });
  await store.setSettingOverride({ key: "workers", project: "", value: "8", actor: "local:owner" });
  const w = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner: new FakeRunner({}), broker: new FakeBroker(), storage: new MemoryStorage(),
    clock: new FakeClock(), config, prompts, log: silent, scanner: cleanScanner, toolEnv: { PATH: "/usr/bin" }, awake: new NoKeepAwake(), settings,
  });
  const claimed: RunKind[] = [];
  vi.spyOn(w, "execute").mockImplementation(async (run: Run) => { claimed.push(run.kind); });
  return { w, claimed };
}

/** One item per kind, each with one queued run of that kind. */
async function enqueue(store: FactoryStore, kinds: readonly RunKind[], first = 100) {
  const ids = new Map<RunKind, WorkItemId>();
  for (const [i, kind] of kinds.entries()) {
    const { item } = await store.createWorkItem(issue(first + i), system, { enqueue: { kind, idempotency_key: `k-${kind}` } });
    ids.set(kind, item.id);
  }
  return ids;
}

/** Ticks until the worker finds nothing to claim. */
async function drain(w: Worker) {
  for (let i = 0; i < 20 && (await w.tick()); i++);
}

const setKinds = (store: FactoryStore, kinds: readonly string[]) =>
  store.setSettingOverride({ key: "worker_kinds", project: "", value: JSON.stringify(kinds), actor: "local:owner" });

describe("the worker's claim reads worker_kinds", () => {
  it("default: a worker claims every one of the eight kinds, as with the fixed list", async () => {
    const { store } = await newStore();
    expect([...WORKER_KINDS].sort()).toEqual(["implement", "improve", "merge-check", "resolve", "restart", "review", "triage", "update"]);
    await enqueue(store, WORKER_KINDS);
    const { w, claimed } = await worker(store);
    await drain(w);
    expect([...claimed].sort()).toEqual([...WORKER_KINDS].sort());
  });

  it("narrowed to triage, review, merge-check, update, restart and improve: implement and resolve stay queued, a review is claimed", async () => {
    const { store } = await newStore();
    await setKinds(store, NARROW);
    const ids = await enqueue(store, ["implement", "resolve", "review"]);
    const { w, claimed } = await worker(store);
    await drain(w);
    expect(claimed).toEqual(["review"]);
    for (const kind of ["implement", "resolve"] as const) {
      expect((await store.listRuns(ids.get(kind)!)).map((r) => r.status), kind).toEqual(["queued"]);
    }
  });

  it("a change applies at the same worker's next claim, with no restart", async () => {
    const { store } = await newStore();
    await setKinds(store, ["triage"]);
    await enqueue(store, ["implement"]);
    const { w, claimed } = await worker(store);
    expect(await w.tick()).toBe(false);
    await setKinds(store, ["triage", "implement"]);
    expect(await w.tick()).toBe(true);
    expect(claimed).toEqual(["implement"]);
  });
});

describe("worker_kinds refusals", () => {
  const BAD: readonly [string, string][] = [
    ['["implement", "deploy"]', 'worker_kinds: unknown run kind "deploy"'],
    ['["interactive"]', 'worker_kinds: unknown run kind "interactive"'],
    ['["review", "review"]', 'worker_kinds: run kind "review" is listed twice'],
    ["[]", "worker_kinds must list at least one run kind"],
  ];

  it("settings set and POST /api/v1/settings refuse an unknown kind, a repeat or an empty list with the same message; nothing is stored", async () => {
    const clock = new FakeClock("2026-11-21T03:00:00.000Z");
    const { store } = await newStore(clock);
    const deps = { store, base: { file: {}, layers: config.settings }, repo: REPO, resolveProject: () => Promise.reject(new Error("no")), actor: "" };
    const settings: UiSettings = { base: { file: {}, layers: config.settings }, repo: REPO, actor: "local:owner", resolveProject: async () => null, csrfToken: newCsrfToken() };
    const d: UiDeps = { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), settings };
    for (const [value, message] of BAD) {
      const cli = await runSettings(deps, { action: "set", key: "worker_kinds", value });
      expect(cli.ok, value).toBe(false);
      const said = cli.lines.join("\n");
      expect(said, value).toContain(message);
      const api = await writeSettings(d, settings, { action: "set", key: "worker_kinds", value });
      expect(api.status, value).toBe(422);
      expect(said, value).toContain((api.value as { error: string }).error);
    }
    expect(await store.listSettingOverrides()).toEqual([]);
  });

  it("settings list shows the default, and a narrowed list is taken", async () => {
    const { store } = await newStore();
    const deps = { store, base: { file: {}, layers: config.settings }, repo: REPO, resolveProject: () => Promise.reject(new Error("no")), actor: "" };
    const before = (await runSettings(deps, { action: "list" })).lines.find((l) => l.startsWith("worker_kinds"));
    expect(before).toContain(JSON.stringify(WORKER_KINDS));
    expect((await runSettings(deps, { action: "set", key: "worker_kinds", value: JSON.stringify(NARROW) })).ok).toBe(true);
    expect((await runSettings(deps, { action: "list" })).lines.find((l) => l.startsWith("worker_kinds"))).toContain(JSON.stringify(NARROW));
  });
});

describe("an item whose queued run is of a kind no worker claims", () => {
  const item = { stage: "RUNNING" as const, blocked_on: "none" as const, blocked_reason: null, close_reason: null };
  const queued = (kind: RunKind) => ({ id: "run_1", kind, status: "queued" as const, position: null });
  const input = (kind: RunKind, worker_kinds: readonly RunKind[] | null) =>
    ({ item, run: queued(kind), decision: null, pauses: { worker_kinds }, not_before: null, phases: { waiting_on: 0, waiting_on_number: null } });

  it("says it waits for a session; a listed kind reads as queued", () => {
    expect(whyWaiting(input("implement", NARROW))).toMatchObject({ code: "queued", reason_code: "waits_session", next_actor: "human", params: { kind: "implement" } });
    expect(whyWaiting(input("review", NARROW)).reason_code).toBe("queued");
    expect(whyWaiting(input("implement", null)).reason_code).toBe("queued");
  });

  it("the dashboard reads the live setting from the store: the default lists every kind, an override narrows it", async () => {
    const { store } = await newStore();
    expect((await readClaimPauses(store)).worker_kinds).toEqual([...WORKER_KINDS]);
    await setKinds(store, NARROW);
    const pauses = await readClaimPauses(store);
    expect(pauses.worker_kinds).toEqual(NARROW);
    expect(whyWaiting({ ...input("implement", null), pauses }).reason_code).toBe("waits_session");
  });
});

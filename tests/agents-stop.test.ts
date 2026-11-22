// Stop all agents and resume (design 05-restart-pauses, 2026-11-21): `factory stop` and the dashboard's Stop all agents
// start the owner pause, the all-workers row of worker_pauses (`workers pause --all`), so no worker claims; `factory
// resume owner` and Resume now end it, clearing every worker pause. `workers` 0 stops every loop and leaves the running
// runs alone. How a worker puts its implement or review run back in the queue within one tick, attempt and folder kept,
// is the worker pause's own test (tests/worker-pause.test.ts, "workers pause --all").

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCommands } from "../src/cli/index.js";
import type { Loaded } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import type { LogFields, Logger } from "../src/core/log.js";
import type { CliEnvironment } from "../src/core/local-cli.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { LiveSettings, baseFromConfig, parseSettable } from "../src/core/settings.js";
import type { UserId, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { REGISTRY } from "../src/plugins.js";
import { parseResumeArgs } from "../src/resume-cmd.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { UiPauses } from "../src/ui/pause-api.js";
import { type PauseDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { WorkerPool } from "../src/worker/index.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeRunner, FakeSandbox, MemoryStorage } from "./helpers/fakes/runner.js";
import { cleanScanner, config, prompts, silent, triageSpec, waitFor } from "./helpers/fakes/config.js";

const FIXED: CliEnvironment = { gitEmail: "Me@Example.com", osUser: "os-login" };
const ME = "local:me@example.com";
const W0 = "host:1:0" as WorkerId;

/** Runs a real CLI command (`stop` or `resume`) with a fixed environment over `store`, kept open after it. */
async function command(store: FactoryStore, name: "stop" | "resume", ...args: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "sf-stop-"));
  const loaded = {
    root: dir, stateDir: dir, file: {}, config: { repo: { owner: "o", name: "r" }, local_only: true }, registry: REGISTRY, plugins: { clock: "system" },
  } as unknown as Loaded;
  const kept = new Proxy(store, { get: (t, k) => (k === "close" ? async () => {} : Reflect.get(t, k, t)) });
  const out: string[] = [], logs: Record<string, unknown>[] = [];
  vi.spyOn(console, "log").mockImplementation((l: string) => void out.push(l));
  vi.spyOn(console, "error").mockImplementation((l: string) => void out.push(l));
  vi.spyOn(process.stderr, "write").mockImplementation((l: string | Uint8Array) => (logs.push(JSON.parse(String(l)) as Record<string, unknown>), true));
  const cmd = (await loadCommands()).get(name)!;
  const code = await cmd.run(args, { name, usage: "", load: async () => loaded, environment: async () => FIXED, openStore: async () => kept });
  vi.restoreAllMocks();
  return { code, out, logs };
}

/** A store with one queued triage run. */
async function queued() {
  const { store, clock } = await newStore();
  await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
  const claim = () => store.claimRun({ worker_id: W0, kinds: ["triage"], lease_ms: 60_000 });
  return { store, clock, claim };
}

describe("factory stop", () => {
  afterEach(() => vi.restoreAllMocks());

  it("starts one owner pause as the CLI identity: the row keeps who and when, one log line, and no worker claims", async () => {
    const { store, claim } = await queued();
    const r = await command(store, "stop");
    const [row] = await store.listWorkerPauses();
    expect(row).toMatchObject({ worker_id: "*", paused_by: ME });
    expect(r.code).toBe(0);
    expect(r.out[0]).toBe(`stopped every agent at ${row!.paused_at}`);
    expect(r.logs).toEqual([expect.objectContaining({ msg: "agents stopped", actor: ME, since: row!.paused_at, at: expect.any(String) })]);
    expect(JSON.stringify(r.logs)).not.toContain("os-login");
    expect(await claim()).toBeNull();
  });

  it("a second stop keeps the first one's row and says so", async () => {
    const { store, clock } = await queued();
    await command(store, "stop");
    const first = await store.listWorkerPauses();
    clock.advance(60_000);
    const r = await command(store, "stop");
    expect(r).toMatchObject({ code: 0, out: [`agents were already stopped at ${first[0]!.paused_at}`, expect.any(String)] });
    expect(await store.listWorkerPauses()).toEqual(first);
  });

  it("an identity the owner check refuses gets `not changed: <reason>`, exit 1, and nothing is written or logged", async () => {
    const { store, claim } = await queued();
    await store.claimOwner("local:owner@example.com" as UserId);
    const r = await command(store, "stop");
    expect(r).toEqual({ code: 1, out: ["not changed: not_owner"], logs: [] });
    expect(await store.listWorkerPauses()).toEqual([]);
    expect(await claim()).not.toBeNull();
  });
});

describe("factory resume owner", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ends the owner pause and every worker pause, logged with the actor; the queued run is claimed again", async () => {
    const { store, claim } = await queued();
    await command(store, "stop");
    const r = await command(store, "resume", "owner");
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["ended the owner pause"]);
    expect(r.logs).toEqual([expect.objectContaining({ msg: "claim pause ended", pause: "owner", actor: ME, ended: true, at: expect.any(String) })]);
    expect(await store.listWorkerPauses()).toEqual([]);
    expect(await claim()).not.toBeNull();
    expect((await command(store, "resume", "owner")).out).toEqual(["owner: no pause in effect"]);
  });

  it("`factory resume` with no name ends only rate_limit; --all includes the owner pause", async () => {
    const { store } = await queued();
    await command(store, "stop");
    expect(parseResumeArgs([])).toEqual({ pauses: ["rate_limit"] });
    await command(store, "resume");
    expect(await store.listWorkerPauses()).toHaveLength(1);
    const r = await command(store, "resume", "--all");
    expect(r.out).toContain("ended the owner pause");
    expect(await store.listWorkerPauses()).toEqual([]);
  });

  it("a refused resume prints `not resumed: <reason>`, exit 1, and the agents stay stopped", async () => {
    const { store, claim } = await queued();
    await store.claimOwner("local:owner@example.com" as UserId);
    await store.pauseWorkers({ all: true }, "local:owner@example.com");
    const r = await command(store, "resume", "owner");
    expect(r).toEqual({ code: 1, out: ["not resumed: not_owner"], logs: [] });
    expect(await store.listWorkerPauses()).toHaveLength(1);
    expect(await claim()).toBeNull();
  });
});

describe("the dashboard's Stop all agents and Resume now", () => {
  const HOST = "127.0.0.1:4310";
  const OWNER = "github:1" as UserId;

  class MemLog implements Logger {
    lines: { msg: string; fields?: LogFields | undefined }[] = [];
    info(msg: string, fields?: LogFields) {
      this.lines.push({ msg, fields });
    }
    warn(msg: string, fields?: LogFields) {
      this.lines.push({ msg, fields });
    }
    error(msg: string, fields?: LogFields) {
      this.lines.push({ msg, fields });
    }
  }

  async function page(user: UserId) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await store.claimOwner(OWNER);
    const auth = new OwnerAuth(store);
    const log = new MemLog();
    const pauses: UiPauses = {
      principal: async () => user,
      authorize: (user_id) => auth.authorize({ user_id }, "approve_spec", { kind: "project", id: PROJECT_KEY }),
      csrfToken: newCsrfToken(),
      log,
    };
    const d: PauseDeps = {
      store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock), pauses,
    };
    const post = (url: string, body: unknown): UiRequest => ({
      method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: pauses.csrfToken, body: JSON.stringify(body),
    });
    const list = async () => JSON.parse((await respond(d, { method: "GET", url: "/api/v1/pauses", host: HOST })).body).pauses;
    return { d, store, clock, log, post, list };
  }

  it("Stop starts the owner pause; the pause list shows it with when it began and no end; Resume now ends it", async () => {
    const p = await page(OWNER);
    const r = await respond(p.d, p.post("/api/v1/agents/stop", {}));
    expect(r.status).toBe(200);
    const since = p.clock.now().toISOString();
    expect(JSON.parse(r.body)).toMatchObject({ name: "owner", stopped: true, since });
    expect(await p.store.listWorkerPauses()).toEqual([expect.objectContaining({ worker_id: "*", paused_by: OWNER, paused_at: since })]);
    expect(await p.list()).toEqual([{ name: "owner", ends_at: null, since }]);
    expect(p.log.lines).toEqual([{ msg: "agents stopped", fields: { pause: "owner", actor: OWNER, stopped: true, since } }]);
    const resumed = await respond(p.d, p.post("/api/v1/pauses/resume", { name: "owner" }));
    expect(JSON.parse(resumed.body)).toMatchObject({ name: "owner", ended: true, pauses: [] });
    expect(await p.store.listWorkerPauses()).toEqual([]);
  });

  it("a page user the owner check refuses gets 403 and nothing is written", async () => {
    const p = await page("github:2" as UserId);
    const r = await respond(p.d, p.post("/api/v1/agents/stop", {}));
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body).error).toContain("approve_spec");
    expect(await p.store.listWorkerPauses()).toEqual([]);
    expect(p.log.lines).toEqual([]);
  });

  it("a stop without the page's CSRF token is refused before the owner check", async () => {
    const p = await page(OWNER);
    const r = await respond(p.d, { ...p.post("/api/v1/agents/stop", {}), csrfToken: "stale" });
    expect(r.status).toBe(403);
    expect(await p.store.listWorkerPauses()).toEqual([]);
  });
});

describe("workers 0", () => {
  it("is accepted by `settings set` and in factory.config.json; below 0 is refused", () => {
    expect(parseSettable("workers", 0)).toBe(0);
    expect(() => parseSettable("workers", -1)).toThrow("workers must be an integer of 0 or more");
  });

  /** A pool of two slots whose live `workers` comes from the store's settings overrides, over one gated triage run. */
  async function livePool(workers: number) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } });
    await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } });
    let release = () => {};
    let started = 0;
    const runner = new FakeRunner({ triage: () => (started++, new Promise((resolve) => (release = () => resolve({ output: triageSpec })))) });
    const cfg: FactoryConfig = { ...config, workers, max_workers: 2 };
    const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store, log: silent });
    const pool = new WorkerPool({
      id_prefix: "host:42", store, sandbox: new FakeSandbox(), runner, broker: new FakeBroker(), storage: new MemoryStorage(),
      clock, config: cfg, prompts, log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(), settings,
    });
    const claims = vi.spyOn(store, "claimRun");
    const tick = async () => {
      clock.advance(cfg.tick_ms);
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    };
    const set = (v: number) => store.setSettingOverride({ key: "workers", project: "", value: String(v), actor: "local:test" });
    return { store, pool, claims, tick, set, started: () => started, release: () => release() };
  }

  it("no loop runs, so no worker claims", async () => {
    const p = await livePool(0);
    expect(p.pool.loops()).toBe(0);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    for (let i = 0; i < 5; i++) await p.tick();
    expect(p.claims).not.toHaveBeenCalled();
    expect(await p.store.listRunsByStatus(["queued"], 10)).toHaveLength(2);
    stop.abort();
    await loops;
  });

  it("set while a run is going: the run is left alone and finishes, and nothing more is claimed", async () => {
    const p = await livePool(1);
    const stop = new AbortController();
    const loops = p.pool.run(stop.signal);
    await waitFor(() => p.started() === 1, "a triage run in flight");
    await p.set(0);
    await p.tick();
    expect(p.pool.loops()).toBe(0);
    const calls = p.claims.mock.calls.length;
    expect(await p.store.listRunsByStatus(["running"], 10)).toHaveLength(1);
    p.release();
    await waitFor(async () => (await p.store.listRunsByStatus(["succeeded"], 10)).length === 1, "the run to finish");
    for (let i = 0; i < 5; i++) await p.tick();
    expect(p.started()).toBe(1);
    expect(p.claims.mock.calls.length).toBe(calls);
    stop.abort();
    await loops;
  });
});

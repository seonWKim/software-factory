import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { networkProbeDelayMs } from "../src/core/policy.js";
import type { RunKind, Timestamp } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { HttpNetworkProbe, probeTargets } from "../src/impl/network-probe/http-network-probe.js";
import type { Selection } from "../src/plugin-api.js";
import { modelStallChecks, modelStallLine } from "../src/ui/factory-status.js";
import { FakeAuth, FakeNetworkProbe, FakeSource, cleanScanner, config, recordingLog } from "./helpers/fakes.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// Design §5 Restarts, network pause: the `network` claim pause holds every claim until a network probe passes.
// One probe schedule with the stall pause: the replica that takes the due probe probes; a failure leaves the next
// probe 30 s later, backing off to 5 min.

const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;
const KINDS: RunKind[] = ["triage", "implement", "review", "update", "resolve"];

async function setup(answers: ConstructorParameters<typeof FakeNetworkProbe>[0] = []) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const log = recordingLog();
  const probe = new FakeNetworkProbe(answers);
  const controller = (p: FakeNetworkProbe = probe) =>
    new ControllerRole({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log, scanner: cleanScanner, network_probe: p });
  const t0 = clock.now().getTime();
  const pause = () => store.pauseClaims(iso(clock.now().getTime() + 30_000), "network");
  return { clock, store, log, probe, controller, t0, pause };
}

describe("the network claim pause in the store", () => {
  it("while it is in effect, claimRun returns null for every run kind, triage and review included, also past its probe time", async () => {
    const { store, clock, pause } = await setup();
    for (const [i, kind] of KINDS.entries()) {
      await store.createWorkItem(issue(100 + i), system, { enqueue: { kind, idempotency_key: `k-${kind}` } });
    }
    expect(await pause()).toMatchObject({ started: true, extended: true });
    for (const kind of KINDS) expect(await store.claimRun({ worker_id: w1, kinds: [kind], lease_ms: 60_000 })).toBeNull();
    clock.advance(30_001);
    expect(await store.claimRun({ worker_id: w1, kinds: KINDS, lease_ms: 60_000 })).toBeNull();
    // Ended: every kind is claimable again.
    expect(await store.endClaimPause("network")).toEqual({ ended: true });
    expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 })).not.toBeNull();
    expect(await store.claimRun({ worker_id: w1, kinds: ["review"], lease_ms: 60_000 })).not.toBeNull();
  });

  it("a second failure during the pause starts nothing; network_since keeps the start", async () => {
    const { store, clock, pause } = await setup();
    const start = clock.now().toISOString();
    expect(await pause()).toMatchObject({ started: true });
    clock.advance(1_000);
    expect(await pause()).toMatchObject({ started: false });
    expect(await store.getClaimPause("network_since")).toBe(start);
    await expect(store.endClaimPause("network_since")).rejects.toThrow(/not a pause/);
    await expect(store.endClaimPause("network_answered")).rejects.toThrow(/not a pause/);
    await expect(store.pauseClaims(iso(0), "network_since")).rejects.toThrow(/written by the store/);
  });

  it("claimProbe lets exactly one caller take a due probe", async () => {
    const { store, clock, pause } = await setup();
    const p = await pause();
    clock.advance(30_000);
    const next = iso(clock.now().getTime() + 30_000);
    expect(await store.claimProbe("network", p.resume_at, next)).toBe(true);
    expect(await store.claimProbe("network", p.resume_at, next)).toBe(false);
    expect(await store.getClaimPause("network")).toBe(next);
  });
});

describe("the network probe (fake clock)", () => {
  it("a failing probe moves the next one later, 30 s apart, backing off to 5 min; a passing one ends the pause", async () => {
    const fail = { ok: false as const, host: "github.com" };
    const { store, clock, probe, controller, t0, pause, log } = await setup([fail, fail, fail, fail, fail, fail]);
    const c = controller();
    await pause();
    const gaps: number[] = [];
    let last = t0;
    // Not due yet: nothing is asked.
    clock.advance(29_999);
    await c.tickModelProbe();
    expect(probe.probes).toBe(0);
    clock.advance(1);
    for (let i = 0; i < 6; i++) {
      const due = Date.parse((await store.getClaimPause("network"))!);
      clock.advance(due - clock.now().getTime());
      await c.tickModelProbe();
      gaps.push(due - last);
      last = due;
      expect(probe.probes).toBe(i + 1);
      expect(await store.claimRun({ worker_id: w1, kinds: KINDS, lease_ms: 60_000 })).toBeNull();
    }
    expect(gaps).toEqual([30_000, 30_000, 60_000, 120_000, 240_000, 300_000]);
    expect(Date.parse((await store.getClaimPause("network"))!) - clock.now().getTime()).toBe(300_000);
    expect(await modelStallLine(store)).toBe(`agents paused: network not reachable since ${iso(t0)}; runs start again once a probe passes`);
    expect(await modelStallChecks(store)).toEqual([{ ok: false, msg: await modelStallLine(store) }]);

    // The next probe passes: the pause ends and claims resume.
    await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t" } });
    clock.advance(300_000);
    await c.tickModelProbe();
    expect(probe.probes).toBe(7);
    expect(await store.getClaimPause("network")).toBeNull();
    expect(await store.getClaimPause("network_since")).toBeNull();
    expect(await modelStallLine(store)).toBeNull();
    expect(await store.claimRun({ worker_id: w1, kinds: KINDS, lease_ms: 60_000 })).not.toBeNull();
    expect(log.lines.filter((l) => l.msg === "network reachable again: claims resume")).toHaveLength(1);
    // Failed probes log at info with the host only; no warn from the probe step.
    expect(log.lines.filter((l) => l.level === "warn")).toEqual([]);
    expect(log.lines.filter((l) => l.msg.startsWith("network still unreachable")).map((l) => l.fields?.host)).toEqual(Array(6).fill("github.com"));
    // No more probes once the pause ended.
    clock.advance(300_000);
    await c.tickModelProbe();
    expect(probe.probes).toBe(7);
  });

  it("the delay runs 30 s, 30 s, 1, 2, 4 min, then 5 min", () => {
    expect([0, 30_000, 60_000, 120_000, 240_000, 540_000, 3_600_000].map(networkProbeDelayMs)).toEqual([
      30_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000,
    ]);
  });

  it("of two replicas whose probe step runs at the same due time, only one probes", async () => {
    const { clock, pause, controller } = await setup();
    const a = new FakeNetworkProbe([{ ok: false, host: "github.com" }]);
    const b = new FakeNetworkProbe([{ ok: false, host: "github.com" }]);
    await pause();
    clock.advance(30_000);
    await Promise.all([controller(a).tickModelProbe(), controller(b).tickModelProbe()]);
    expect(a.probes + b.probes).toBe(1);
  });

  it("with no network probe configured, the pause ends at its first probe time", async () => {
    const { store, clock, log, pause } = await setup();
    const c = new ControllerRole({ store, source: new FakeSource(), auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
    await pause();
    clock.advance(30_000);
    await c.tickModelProbe();
    expect(await store.getClaimPause("network")).toBeNull();
  });
});

describe("the http probe", () => {
  const base = { sandbox: "noop", secrets: "env-file", egress: "pattern", storage: "fs", capability: "list-all", clock: "system" };
  const sel = (over: Partial<Selection>): Selection => ({ ...base, ...over }) as Selection;

  it("targets only the endpoints of the selected plugins: no GitHub without a GitHub plugin", () => {
    const local = sel({ broker: "local", source: "local", auth: "local", runner: "scripted", llm: "none" });
    expect(probeTargets(local, {})).toEqual([]);
    const github = sel({ broker: "github", source: "local", auth: "local", runner: "claude-code", llm: "claude-cli" });
    expect(probeTargets(github, {})).toEqual(["https://api.github.com", "https://api.anthropic.com"]);
    const openai = sel({ broker: "local", source: "local", sources: ["local", "github-issues"], auth: "local", runner: "openai-compatible", llm: "openai-compatible" });
    expect(probeTargets(openai, { openai_compatible: { base_url: "https://llm.corp.example/v1", models: { cheap: "a", standard: "b", strong: "c" } } }))
      .toEqual(["https://api.github.com", "https://llm.corp.example/v1"]);
  });

  it("sends HEAD with no credential; any HTTP status passes, a fetch error fails with the host only", async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const answering = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 401 });
    }) as unknown as typeof fetch;
    expect(await new HttpNetworkProbe(["https://api.github.com", "https://llm.corp.example/v1"], answering).probe()).toEqual({ ok: true });
    expect(calls.map((c) => [c.url, c.init?.method, c.init?.headers])).toEqual([
      ["https://api.github.com", "HEAD", undefined],
      ["https://llm.corp.example/v1", "HEAD", undefined],
    ]);

    const dead = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND llm.corp.example") });
    }) as unknown as typeof fetch;
    const r = await new HttpNetworkProbe(["https://user:pw@llm.corp.example/v1?key=k"], dead).probe();
    expect(r).toEqual({ ok: false, host: "llm.corp.example" });
    expect(await new HttpNetworkProbe([], dead).probe()).toEqual({ ok: true });
  });
});

// Needs you's system actions (design §9 Status page, issue #311): a pending migration, a GitHub token expiring
// within 3 days, a claim or worker pause, a claim deadlock and a revision mismatch, each with its command, in
// /api/v1/overview's `system_actions` and counted in `needs_you`. The poll asks GitHub nothing.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimDecision, Timestamp, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore, SchemaVersion } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { migrationPendingError } from "../src/interfaces/updater.js";
import type { Check } from "../src/setup.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { FactoryStatus } from "../src/ui/factory-status.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { LastChecks, olderThanFactory, parseRevision } from "../src/ui/system-actions.js";
import { issue, newStore, system } from "./helpers/store.js";

const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

interface Action { code: string; text: string; command: string; until: string | null; work_item_id: string | null }
interface Overview { needs_you: number; system_actions: Action[]; server_rev: string | null; github_token_days: number | "unknown" | null }

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A real store behind a Proxy: `schemaVersion` and `listClaimDecisions` answer from the test. */
async function setup(opts: { version?: SchemaVersion | Error; checks?: Check[]; revision?: string | null; factory?: FactoryStatus | null } = {}) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const decisions = new Map<string, ClaimDecision[]>();
  const proxied = new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "schemaVersion" && opts.version) {
        return async () => {
          if (opts.version instanceof Error) throw opts.version;
          return opts.version;
        };
      }
      if (prop === "listClaimDecisions") return async (id: WorkItemId) => decisions.get(id) ?? [];
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  }) as FactoryStore;
  const lastChecks = new LastChecks();
  let runs = 0;
  const health = new HealthMonitor(lastChecks.wrap(async () => {
    runs++;
    return opts.checks ?? [];
  }), clock);
  const d: ApiDeps = {
    store: proxied,
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: 60_000,
    health,
    lastChecks,
    revision: opts.revision ?? null,
    ...(opts.factory !== undefined ? { factoryStatus: async () => opts.factory ?? null } : {}),
  };
  const overview = async (query = "") => {
    const r = await respond(d, { method: "GET", url: `/api/v1/overview${query}`, host: "127.0.0.1:4310" });
    expect(r.status).toBe(200);
    return JSON.parse(r.body) as Overview;
  };
  return { d, store, clock, decisions, overview, health, runs: () => runs };
}

const codes = (o: Overview) => o.system_actions.map((a) => a.code);

describe("system actions: none on a quiet factory", () => {
  it("an up-to-date store with no pause, no deadlock and equal revisions lists nothing", async () => {
    const { overview } = await setup({ revision: REV_A });
    const o = await overview(`?rev=${REV_A}`);
    expect(o.system_actions).toEqual([]);
    expect(o.needs_you).toBe(0);
    expect(o.server_rev).toBe(REV_A);
  });
});

describe("system actions: pending migration", () => {
  it("a schema behind the code is listed with `npm run migrate` and counts in needs_you", async () => {
    const { overview } = await setup({ version: { applied: 3, latest: 8 } });
    const o = await overview();
    expect(o.system_actions).toContainEqual({ code: "migration_pending", text: "Schema at version 3 of 8", command: "npm run migrate", until: null, work_item_id: null });
    expect(o.needs_you).toBe(1);
  });

  it("a store that refuses to open until migrate ran is listed too; another read error is not", async () => {
    expect(codes(await (await setup({ version: migrationPendingError("2 steps pending: run `npm run migrate`") })).overview())).toEqual(["migration_pending"]);
    expect(codes(await (await setup({ version: new Error("connect ECONNREFUSED") })).overview())).toEqual([]);
  });

  it("a supervisor whose update waits on the migration is listed", async () => {
    const factory = { state: "migration_pending", rev: REV_A, target_rev: REV_B, child_pid: 1, since: "x", pending: ["0031_x.sql"], workers: 1 } as FactoryStatus;
    const o = await (await setup({ factory })).overview();
    expect(o.system_actions).toMatchObject([{ code: "migration_pending", text: "The update to bbbbbbb waits for the migration (pending: 0031_x.sql)", command: "npm run migrate" }]);
  });
});

describe("system actions: GitHub token expiry from the last health run", () => {
  it("a token expiring within 3 days is listed with its rotate command; 3 days is not", async () => {
    for (const [days, listed] of [[0, true], [2, true], [3, false]] as const) {
      const { overview, health, d } = await setup({ checks: [{ ok: days >= 3, msg: "token", token_days: days }] });
      await health.report(d.scanner);
      const o = await overview();
      expect(codes(o).includes("token_expiring"), `${days} days`).toBe(listed);
      expect(o.github_token_days).toBe(days);
      if (listed) expect(o.system_actions.find((a) => a.code === "token_expiring")!.command).toBe("npm run setup -- --rotate-github");
    }
  });

  it("the overview poll makes no GitHub request and runs no health check; with no run yet the days are unknown", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response("{}");
    });
    const { overview, health, d, runs } = await setup({ checks: [{ ok: false, warn: true, msg: "token", token_days: 1 }] });
    const before = await overview();
    expect(before.github_token_days).toBe("unknown");
    expect(codes(before)).not.toContain("token_expiring");
    await health.report(d.scanner);
    for (let i = 0; i < 3; i++) {
      const o = await overview();
      expect(o.system_actions.find((a) => a.code === "token_expiring")?.text).toBe("The GitHub token expires in 1 day");
    }
    expect(requests).toBe(0);
    // Only the one report above ran the checks: the polls read its result.
    expect(runs()).toBe(1);
  });
});

describe("system actions: claim and worker pauses", () => {
  it("a claim pause in effect is listed with its end time and its resume command", async () => {
    const { overview, store, clock } = await setup();
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString() as Timestamp;
    await store.pauseClaims(until, "rate_limit");
    const o = await overview();
    expect(o.system_actions).toContainEqual({ code: "claim_pause", text: `Claim pause rate_limit in effect, until ${until}`, command: "factory resume rate_limit", until, work_item_id: null });
    expect(o.needs_you).toBe(1);
  });

  it("a worker pause is listed with `factory workers resume`, until it is resumed", async () => {
    const { overview, store } = await setup();
    await store.pauseWorkers({ all: true }, "local:me");
    expect((await overview()).system_actions).toEqual([
      { code: "worker_pause", text: "1 worker pause in effect (factory workers pause)", command: "factory workers resume", until: null, work_item_id: null },
    ]);
    await store.resumeWorkers();
    expect(codes(await overview())).toEqual([]);
  });
});

describe("system actions: claim deadlock", () => {
  it("is listed while the latest claim decision on the item's current run is a deadlock", async () => {
    const { overview, store, decisions, clock } = await setup();
    const { item } = await store.createWorkItem({ ...issue(5), title: "Overlapping" }, system);
    const cur = (await store.getWorkItem(item.id))!;
    await store.transition({ id: item.id, expected_version: cur.version, patch: { stage: "RUNNING" }, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "i" } });
    const run = (await store.claimRun({ worker_id: "host:1:0" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    const decide = (decision: string) =>
      decisions.set(item.id, [{
        run_id: run.id, work_item_id: item.id, decision, holder_work_item_id: null, holder_ref: "#92", holder_kind: "waiting",
        shared: [], cost: 4, threshold: 2.5, fallback: false, approved_by: null, at: clock.now().toISOString(),
      } as unknown as ClaimDecision]);

    decide("free");
    expect(codes(await overview())).toEqual([]);
    decide("deadlock");
    const o = await overview();
    expect(o.system_actions).toEqual([{
      code: "claim_deadlock", text: "Started past a deadlock with #92: a person checks the overlap", command: `factory status ${item.id}`, until: null, work_item_id: item.id,
    }]);
    expect(o.needs_you).toBe(1);
  });
});

describe("system actions: revisions", () => {
  it("a dashboard built from another revision than the server's is listed; an equal or absent one is not", async () => {
    const { overview } = await setup({ revision: REV_A });
    expect(codes(await overview(`?rev=${REV_A}`))).toEqual([]);
    expect(codes(await overview())).toEqual([]);
    const o = await overview(`?rev=${REV_B}`);
    expect(o.system_actions).toMatchObject([{ code: "revision_mismatch", text: "Dashboard out of date: it was built from bbbbbbb, the server runs aaaaaaa", command: "reload / restart `factory ui`" }]);
  });

  it("a UI server on another revision than the running factory is listed", async () => {
    const factory = { state: "running", rev: REV_B, target_rev: null, child_pid: 1, since: "x", workers: 1 } as FactoryStatus;
    const o = await (await setup({ revision: REV_A, factory })).overview();
    expect(o.system_actions).toMatchObject([{ code: "revision_mismatch", text: "UI server and factory differ: the UI runs aaaaaaa, the factory bbbbbbb", command: "restart the older: `factory ui` or `factory dev`" }]);
  });

  it("only a hex commit id counts as a dashboard revision", () => {
    expect(parseRevision(REV_A)).toBe(REV_A);
    expect(parseRevision("abc1234")).toBe("abc1234");
    expect(parseRevision("<script>")).toBeNull();
    expect(parseRevision(null)).toBeNull();
  });

  it("a hand-started UI server stops only when the factory runs a newer commit of the same line", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-rev-"));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "a");
      const a = git("rev-parse", "HEAD");
      git("commit", "-q", "--allow-empty", "-m", "b");
      const b = git("rev-parse", "HEAD");
      git("checkout", "-q", "-b", "side", a);
      git("commit", "-q", "--allow-empty", "-m", "c");
      const c = git("rev-parse", "HEAD");
      expect(await olderThanFactory(root, a, b)).toContain("the factory runs the newer");
      expect(await olderThanFactory(root, b, a)).toBeNull(); // this page is newer: keep serving
      expect(await olderThanFactory(root, c, b)).toBeNull(); // another branch: git cannot order them
      expect(await olderThanFactory(root, a, a)).toBeNull();
      expect(await olderThanFactory(root, null, b)).toBeNull();
      expect(await olderThanFactory(root, a, null)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

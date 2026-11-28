// Needs you's system actions (design §9 Status page, issue #311): a pending migration, a GitHub token expiring
// within 3 days, a claim or worker pause, and a revision mismatch, each with its command, in
// /api/v1/overview's `system_actions` and counted in `needs_you`. The poll asks GitHub nothing.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimDecision, Timestamp, UserId, WorkItemId, WorkerId } from "../src/core/types.js";
import { reconcileSourceId } from "../src/core/local-merge.js";
import type { FactoryStore, SchemaVersion } from "../src/interfaces/factory-store.js";
import { ALERT_DEDUPE_MS } from "../src/core/alarms.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { migrationPendingError } from "../src/interfaces/updater.js";
import type { Check } from "../src/setup.js";
import { HealthMonitor } from "../src/ui/health.js";
import type { FactoryStatus } from "../src/ui/factory-status.js";
import { type ApiDeps, respond } from "../src/ui/server.js";
import { LastChecks, REVISION_STAMP, olderThanFactory, parseRevision, serverRevision } from "../src/ui/system-actions.js";
import { recordAction } from "../src/outbound/intents.js";
import type { SqlDriver } from "../src/state/index.js";
import { buildRevision } from "../web/vite.config.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

const REV_A = "a".repeat(40);
const REV_B = "b".repeat(40);

interface Action {
  code: string; text: string; command: string; until: string | null; work_item_id: string | null; pause?: string;
  pattern?: string; error_code?: string; failing_tests?: string[]; output_tail?: string | null; detail?: string | null;
}
interface Overview { needs_you: number; unpushed_merges: number; system_actions: Action[]; server_rev: string | null; github_token_days: number | "unknown" | null }

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A real store behind a Proxy: `schemaVersion` and `listClaimDecisions` answer from the test. */
async function setup(opts: { backlogs?: { base_ref: string; waiting: number; conflicts: string[] | null }[]; version?: SchemaVersion | Error; checks?: Check[]; revision?: string | null; factory?: FactoryStatus | null } = {}) {
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
      if (prop === "listBasePushBacklogs" && opts.backlogs) return async () => opts.backlogs;
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
  it("an up-to-date store with no pause and equal revisions lists nothing", async () => {
    const { overview } = await setup({ revision: REV_A });
    const o = await overview(`?rev=${REV_A}`);
    expect(o.system_actions).toEqual([]);
    expect(o.needs_you).toBe(0);
    expect(o.server_rev).toBe(REV_A);
  });
});

describe("overview: unpushed local merges", () => {
  it("is the sum of waiting over all bases, and 0 when none wait", async () => {
    expect((await (await setup()).overview()).unpushed_merges).toBe(0);
    const backlogs = [{ base_ref: "main", waiting: 2, conflicts: null }, { base_ref: "dev", waiting: 1, conflicts: ["a.ts"] }];
    const o = await (await setup({ backlogs })).overview();
    expect(o.unpushed_merges).toBe(3);
    expect(o.needs_you).toBe(0);
  });
});

describe("system actions: pending migration", () => {
  it("a schema behind the code is listed with Migrate now and counts in needs_you", async () => {
    const { overview } = await setup({ version: { applied: 3, latest: 8 } });
    const o = await overview();
    expect(o.system_actions).toContainEqual({ code: "migration_pending", text: "Schema at version 3 of 8", command: "Migrate now, or factory migrate", until: null });
    expect(o.needs_you).toBe(1);
  });

  it("a store that refuses to open until migrate ran is listed too; another read error is not", async () => {
    expect(codes(await (await setup({ version: migrationPendingError("2 steps pending: run `npm run migrate`") })).overview())).toEqual(["migration_pending"]);
    expect(codes(await (await setup({ version: new Error("connect ECONNREFUSED") })).overview())).toEqual([]);
  });

  it("a supervisor whose update waits on the migration is listed", async () => {
    const factory = { state: "migration_pending", rev: REV_A, target_rev: REV_B, child_pid: 1, since: "x", pending: ["0031_x.sql"], workers: 1 } as FactoryStatus;
    const o = await (await setup({ factory })).overview();
    expect(o.system_actions).toMatchObject([{ code: "migration_pending", text: "The update to bbbbbbb waits for the migration (pending: 0031_x.sql)", command: "Migrate now, or factory migrate" }]);
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
  it("a claim pause in effect is listed by its plain name, its pause and end time, Needs you's Resume now first and its CLI command after", async () => {
    const { overview, store, clock } = await setup();
    const until = new Date(clock.now().getTime() + 3_600_000).toISOString() as Timestamp;
    await store.pauseClaims(until, "rate_limit");
    const o = await overview();
    const command = "Resume now in Needs you on Tasks, or factory resume rate_limit";
    expect(o.system_actions).toContainEqual({ code: "claim_pause", text: "Usage or rate limit", command, until, pause: "rate_limit" });
    expect(command.indexOf("Resume now")).toBeLessThan(command.indexOf("factory resume"));
    expect(o.needs_you).toBe(1);
  });

  it("model_stall's row is named \"Model not answering\" and until is its next probe; no text names the Status page", async () => {
    const { overview, store, clock } = await setup();
    const probe = new Date(clock.now().getTime() + 60_000).toISOString() as Timestamp;
    await store.pauseClaims(probe, "model_stall");
    const row = (await overview()).system_actions.find((a) => a.code === "claim_pause")!;
    expect(row).toMatchObject({ text: "Model not answering", pause: "model_stall", until: probe });
    expect(row.text).not.toMatch(/model_stall|Claim pause|\d{4}-\d{2}-\d{2}T/);
    expect(row.command).toContain("factory resume model_stall");
    expect(row.command).not.toContain("Status page");
  });

  // Bug: the missing model credential shows twice (its own row and a claim_pause row whose Resume now cannot end
  // it), or its row does not say how to fix it, or its text names a command the dashboard bans.
  it("a missing model credential is one row with the fix in its title, no command in it, and no Resume now; it goes once the pause ends", async () => {
    const { overview, store } = await setup();
    await store.pauseClaims("9999-12-31T23:59:59.999Z" as Timestamp, "model_credential");
    const o = await overview();
    expect(o.system_actions).toEqual([{ code: "model_credential", text: "Add a model credential", command: "Add model credential, or npm run setup", until: null }]);
    expect(o.system_actions[0]!.text).not.toMatch(/npm|`|run /);
    expect(o.needs_you).toBe(1);
    await store.endClaimPause("model_credential");
    expect(codes(await overview())).toEqual([]);
  });

  it("the owner pause (`factory stop`, the all-workers row) is a pause row with Resume now and `factory resume owner`, not a worker pause row", async () => {
    const { overview, store } = await setup();
    await store.pauseWorkers({ all: true }, "local:me");
    expect((await overview()).system_actions).toEqual([
      { code: "claim_pause", text: "Agents stopped", command: "Resume now in Needs you on Tasks, or factory resume owner", until: null, pause: "owner" },
    ]);
    await store.resumeWorkers();
    expect(codes(await overview())).toEqual([]);
  });

  it("a per-worker pause is listed with `factory workers resume`, until it is resumed", async () => {
    const { overview, store } = await setup();
    const { item } = await store.createWorkItem(issue(6), system);
    const cur = (await store.getWorkItem(item.id))!;
    await store.transition({ id: item.id, expected_version: cur.version, patch: { stage: "RUNNING" }, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "i" } });
    await store.claimRun({ worker_id: "host:1:0" as WorkerId, kinds: ["implement"], lease_ms: 60_000 });
    expect((await store.pauseWorkers({ count: 1 }, "local:me")).paused).toEqual(["host:1:0"]);
    expect((await overview()).system_actions).toEqual([
      { code: "worker_pause", text: "1 worker pause in effect (factory workers pause)", command: "factory workers resume", until: null },
    ]);
    await store.resumeWorkers();
    expect(codes(await overview())).toEqual([]);
  });
});

describe("system actions: claim deadlock", () => {
  it("is not listed: the run goes on and the item shows the sentence", async () => {
    const { overview, store, decisions, clock } = await setup();
    const { item } = await store.createWorkItem({ ...issue(5), title: "Overlapping" }, system);
    const cur = (await store.getWorkItem(item.id))!;
    await store.transition({ id: item.id, expected_version: cur.version, patch: { stage: "RUNNING" }, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: "i" } });
    const run = (await store.claimRun({ worker_id: "host:1:0" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    decisions.set(item.id, [{
      run_id: run.id, work_item_id: item.id, decision: "deadlock", holder_work_item_id: null, holder_ref: "#92", holder_kind: "waiting",
      shared: [], cost: 4, threshold: 2.5, fallback: false, approved_by: null, at: clock.now().toISOString(),
    } as unknown as ClaimDecision]);
    const o = await overview();
    expect(o.system_actions).toEqual([]);
    expect(o.needs_you).toBe(0);
  });
});

describe("system actions: open alarms", () => {
  it("each open alarm is listed and is its own Needs-you row: two alarms and the owner pause add 3 to needs_you", async () => {
    const { overview, store } = await setup();
    await store.recordAlert({ pattern: "repeated_error", pattern_key: "repeated_error:a", error_code: "checks_failed", count: 4, detail: null }, ALERT_DEDUPE_MS);
    await store.recordAlert({ pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: 3, detail: null }, ALERT_DEDUPE_MS);
    await store.pauseWorkers({ all: true }, "local:me");
    const o = await overview();
    expect(codes(o).filter((c) => c === "alarm")).toHaveLength(2);
    expect(codes(o)).toContain("claim_pause");
    expect(o.needs_you).toBe(3);
  });
});

describe("system actions: an alarm's pattern, error code and red-main output", () => {
  it("each alarm carries its pattern and error code; a red_main alarm carries the failing tests and tail its detail keeps, and its text stays the sentence", async () => {
    const { overview, store } = await setup();
    const detail = JSON.stringify({ text: "`npm test` exited 1 on the new tip of `main`", failing_tests: ["tests/a.test.ts > adds"], output_tail: "FAIL tests/a.test.ts > adds" });
    await store.recordAlert({ pattern: "red_main", pattern_key: "red_main:abc", error_code: "red_main", count: 1, detail }, ALERT_DEDUPE_MS);
    await store.recordAlert({ pattern: "repeated_error", pattern_key: "repeated_error:a", error_code: "checks_failed", count: 4, detail: null }, ALERT_DEDUPE_MS);
    const alarms = (await overview()).system_actions.filter((a) => a.code === "alarm");
    const red = alarms.find((a) => a.pattern === "red_main")!;
    expect(red).toMatchObject({ error_code: "red_main", failing_tests: ["tests/a.test.ts > adds"], output_tail: "FAIL tests/a.test.ts > adds" });
    expect(red.text).toBe("Alarm: the base branch fails its checks on its own at `abc`; merge-queue changes wait until it moves: `npm test` exited 1 on the new tip of `main`");
    const repeated = alarms.find((a) => a.pattern === "repeated_error")!;
    expect(repeated.error_code).toBe("checks_failed");
    expect(repeated).not.toHaveProperty("failing_tests");
  });

  it("a red_main alarm stored before the output was kept (plain text detail) carries no tests and a null tail", async () => {
    const { overview, store } = await setup();
    await store.recordAlert({ pattern: "red_main", pattern_key: "red_main:abc", error_code: "red_main", count: 1, detail: "`npm test` exited 1" }, ALERT_DEDUPE_MS);
    const red = (await overview()).system_actions.find((a) => a.code === "alarm")!;
    expect(red).toMatchObject({ pattern: "red_main", failing_tests: [], output_tail: null });
    expect(red.text).toMatch(/: `npm test` exited 1$/);
  });
});

describe("system actions: a failed chat check's alarm (issue #915)", () => {
  /** What row text never holds (design-system/writing.md, No code names): env var names, commands, doc paths. */
  const CODE_NAMES = /[A-Z][A-Z0-9_]{3,}|docs\/|npm run|§/;

  it("keeps its plain sentence as the row text, links Health, and carries the raw error only as its detail", async () => {
    const { overview, store } = await setup();
    const raw = "Chat check failed today: the run stopped with an error: the questions file (docs/eval.md §2) is missing CHAT_EVAL_QUESTIONS (run: npm run eval:chat).";
    await store.recordAlert({ pattern: "chat_eval_failed", pattern_key: "chat_eval_failed:2026-11-27", error_code: "run_error", count: 0, detail: raw }, ALERT_DEDUPE_MS);
    const row = (await overview()).system_actions.find((a) => a.code === "alarm")!;
    expect(row.text).toBe("Alarm: the daily chat check failed; chat answers may be broken until the cause is fixed");
    expect(row.text).not.toMatch(CODE_NAMES);
    expect(row.command).toContain("/app/health");
    expect(row.command).not.toMatch(CODE_NAMES);
    expect(row.detail).toBe(raw);
  });

  it("other alarms carry no separate detail: their sentence keeps it", async () => {
    const { overview, store } = await setup();
    await store.recordAlert({ pattern: "red_main", pattern_key: "red_main:abc", error_code: "red_main", count: 1, detail: "`npm test` exited 1" }, ALERT_DEDUPE_MS);
    expect((await overview()).system_actions.find((a) => a.code === "alarm")).not.toHaveProperty("detail");
  });
});

describe("system actions: the auto-stop alarm", () => {
  it("names the dashboard's Settings page and Turn auto back on first, `factory mode auto` after", async () => {
    const { overview, store } = await setup();
    await store.recordAlert({ pattern: "auto_stopped", pattern_key: "auto_stopped", error_code: "failure_alarm", count: 1, detail: null }, ALERT_DEDUPE_MS);
    const command = (await overview()).system_actions.find((a) => a.code === "alarm")!.command;
    expect(command).toContain("Turn auto back on in Settings (/app/settings)");
    expect(command.indexOf("/app/settings")).toBeLessThan(command.indexOf("factory mode auto"));
  });
});

describe("system actions: a local base whose reconcile with origin failed (design 05-sources, Base reconcile)", () => {
  /** One local merge's base push of `base`, as a delivered merge stores it; `delivered` is its outcome once pushed. */
  async function push(store: FactoryStore, clock: FakeClock, n: number, base: string, delivered?: { pushed: string } | { conflicts: string[]; remote?: string }) {
    const db = (store as unknown as { db: SqlDriver }).db;
    const { item } = await store.createWorkItem(issue(n), system);
    const key = `push_base:${item.id}:${n}`;
    const now = clock.now().toISOString();
    await recordAction(db, { action: "push_base", target: { type: "git", id: `local:${base}:push`, link: "" }, work_item_id: item.id, key, args: { base_ref: base, merge_sha: String(n), message: "m" } }, now);
    if (delivered) await db.run("UPDATE outbound_actions SET delivered_at = ?, delivered_ref = ? WHERE intent_key = ?", [now, JSON.stringify(delivered), key]);
  }
  /** The reconcile item of `base` at origin's `remote`, moved to `patch`. */
  async function reconcile(store: FactoryStore, base: string, remote: string, patch: Parameters<FactoryStore["transition"]>[0]["patch"]) {
    const { item } = await store.createWorkItem({ source: { type: "local", id: reconcileSourceId(base, remote), link: "" }, requester_id: system.id as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    await store.transition({ id: item.id, expected_version: item.version, patch, actor: system, reason: "seed" });
    return item.id;
  }
  const conflictRows = (o: Overview) => o.system_actions.filter((a) => a.code === "base_push_conflict");
  const R = "c".repeat(40);

  it("no row while the reconcile runs or before it is filed; one row once it waits on a person; a push that lands removes it", async () => {
    const { overview, store, clock } = await setup();
    await push(store, clock, 1, "main");
    expect(conflictRows(await overview())).toEqual([]);

    await push(store, clock, 2, "main", { conflicts: ["a.txt", "src/c.txt"], remote: R });
    // The reconcile does it by itself: nothing asks the owner.
    expect(conflictRows(await overview())).toEqual([]);
    const id = await reconcile(store, "main", R, { stage: "RUNNING" });
    expect(conflictRows(await overview())).toEqual([]);

    const item = (await store.getWorkItem(id))!;
    await store.transition({ id, expected_version: item.version, patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_conflict_pending" }, actor: system, reason: "resolve_failed" });
    const rows = conflictRows(await overview());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("The reconcile of local main with origin failed");
    expect(rows[0]!.command).toContain("a.txt, src/c.txt");
    expect(rows[0]!.command).toContain("2 local merges waiting");
    expect(rows[0]!.command).toContain(id);

    await push(store, clock, 3, "main", { pushed: "p" });
    expect(conflictRows(await overview())).toEqual([]);
  });

  it("a failed reconcile of another base names that base, and asks nothing for this one", async () => {
    const { overview, store, clock } = await setup();
    await push(store, clock, 1, "trunk", { conflicts: ["x.txt"], remote: R });
    await push(store, clock, 2, "main", { conflicts: ["y.txt"], remote: R });
    await reconcile(store, "trunk", R, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const rows = conflictRows(await overview());
    expect(rows.map((r) => r.text)).toEqual(["The reconcile of local trunk with origin failed"]);
    expect(rows[0]!.command).toContain("1 local merge waiting");
  });
});

describe("needs_you: the number of Needs-you rows (design 09-status-page)", () => {
  /** The levels the Tasks page's Needs you section lists (web/src/views/common.tsx `needsYou`): never stuck. */
  const WAITING = ["ready_to_merge", "needs_approval", "needs_you", "needs_triage"];

  /** An item moved to `patch` (a block on a person or the budget, or nothing). */
  async function item(store: FactoryStore, n: number, patch: Parameters<FactoryStore["transition"]>[0]["patch"]) {
    const { item } = await store.createWorkItem({ ...issue(n), title: `Item ${n}` }, system);
    await store.transition({ id: item.id, expected_version: item.version, patch, actor: system, reason: "seed" });
  }
  const alarm = (store: FactoryStore, code: string) =>
    store.recordAlert({ pattern: "repeated_error", pattern_key: `repeated_error:${code}`, error_code: code, count: 4, detail: null }, ALERT_DEDUPE_MS);

  /** The overview, checked against the rows the section lists for the same reads: the waiting items, then one per system action. */
  async function counted(s: Awaited<ReturnType<typeof setup>>) {
    await s.store.setSettingOverride({ key: "review_time", project: "", value: '""', actor: "local:owner" }); // every waiting item is a row: none held until review_time
    const o = await s.overview();
    const r = await respond(s.d, { method: "GET", url: "/api/v1/items", host: "127.0.0.1:4310" });
    const levels = (JSON.parse(r.body) as { items: { item_phase: string }[] }).items.map((i) => i.item_phase);
    expect(o.needs_you).toBe(levels.filter((l) => WAITING.includes(l)).length + o.system_actions.length);
    return { o, levels };
  }

  it("one waiting item and one open alarm give 2", async () => {
    const s = await setup();
    await item(s.store, 1, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    await alarm(s.store, "checks_failed");
    expect((await counted(s)).o.needs_you).toBe(2);
  });

  it("waiting items only: each item blocked on a person or the budget is one row; a stuck item (nothing moves it) is none", async () => {
    const s = await setup();
    await item(s.store, 1, { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    await item(s.store, 2, { stage: "RUNNING", blocked_on: "budget", blocked_reason: "budget_checkpoint" });
    await item(s.store, 3, { stage: "RUNNING" });
    const { o, levels } = await counted(s);
    expect(levels).toContain("stuck");
    expect(o.needs_you).toBe(2);
  });

  it("alarms only: two open alarms are two rows", async () => {
    const s = await setup();
    await alarm(s.store, "checks_failed");
    await alarm(s.store, "agent_error");
    expect((await counted(s)).o.needs_you).toBe(2);
  });

  it("non-alarm system actions: each counts once, and an alarm once more", async () => {
    const s = await setup({ version: { applied: 3, latest: 8 } });
    await s.store.pauseWorkers({ all: true }, "local:me");
    await s.store.pauseWorkers({ all: true }, "local:me");
    const before = await counted(s);
    expect(codes(before.o)).toEqual(["migration_pending", "claim_pause"]);
    expect(before.o.needs_you).toBe(2);
    await alarm(s.store, "checks_failed");
    expect((await counted(s)).o.needs_you).toBe(3);
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

  it("server_rev is the build stamp in dist/, not the checkout's HEAD: a docs-only move, a web/ change and an old page", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-stamp-"));
    try {
      const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
      const commit = (file: string, text: string) => {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), text);
        git("add", "-A");
        git("commit", "-q", "-m", file);
        return git("rev-parse", "HEAD");
      };
      // What a build does at the checkout's HEAD: scripts/build.mjs stamps dist/ (tests/build.test.ts), Vite builds the page's in.
      const buildServer = () => { mkdirSync(join(root, "dist"), { recursive: true }); writeFileSync(join(root, "dist", REVISION_STAMP), `${git("rev-parse", "HEAD")}\n`); };
      const buildPage = () => buildRevision(root)!;
      const overviewAt = async (page: string) => (await setup({ revision: await serverRevision(root) })).overview(`?rev=${page}`);
      git("init", "-q");
      const built = commit("web/app.ts", "1");
      buildServer();
      const page = buildPage();
      expect(page).toBe(built);

      // A docs-only move: the checkout moves, nothing is rebuilt, the server keeps its build's stamp.
      const moved = commit("docs/a.md", "docs");
      expect(git("rev-parse", "HEAD")).toBe(moved);
      expect(await serverRevision(root)).toBe(built);
      expect(codes(await overviewAt(page))).toEqual([]);

      // A real web/ change: rebuilt; the page loaded before it is older than its server and is told to reload.
      const changed = commit("web/app.ts", "2");
      buildServer();
      expect(await serverRevision(root)).toBe(changed);
      const old = await overviewAt(page);
      expect(old.system_actions).toEqual([expect.objectContaining({
        code: "revision_mismatch",
        text: `Dashboard out of date: it was built from ${page.slice(0, 7)}, the server runs ${changed.slice(0, 7)}`,
        command: "reload / restart `factory ui`",
      })]);
      // After a reload the page and the server carry the same build stamp.
      const reloaded = buildPage();
      expect(reloaded).toBe(changed);
      expect(codes(await overviewAt(reloaded))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a dist/ without a stamp (an older build) gives server_rev null and no banner", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-stamp-"));
    try {
      mkdirSync(join(root, "dist"));
      expect(await serverRevision(root)).toBeNull();
      writeFileSync(join(root, "dist", REVISION_STAMP), "not a revision\n");
      expect(await serverRevision(root)).toBeNull();
      const o = await (await setup({ revision: await serverRevision(root) })).overview(`?rev=${REV_B}`);
      expect(o.server_rev).toBeNull();
      expect(codes(o)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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

// The Data page's read API (design §9, issue #239): /api/v1/data/tables and /api/v1/data/tables/:name. Table
// and column names are checked against the store's catalog before any row is read; hidden columns never leave
// the server; every text cell passes the Withholder. Everything goes through respond(), without a socket.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { collectStats } from "../src/core/stats.js";
import type { UserId, WorkItemId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { HIDDEN_COLUMNS } from "../src/ui/data.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { human, issue, system } from "./helpers/store.js";

const LEASE = 60_000;
// Built here so no secret-shaped literal sits in the repository.
const SECRET = `ghp_${"Ab3".repeat(12)}`;
// Distinct values no other cell, count or id can hold by chance.
const RUN_TOKEN = 7391846250913;
const ATTEMPT_TOKEN = 6182735460192;
const LISTENER_TOKEN = 5073624351281;
const LINK_CODE = "ABCD-EFGH";
const LINK_HASH = createHash("sha256").update(LINK_CODE).digest("hex");

function get(d: UiDeps, path: string, method = "GET"): Promise<UiResponse> {
  return respond(d, { method, url: path, host: "127.0.0.1:4310" });
}

async function json<T = Record<string, unknown>>(d: UiDeps, path: string): Promise<T> {
  const r = await get(d, path);
  expect(r.status, `${path}: ${r.body}`).toBe(200);
  return JSON.parse(r.body) as T;
}

/** Every store method call by name, in order. */
function spied(s: FactoryStore, calls: string[]): FactoryStore {
  return new Proxy(s, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== "function") return v;
      return (...args: unknown[]) => {
        calls.push(String(prop));
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

async function seeded() {
  const clock = new FakeClock();
  const driver = new SqliteDriver(":memory:");
  const store = new SqlFactoryStore(driver, clock);
  await store.migrate();
  const plain = (await store.createWorkItem({ ...issue(1), title: "Plain item" }, system)).item;
  clock.advance(1000);
  const leaky = (await store.createWorkItem({ ...issue(2), title: `Leaky ${SECRET} title`, problem: `it's "quoted"` }, system)).item;
  clock.advance(1000);
  const r = await store.transition({ id: plain.id, expected_version: plain.version, patch: {}, actor: system, reason: "x", enqueue: { kind: "triage", idempotency_key: "t:1" } });
  if (!r.ok) throw new Error(r.reason);
  const run = (await store.claimRun({ worker_id: "host:1:0" as WorkerId, kinds: ["triage"], lease_ms: LEASE }))!;
  await store.acquireListenerLease("slack_thread", "replica-a", LEASE);
  await store.createLinkCode("github:1" as UserId, LINK_CODE);
  await driver.run("UPDATE worker_runs SET lease_token = ?", [RUN_TOKEN]);
  await driver.run("UPDATE worker_run_attempts SET lease_token = ?", [ATTEMPT_TOKEN]);
  await driver.run("UPDATE inbound_listener_leases SET token = ?", [LISTENER_TOKEN]);
  const calls: string[] = [];
  const d: UiDeps = {
    store: spied(store, calls),
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: LEASE,
    health: new HealthMonitor(async () => [], clock),
  };
  return { d, store, calls, plain, leaky, run };
}

interface Page {
  table: string;
  columns: string[];
  hidden: string[];
  rows: Record<string, string | number | null>[];
  total: number;
  page: number;
  limit: number;
  run_items: Record<string, string>;
}

describe("ui api: data tables", () => {
  it("/data/tables lists each table's name, row count and column names", async () => {
    const { d } = await seeded();
    const body = await json<{ tables: { name: string; rows: number; columns: string[]; hidden: string[] }[] }>(d, "/api/v1/data/tables");
    const by = new Map(body.tables.map((t) => [t.name, t]));
    for (const t of ["controller_work_items", "worker_runs", "worker_run_attempts", "controller_claim_decisions", "controller_file_conflicts", "identity_link_codes"]) expect(by.has(t), t).toBe(true);
    expect(by.get("controller_work_items")).toMatchObject({ rows: 2, hidden: [] });
    expect(by.get("controller_work_items")!.columns).toEqual(expect.arrayContaining(["id", "title", "created_at"]));
    expect(by.get("worker_runs")).toMatchObject({ rows: 1, hidden: ["lease_token"] });
    expect(by.get("identity_link_codes")).toMatchObject({ rows: 1, hidden: ["code_hash"] });
  });

  it("/data/tables/:name returns one page of rows, newest first, with the total, the page and the limit", async () => {
    const { d, plain, leaky } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/controller_work_items");
    expect(p).toMatchObject({ table: "controller_work_items", total: 2, page: 1, limit: 50 });
    expect(p.rows.map((r) => r.id)).toEqual([leaky.id, plain.id]);
    expect(Object.keys(p.rows[0]!)).toEqual(p.columns);
    const p2 = await json<Page>(d, "/api/v1/data/tables/controller_work_items?limit=1&page=2");
    expect(p2).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(p2.rows.map((r) => r.id)).toEqual([plain.id]);
    expect((await json<Page>(d, "/api/v1/data/tables/inbound_cursors?limit=999")).limit).toBe(200);
  });

  it("col= and val= filter on one column; a quote in the value matches as a bound parameter", async () => {
    const { d, leaky } = await seeded();
    const p = await json<Page>(d, `/api/v1/data/tables/controller_work_items?col=problem&val=${encodeURIComponent(`it's "quoted"`)}`);
    expect(p.total).toBe(1);
    expect(p.rows.map((r) => r.id)).toEqual([leaky.id]);
    const none = await json<Page>(d, `/api/v1/data/tables/controller_work_items?col=problem&val=${encodeURIComponent("x' OR '1'='1")}`);
    expect(none).toMatchObject({ total: 0, rows: [] });
  });

  it("a run id maps to the item that owns it", async () => {
    const { d, run, plain } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/worker_run_attempts");
    expect(p.rows[0]!.run_id).toBe(run.id);
    expect(p.run_items).toEqual({ [run.id]: plain.id });
  });

  it("an unknown table is a 404 with no row read: only the catalog is consulted", async () => {
    const { d, calls } = await seeded();
    for (const path of ["/api/v1/data/tables/nope", "/api/v1/data/tables/controller_work_items%3B%20DROP%20TABLE%20runs", "/api/v1/data/tables/%E0%A4%A"]) {
      calls.length = 0;
      const r = await get(d, path);
      expect(r.status, path).toBe(404);
      expect(JSON.parse(r.body), path).toHaveProperty("error");
      expect(calls.filter((c) => c !== "listTables"), path).toEqual([]);
    }
  });

  it("an unknown column in col= is a 404 with no row read", async () => {
    const { d, calls } = await seeded();
    calls.length = 0;
    const r = await get(d, "/api/v1/data/tables/controller_work_items?col=nope&val=1");
    expect(r.status).toBe(404);
    expect(calls).toEqual(["listTables"]);
  });

  it("a col= naming a hidden column is a 404 and no store call runs, so a hidden value cannot be probed", async () => {
    const { d, calls } = await seeded();
    for (const [table, cols] of Object.entries(HIDDEN_COLUMNS)) {
      for (const col of cols) {
        calls.length = 0;
        const r = await get(d, `/api/v1/data/tables/${table}?col=${col}&val=${RUN_TOKEN}`);
        expect(r.status, `${table}.${col}`).toBe(404);
        expect(calls, `${table}.${col}`).toEqual([]);
      }
    }
  });

  it("bad paging or a col without val is a 400", async () => {
    const { d } = await seeded();
    for (const q of ["page=0", "page=x", "limit=0", "limit=-1", "col=id", "val=1"]) {
      expect((await get(d, `/api/v1/data/tables/controller_work_items?${q}`)).status, q).toBe(400);
    }
  });

  it("hidden columns show as [hidden]; the seeded tokens and hash appear in no response", async () => {
    const { d, store } = await seeded();
    const tables = (await store.listTables()).map((t) => t.name);
    const bodies: string[] = [(await get(d, "/api/v1/data/tables")).body];
    for (const t of tables) bodies.push((await get(d, `/api/v1/data/tables/${t}`)).body);
    for (const b of bodies) {
      for (const v of [RUN_TOKEN, ATTEMPT_TOKEN, LISTENER_TOKEN, LINK_HASH]) expect(b).not.toContain(String(v));
    }
    for (const [table, cols] of Object.entries(HIDDEN_COLUMNS)) {
      const p = await json<Page>(d, `/api/v1/data/tables/${table}`);
      // Legacy copies (RFC 0015 §12) are empty in a new store; their hidden columns still never leave.
      if (!table.startsWith("legacy_")) expect(p.rows.length, table).toBeGreaterThan(0);
      for (const row of p.rows) for (const c of cols) expect(row[c], `${table}.${c}`).toBe("[hidden]");
    }
  });

  it("a secret-like text value shows as [withheld: <rule>] and its text is in no response", async () => {
    const { d, store, leaky } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/controller_work_items");
    expect(p.rows.find((r) => r.id === leaky.id)!.title).toBe("[withheld: github_token]");
    for (const t of (await store.listTables()).map((x) => x.name)) {
      const b = (await get(d, `/api/v1/data/tables/${t}`)).body;
      expect(b, t).not.toContain(SECRET);
      expect(b, t).not.toContain("Ab3Ab3");
    }
    // The filter value echoed back passes the Withholder too.
    const f = await get(d, `/api/v1/data/tables/controller_work_items?col=title&val=${encodeURIComponent(SECRET)}`);
    expect(f.status).toBe(200);
    expect(f.body).not.toContain(SECRET);
  });

  it("POST, PUT, PATCH and DELETE to each data route are 405 and make no store call", async () => {
    const { d, calls } = await seeded();
    calls.length = 0;
    for (const path of ["/api/v1/data/tables", "/api/v1/data/autonomy", "/api/v1/data/tables/controller_work_items", "/api/v1/data/tables/worker_runs?col=id&val=x"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await get(d, path, method);
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe("GET, HEAD");
      }
    }
    expect(calls).toEqual([]);
  });
});

describe("ui api: data autonomy (design §6)", () => {
  /** Merged factory items, `pushes` of them with a person's push; plus a rejected item with a push and an adopted merge. */
  async function withMerges(merged: number, pushes: number) {
    const s = await seeded();
    const { store } = s;
    const close = async (id: WorkItemId, version: number, close_reason: "completed" | "rejected") => {
      const r = await store.transition({ id, expected_version: version, actor: system, reason: "x", patch: { stage: "CLOSED", close_reason } });
      if (!r.ok) throw new Error(r.reason);
    };
    const push = async (id: WorkItemId, version: number, head: string) => {
      const r = await store.recordVerdict({
        id, expected_version: version, actor: system, verdict: "changes", severity: "critical",
        reason: "a person pushed", comment_id: `implicit:${head}`, target: "pr", implicit: true, pr_head: head,
      });
      if (!r.ok) throw new Error(r.reason);
    };
    for (let i = 0; i < merged; i++) {
      const { item } = await store.createWorkItem(issue(100 + i), system);
      if (i < pushes) await push(item.id, 1, `h${i}`);
      await close(item.id, i < pushes ? 2 : 1, "completed");
    }
    const rejected = (await store.createWorkItem(issue(200), system)).item;
    await push(rejected.id, 1, "hr");
    await close(rejected.id, 2, "rejected");
    const adopted = (await store.createWorkItem({
      ...issue(201), adopted: { change_ref: "201", head_branch: "f", head_sha: "h", allowed_paths: ["a"], tier: 1 },
    }, human)).item;
    await close(adopted.id, 1, "completed");
    return s;
  }

  it("returns { as_of, merged, with_push, autonomy } with the same numbers as factory stats --json", async () => {
    const { d, store, calls } = await withMerges(4, 1);
    calls.length = 0;
    const body = await json(d, "/api/v1/data/autonomy");
    expect(body).toEqual({ as_of: expect.any(String), merged: 4, with_push: 1, autonomy: 0.75 });
    const report = JSON.parse(JSON.stringify(await collectStats(store, { weights: { none: 0, minor: 1, major: 3, critical: 10 }, min_sample: 1 })));
    expect({ merged: body.merged, with_push: body.with_push, autonomy: body.autonomy }).toEqual(report.autonomy);
    expect(calls).toEqual(["listStatsRecords"]);
  });

  it("autonomy is null with no merged factory item", async () => {
    const { d } = await withMerges(0, 0);
    expect(await json(d, "/api/v1/data/autonomy")).toMatchObject({ merged: 0, with_push: 0, autonomy: null });
  });

  it("writes nothing: no transition, migrate or write runs, and the tables are unchanged", async () => {
    const { d, calls } = await withMerges(2, 1);
    const before = await get(d, "/api/v1/data/tables");
    calls.length = 0;
    await json(d, "/api/v1/data/autonomy");
    expect(calls.every((c) => c.startsWith("list") || c.startsWith("get"))).toBe(true);
    expect(calls.filter((c) => /transition|migrate|record|create|update|complete|claim/.test(c))).toEqual([]);
    expect((await get(d, "/api/v1/data/tables")).body).toBe(before.body);
  });
});

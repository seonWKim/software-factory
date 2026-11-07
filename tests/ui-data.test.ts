// The Data page's read API (design §9, issue #239): /api/v1/data/tables and /api/v1/data/tables/:name. Table
// and column names are checked against the store's catalog before any row is read; hidden columns never leave
// the server; every text cell passes the Withholder. Everything goes through respond(), without a socket.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UserId, WorkerId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { HIDDEN_COLUMNS } from "../src/ui/data.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, type UiResponse, respond } from "../src/ui/server.js";
import { issue, system } from "./helpers/store.js";

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
  await driver.run("UPDATE runs SET lease_token = ?", [RUN_TOKEN]);
  await driver.run("UPDATE run_attempts SET lease_token = ?", [ATTEMPT_TOKEN]);
  await driver.run("UPDATE listener_leases SET token = ?", [LISTENER_TOKEN]);
  const calls: string[] = [];
  const d: UiDeps = {
    store: spied(store, calls),
    scanner: new PatternEgressScanner(async () => []),
    clock,
    lease_ms: LEASE,
    prUrl: (project, n) => `https://github.com/${project}/pull/${n}`,
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
    for (const t of ["work_items", "runs", "run_attempts", "claim_decisions", "file_conflicts", "link_codes"]) expect(by.has(t), t).toBe(true);
    expect(by.get("work_items")).toMatchObject({ rows: 2, hidden: [] });
    expect(by.get("work_items")!.columns).toEqual(expect.arrayContaining(["id", "title", "created_at"]));
    expect(by.get("runs")).toMatchObject({ rows: 1, hidden: ["lease_token"] });
    expect(by.get("link_codes")).toMatchObject({ rows: 1, hidden: ["code_hash"] });
  });

  it("/data/tables/:name returns one page of rows, newest first, with the total, the page and the limit", async () => {
    const { d, plain, leaky } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/work_items");
    expect(p).toMatchObject({ table: "work_items", total: 2, page: 1, limit: 50 });
    expect(p.rows.map((r) => r.id)).toEqual([leaky.id, plain.id]);
    expect(Object.keys(p.rows[0]!)).toEqual(p.columns);
    const p2 = await json<Page>(d, "/api/v1/data/tables/work_items?limit=1&page=2");
    expect(p2).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(p2.rows.map((r) => r.id)).toEqual([plain.id]);
    expect((await json<Page>(d, "/api/v1/data/tables/cursors?limit=999")).limit).toBe(200);
  });

  it("col= and val= filter on one column; a quote in the value matches as a bound parameter", async () => {
    const { d, leaky } = await seeded();
    const p = await json<Page>(d, `/api/v1/data/tables/work_items?col=problem&val=${encodeURIComponent(`it's "quoted"`)}`);
    expect(p.total).toBe(1);
    expect(p.rows.map((r) => r.id)).toEqual([leaky.id]);
    const none = await json<Page>(d, `/api/v1/data/tables/work_items?col=problem&val=${encodeURIComponent("x' OR '1'='1")}`);
    expect(none).toMatchObject({ total: 0, rows: [] });
  });

  it("a run id maps to the item that owns it", async () => {
    const { d, run, plain } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/run_attempts");
    expect(p.rows[0]!.run_id).toBe(run.id);
    expect(p.run_items).toEqual({ [run.id]: plain.id });
  });

  it("an unknown table is a 404 with no row read: only the catalog is consulted", async () => {
    const { d, calls } = await seeded();
    for (const path of ["/api/v1/data/tables/nope", "/api/v1/data/tables/work_items%3B%20DROP%20TABLE%20runs", "/api/v1/data/tables/%E0%A4%A"]) {
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
    const r = await get(d, "/api/v1/data/tables/work_items?col=nope&val=1");
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
      expect((await get(d, `/api/v1/data/tables/work_items?${q}`)).status, q).toBe(400);
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
      expect(p.rows.length, table).toBeGreaterThan(0);
      for (const row of p.rows) for (const c of cols) expect(row[c], `${table}.${c}`).toBe("[hidden]");
    }
  });

  it("a secret-like text value shows as [withheld: <rule>] and its text is in no response", async () => {
    const { d, store, leaky } = await seeded();
    const p = await json<Page>(d, "/api/v1/data/tables/work_items");
    expect(p.rows.find((r) => r.id === leaky.id)!.title).toBe("[withheld: github_token]");
    for (const t of (await store.listTables()).map((x) => x.name)) {
      const b = (await get(d, `/api/v1/data/tables/${t}`)).body;
      expect(b, t).not.toContain(SECRET);
      expect(b, t).not.toContain("Ab3Ab3");
    }
    // The filter value echoed back passes the Withholder too.
    const f = await get(d, `/api/v1/data/tables/work_items?col=title&val=${encodeURIComponent(SECRET)}`);
    expect(f.status).toBe(200);
    expect(f.body).not.toContain(SECRET);
  });

  it("POST, PUT, PATCH and DELETE to each data route are 405 and make no store call", async () => {
    const { d, calls } = await seeded();
    calls.length = 0;
    for (const path of ["/api/v1/data/tables", "/api/v1/data/tables/work_items", "/api/v1/data/tables/runs?col=id&val=x"]) {
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const r = await get(d, path, method);
        expect(r.status, `${method} ${path}`).toBe(405);
        expect(r.headers.allow).toBe("GET, HEAD");
      }
    }
    expect(calls).toEqual([]);
  });
});

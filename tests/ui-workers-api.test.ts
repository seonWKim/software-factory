// The Workers page's reads (design 09-dashboard-workers) over a store fake that has only the read methods the routes
// may use: GET /api/v1/runs unchanged without a window and with the finished runs, item titles and stages with one,
// GET /api/v1/items/graph's nodes and edges for the window, the Withholder on titles and blocked reasons, and 400s.

import { describe, expect, it } from "vitest";
import type { DependencyEdge, Run, RunOutcome, Timestamp, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type UiDeps, respond } from "../src/ui/server.js";

const NOW = "2026-11-20T12:00:00.000Z";
const HOUR = 3_600_000;
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString() as Timestamp;

/** A store fake with items, runs and edges in memory and only the reads the two routes use. Anything else throws. */
function fakeStore() {
  const items = new Map<WorkItemId, WorkItem>();
  const runs: Run[] = [];
  const edges: DependencyEdge[] = [];
  const reads = {
    async getWorkItem(id: WorkItemId) { return items.get(id) ?? null; },
    async listRunsByStatus(statuses: readonly string[]) { return runs.filter((r) => statuses.includes(r.status)); },
    async listRunsFinishedWithin(ms: number) { return runs.filter((r) => r.finished_at !== null && Date.parse(r.finished_at) >= Date.parse(NOW) - ms); },
    async listWorkItemsWhere(f: { stage?: string; exclude_closed?: boolean; updated_since?: Timestamp }) {
      return [...items.values()].filter((i) => (!f.stage || i.stage === f.stage) && (!f.exclude_closed || f.stage || i.stage !== "CLOSED") && (!f.updated_since || i.updated_at >= f.updated_since));
    },
    async listDependencyEdges() { return edges; },
  };
  const store = new Proxy(reads, {
    get: (t, k) => (k in t ? t[k as keyof typeof t] : () => { throw new Error(`write or unexpected read: ${String(k)}`); }),
  }) as unknown as FactoryStore;
  return {
    store,
    item(id: string, over: Partial<WorkItem> = {}) {
      items.set(id as WorkItemId, { id, title: `Title ${id}`, stage: "RUNNING", blocked_reason: null, parent_id: null, source: { type: "local", id: `src-${id}`, link: "" }, updated_at: NOW, ...over } as WorkItem);
    },
    run(id: string, item: string, over: Partial<Run> = {}) {
      runs.push({ id, work_item_id: item, kind: "implement", status: "succeeded", attempt: 1, lease: null, outcome: null, started_at: ago(2 * HOUR), finished_at: ago(HOUR), created_at: ago(3 * HOUR), updated_at: ago(HOUR), ...over } as Run);
    },
    edge(dependent: string, dependsOnSource: string) {
      edges.push({ work_item_id: dependent as WorkItemId, depends_on: dependsOnSource, kind: "blocked_by", state: "open", source_updated_at: null, created_at: NOW, updated_at: NOW } as DependencyEdge);
    },
  };
}

function deps(store: FactoryStore): UiDeps {
  const clock = new FakeClock(NOW);
  return { store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 60_000, health: new HealthMonitor(async () => [], clock) };
}

async function get(d: UiDeps, url: string) {
  const r = await respond(d, { method: "GET", url, host: "127.0.0.1:4310" });
  return { status: r.status, body: JSON.parse(r.body!) as Record<string, any> };
}

const failed = (code: string): RunOutcome => ({ status: "failed", error_code: code, detail: "", infra: false, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.42, model: "opus" } });

describe("GET /api/v1/runs", () => {
  function seeded() {
    const f = fakeStore();
    f.item("wi_a", { title: "Alpha" });
    f.item("wi_s", { title: `leak ${SECRET}` });
    f.run("r_run", "wi_a", { status: "running", started_at: ago(HOUR), finished_at: null });
    f.run("r_q", "wi_a", { status: "queued", started_at: null, finished_at: null });
    f.run("r_done", "wi_s", { status: "failed", started_at: ago(2 * HOUR), finished_at: ago(HOUR), outcome: failed("checks_failed") });
    f.run("r_old", "wi_a", { status: "succeeded", started_at: ago(30 * HOUR), finished_at: ago(25 * HOUR) });
    return f;
  }

  it("with no window returns the running and queued runs as before, with no item fields", async () => {
    const { status, body } = await get(deps(seeded().store), "/api/v1/runs");
    expect(status).toBe(200);
    expect(body.runs.map((r: { id: string }) => r.id)).toEqual(["r_run", "r_q"]);
    expect(Object.keys(body.runs[0])).toEqual(["id", "status", "kind", "work_item_id", "attempt", "owner", "heartbeat_at", "started_at", "lease_expires_at", "created_at"]);
    expect(body.window).toBeUndefined();
  });

  it("with a window adds the runs finished in it, each with its item's title and stage, error code, model and cost", async () => {
    const { status, body } = await get(deps(seeded().store), "/api/v1/runs?window=6h");
    expect(status).toBe(200);
    expect(body.window).toBe("6h");
    const ids = body.runs.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(["r_run", "r_q", "r_done"]));
    expect(ids).not.toContain("r_old");
    const running = body.runs.find((r: { id: string }) => r.id === "r_run");
    expect(running).toMatchObject({ item_title: "Alpha", item_stage: "RUNNING", error_code: null, model: null, cost_usd: null, finished_at: null });
    const done = body.runs.find((r: { id: string }) => r.id === "r_done");
    expect(done).toMatchObject({ work_item_id: "wi_s", error_code: "checks_failed", model: "opus", cost_usd: 0.42, finished_at: ago(HOUR) });
    expect(done.item_title).toMatch(/^\[withheld: /);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("the 24h window reaches further back", async () => {
    const { body } = await get(deps(seeded().store), "/api/v1/runs?window=24h");
    expect(body.runs.map((r: { id: string }) => r.id)).not.toContain("r_old");
    const { body: hour } = await get(deps(seeded().store), "/api/v1/runs?window=1h");
    expect(hour.runs.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(["r_run", "r_q", "r_done"]));
  });

  it("any other window is a 400", async () => {
    for (const w of ["7d", "", "6H", "1"]) {
      const { status, body } = await get(deps(seeded().store), `/api/v1/runs?window=${w}`);
      expect(status, w).toBe(400);
      expect(body.error).toMatch(/1h, 6h or 24h/);
    }
  });
});

describe("GET /api/v1/items/graph", () => {
  function seeded() {
    const f = fakeStore();
    f.item("wi_base", { title: "Base" });
    f.item("wi_dep", { title: "Needs base", stage: "READY", blocked_reason: "dependency_pending" });
    f.item("wi_alone", { title: "Alone" });
    f.item("wi_closed", { title: "Closed lately", stage: "CLOSED", updated_at: ago(HOUR) });
    f.item("wi_gone", { title: "Closed long ago", stage: "CLOSED", updated_at: ago(30 * HOUR) });
    f.item("wi_parent", { title: "Split" });
    f.item("wi_p1", { title: "Phase 1", parent_id: "wi_parent" as WorkItemId });
    f.item("wi_secret", { title: `t ${SECRET}`, blocked_reason: `r ${SECRET}` });
    f.edge("wi_dep", "src-wi_base");
    f.edge("wi_dep", "src-wi_closed");
    f.edge("wi_dep", "src-wi_gone"); // the other end is not a node in the window
    f.edge("wi_dep", "o/r#999"); // no such item at all
    f.edge("wi_secret", "src-wi_base");
    return f;
  }

  it("returns nodes for open items and items closed in the window, with stage and blocked reason", async () => {
    const { status, body } = await get(deps(seeded().store), "/api/v1/items/graph?window=6h");
    expect(status).toBe(200);
    const ids = body.nodes.map((n: { id: string }) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["wi_base", "wi_dep", "wi_alone", "wi_closed", "wi_parent", "wi_p1"]));
    expect(ids).not.toContain("wi_gone");
    expect(body.nodes.find((n: { id: string }) => n.id === "wi_dep")).toEqual({ id: "wi_dep", title: "Needs base", stage: "READY", blocked_reason: "dependency_pending" });
  });

  it("returns dependency edges and split parent to phase edges, leaving out an edge whose other end is not a node", async () => {
    const { body } = await get(deps(seeded().store), "/api/v1/items/graph?window=6h");
    expect(body.edges).toEqual(expect.arrayContaining([
      { from: "wi_base", to: "wi_dep", kind: "dependency" },
      { from: "wi_closed", to: "wi_dep", kind: "dependency" },
      { from: "wi_parent", to: "wi_p1", kind: "phase" },
    ]));
    const ends = body.edges.flatMap((e: { from: string; to: string }) => [e.from, e.to]);
    expect(ends).not.toContain("wi_gone");
    const ids = new Set(body.nodes.map((n: { id: string }) => n.id));
    for (const e of body.edges) expect(ids.has(e.from) && ids.has(e.to)).toBe(true);
  });

  it("titles and blocked reasons pass the Withholder; the item id still shows", async () => {
    const { body } = await get(deps(seeded().store), "/api/v1/items/graph?window=24h");
    const n = body.nodes.find((x: { id: string }) => x.id === "wi_secret");
    expect(n.title).toMatch(/^\[withheld: /);
    expect(n.blocked_reason).toMatch(/^\[withheld: /);
    expect(JSON.stringify(body)).not.toContain(SECRET);
  });

  it("is not read as an item id, and any other window is a 400", async () => {
    const { status } = await get(deps(seeded().store), "/api/v1/items/graph");
    expect(status).toBe(200);
    for (const w of ["7d", "x"]) expect((await get(deps(seeded().store), `/api/v1/items/graph?window=${w}`)).status).toBe(400);
  });

  it("is read-only: a POST is refused", async () => {
    const r = await respond(deps(seeded().store), { method: "POST", url: "/api/v1/items/graph?window=6h", host: "127.0.0.1:4310" });
    expect(r.status).not.toBe(200);
  });
});

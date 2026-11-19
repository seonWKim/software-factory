// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
// The Workers page's pure layout (design 09-dashboard-workers): lane packing by start time (overlapping runs never
// share a lane, and the lane count is the most runs at once), runs left out with no start time, the graph's layers
// (each dependent right of its prerequisite, a cycle that does not hang), the count of items with no dependencies,
// and what each tooltip says (an unknown field left out, never shown as 0).
import { describe, expect, it } from "vitest";
import { KIND_CATEGORIES, connectedNodes, kindCategory, layerOrder, packLanes, timelineSpans } from "../web/src/views/workers-layout.js";
import { nodeTipLines, runTipLines } from "../web/src/views/workers.js";

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

/** The most spans running at one moment, by a sweep over their starts and ends (an end before a start at the same time). */
function mostAtOnce(spans: readonly { start: number; end: number }[]): number {
  const events = spans.flatMap((s) => [[s.start, 1], [s.end, -1]] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let now = 0, most = 0;
  for (const [, d] of events) most = Math.max(most, (now += d));
  return most;
}

describe("lane packing", () => {
  it("puts overlapping runs in different lanes and reuses a lane once its run has ended", () => {
    const runs = [
      { id: "a", start: 0, end: 10 },
      { id: "b", start: 5, end: 15 },
      { id: "c", start: 10, end: 20 }, // starts as a ends: a's lane is free again
      { id: "d", start: 6, end: 8 },
    ];
    const { placed, lanes } = packLanes(runs);
    const lane = Object.fromEntries(placed.map((p) => [p.run.id, p.lane]));
    expect(lane.a).not.toBe(lane.b);
    expect(lane.d).not.toBe(lane.a);
    expect(lane.d).not.toBe(lane.b);
    expect(lane.c).toBe(lane.a);
    expect(lanes).toBe(mostAtOnce(runs));
  });

  it("over many runs no two overlapping runs share a lane, and the lane count is the most running at once", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 20; round++) {
      const runs = Array.from({ length: 40 }, (_, i) => {
        const start = Math.floor(rand() * 1000);
        return { id: `r${i}`, start, end: start + 1 + Math.floor(rand() * 200) };
      });
      const { placed, lanes } = packLanes(runs);
      expect(placed.map((p) => p.run.id).sort()).toEqual(runs.map((r) => r.id).sort());
      for (const p of placed) for (const q of placed) if (p !== q && p.lane === q.lane) expect(overlaps(p.run, q.run), `${p.run.id} ${q.run.id}`).toBe(false);
      expect(lanes).toBe(mostAtOnce(runs));
    }
  });

  it("places runs in start order whatever the input order", () => {
    const { placed } = packLanes([{ start: 20, end: 30 }, { start: 0, end: 5 }]);
    expect(placed.map((p) => p.run.start)).toEqual([0, 20]);
    expect(placed.map((p) => p.lane)).toEqual([0, 0]);
  });
});

describe("timeline spans", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
  it("leaves out runs with no start time and counts them, leaves out queued runs, ends a running run now and cuts the window's start", () => {
    const { spans, leftOut } = timelineSpans([
      { id: "run", status: "running", started_at: at(1), finished_at: null },
      { id: "nostart", status: "failed", started_at: null, finished_at: at(1) },
      { id: "queued", status: "queued", started_at: null, finished_at: null },
      { id: "early", status: "succeeded", started_at: at(8), finished_at: at(5) },
      { id: "old", status: "succeeded", started_at: at(9), finished_at: at(7) },
    ], now, 6 * 3_600_000);
    expect(leftOut).toBe(1);
    expect(spans.map((s) => s.run.id)).toEqual(["run", "early"]);
    expect(spans[0].end).toBe(now);
    expect(spans[1].start).toBe(now - 6 * 3_600_000);
  });
});

describe("run kind categories", () => {
  it("are the six categories, other holding update, manual, interactive and improve", () => {
    expect(KIND_CATEGORIES).toEqual(["triage", "implement", "review", "resolve", "merge-check", "other"]);
    for (const k of ["triage", "implement", "review", "resolve", "merge-check"]) expect(kindCategory(k)).toBe(k);
    for (const k of ["update", "manual", "interactive", "improve"]) expect(kindCategory(k)).toBe("other");
  });
});

describe("graph layers", () => {
  it("puts each dependent in a layer right of its prerequisite", () => {
    const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "a", to: "c" }, { from: "d", to: "c" }];
    const { layer, row } = layerOrder(["c", "b", "a", "d"], edges);
    for (const e of edges) expect(layer.get(e.to)!, `${e.from} -> ${e.to}`).toBeGreaterThan(layer.get(e.from)!);
    expect(layer.get("a")).toBe(0);
    expect(layer.get("d")).toBe(0);
    // Two in one layer get two rows.
    expect(row.get("a")).not.toBe(row.get("d"));
  });

  it("does not hang on a cycle and still places every node", () => {
    const { layer, layers } = layerOrder(["x", "y", "z", "w"], [{ from: "x", to: "y" }, { from: "y", to: "z" }, { from: "z", to: "x" }, { from: "z", to: "w" }]);
    expect([...layer.keys()].sort()).toEqual(["w", "x", "y", "z"]);
    expect(layers).toBeGreaterThan(0);
    expect(layer.get("w")!).toBeGreaterThan(layer.get("z")!);
  });

  it("ignores edges to ids it was not given", () => {
    const { layer } = layerOrder(["a"], [{ from: "gone", to: "a" }]);
    expect(layer.get("a")).toBe(0);
  });
});

describe("items with no dependencies", () => {
  it("are left out of the graph and counted", () => {
    const nodes = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }];
    const { nodes: kept, alone } = connectedNodes(nodes, [{ from: "a", to: "b" }]);
    expect(kept.map((n) => n.id)).toEqual(["a", "b"]);
    expect(alone).toBe(3);
  });
});

describe("tooltips", () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const base = { id: "r1", kind: "implement", work_item_id: "wi_1", attempt: 1, created_at: "2026-11-20T09:00:00.000Z", item_title: "Add the page", item_stage: "RUNNING", error_code: null, model: null, cost_usd: null };

  it("a finished failed run: title, id, kind and status, started, finished, duration, error, model and cost", () => {
    const lines = runTipLines({ ...base, status: "failed", started_at: "2026-11-20T10:00:00.000Z", finished_at: "2026-11-20T11:30:00.000Z", error_code: "checks_failed", model: "opus", cost_usd: 0.5 }, now);
    expect(lines[0]).toBe("Add the page");
    expect(lines[1]).toBe("wi_1");
    expect(lines[2]).toBe("implement, Failed");
    expect(lines.some((l) => l.startsWith("Started "))).toBe(true);
    expect(lines.some((l) => l.startsWith("Finished "))).toBe(true);
    expect(lines).toContain("Took 1h 30m");
    expect(lines.some((l) => l.startsWith("Error: "))).toBe(true);
    expect(lines).toContain("Model: opus");
    expect(lines).toContain("Cost: $0.50");
    expect(lines.some((l) => l.startsWith("Running for"))).toBe(false);
  });

  it("a running run says how long it has run, and leaves out what is unknown instead of showing 0", () => {
    const lines = runTipLines({ ...base, status: "running", started_at: "2026-11-20T11:00:00.000Z", finished_at: null, item_title: null }, now);
    expect(lines[0]).toBe("Untitled item");
    expect(lines).toContain("Running for 1h");
    for (const gone of ["Finished", "Took", "Error", "Model", "Cost"]) expect(lines.some((l) => l.startsWith(gone)), gone).toBe(false);
    expect(lines.join(" ")).not.toMatch(/\$0|\b0s\b/);
  });

  it("a withheld title shows its marker and the item id still shows", () => {
    const lines = runTipLines({ ...base, status: "succeeded", started_at: null, finished_at: "2026-11-20T11:00:00.000Z", item_title: "[withheld: github_token]" }, now);
    expect(lines.slice(0, 2)).toEqual(["[withheld: github_token]", "wi_1"]);
    expect(lines.some((l) => l.startsWith("Took"))).toBe(false);
  });

  it("a node: title, id, stage and blocked reason", () => {
    expect(nodeTipLines({ id: "wi_2", title: "Base work", stage: "READY", blocked_reason: "spec_pending" })).toEqual(["Base work", "wi_2", "Stage: specced, not started", "Blocked: spec pending"]);
    expect(nodeTipLines({ id: "wi_3", title: null, stage: "CLOSED", blocked_reason: null })).toEqual(["Untitled item", "wi_3", "Stage: closed"]);
  });
});

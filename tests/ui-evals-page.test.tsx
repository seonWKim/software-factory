// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalComparison, EvalRun, EvalRunSummary } from "../web/src/api/evals.js";
import { BASE, evalsRoute, routeFor } from "../web/src/pages.js";
import { EvalsPage, skillName } from "../web/src/views/evals.js";

// The evals page at evals/<skill> (design 09-dashboard-evals): Trend, Grid and Compare in that order, "no run" in an
// empty grid cell, plain words only (no run, suite or skill ID), no control that starts a run. The reads are a fake fetch.

const SLOW = { timeout: 5_000 };
const SKILL = "skills/review-plan/SKILL.md";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const run = (id: string, day: number, over: Partial<EvalRun> = {}): EvalRun => ({
  id, status: "passed", started_at: `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`, skill_version: "sha-old", model_class: "standard",
  judge_model_class: "cheap", replays: 20, pass_rate: 0.5, errored: 0, ...over,
});
const summary = ({ id, ...rest }: EvalRun): EvalRunSummary => ({ run_id: id, ...rest });

// Newest first, as the route gives them.
const RUNS: EvalRun[] = [
  run("run_zzz9", 20, { pass_rate: 0.9, skill_version: "sha-new", model_class: "standard" }),
  run("run_yyy8", 18, { pass_rate: null, replays: null, model_class: null, skill_version: null }),
  run("run_xxx7", 15, { pass_rate: 0.6, model_class: "strong" }),
  run("run_www6", 10, { pass_rate: 0.5, model_class: "standard" }),
];
const GRID = [RUNS[0]!, RUNS[2]!].map(summary);

let runs: EvalRun[] = RUNS;
let grid: EvalRunSummary[] = GRID;
let comparison: EvalComparison | null = null;
let fail = false;
let urls: string[] = [];

beforeEach(() => {
  urls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    const enc = encodeURIComponent(SKILL);
    if (fail) return json(500, { error: "boom" });
    if (url === `/api/v1/evals/${enc}/runs`) return json(200, { runs });
    if (url === `/api/v1/evals/${enc}/grid`) return json(200, { rows: grid });
    if (url.startsWith(`/api/v1/evals/${enc}/compare?`)) {
      const q = new URL(url, "http://x").searchParams;
      const pick = (id: string | null) => summary(runs.find((r) => r.id === id)!);
      return json(200, comparison ?? { a: pick(q.get("a")), b: pick(q.get("b")), gap: 0.4, noise_band: 0.22, within_noise: false });
    }
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  runs = RUNS;
  grid = GRID;
  comparison = null;
  fail = false;
  cleanup();
  vi.unstubAllGlobals();
});

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(EvalsPage, { skill: SKILL })));
}

describe("evals route", () => {
  it("parses evals/<skill> with the skill URL-encoded, and nothing else", () => {
    expect(evalsRoute(`${BASE}evals/${encodeURIComponent(SKILL)}`)).toBe(SKILL);
    expect(evalsRoute(`${BASE}evals/${encodeURIComponent(SKILL)}/`)).toBe(SKILL);
    expect(evalsRoute(`${BASE}evals/${encodeURIComponent(SKILL)}?x=1#y`)).toBe(SKILL);
    expect(evalsRoute(`${BASE}evals`)).toBeNull();
    expect(evalsRoute(`${BASE}evals/%E0%A4%A`)).toBeNull();
    expect(evalsRoute(`${BASE}items/wi_1`)).toBeNull();
    // The page is not a sidebar page: its path still routes to Tasks there.
    expect(routeFor(`${BASE}evals/x`).page.path).toBe("tasks");
  });

  it("names the skill by its folder, not its file", () => {
    expect(skillName(SKILL)).toBe("review-plan");
    expect(skillName("review-plan")).toBe("review-plan");
  });
});

describe("evals page", () => {
  it("shows Trend, Grid and Compare in that order under the skill's name, with no control that starts a run", async () => {
    const { container } = show();
    await screen.findByRole("region", { name: "Compare two runs" }, SLOW);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("review-plan");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Pass rate over time", "Latest run per version and model class", "Compare two runs"]);
    expect(screen.queryByRole("button", { name: /run now/i })).toBeNull();
    expect(container.textContent).not.toMatch(/run now/i);
    // The only controls are the two pickers.
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("combobox")).toHaveLength(2);
  });

  it("draws Trend with the Chart, oldest run first, skipping a run with no pass rate", async () => {
    const { container } = show();
    const chart = await screen.findByRole("list", { name: "Pass rate by run date" }, SLOW);
    expect(container.querySelector("[data-chart]")).toBeTruthy();
    const points = [...chart.querySelectorAll("li")].map((li) => li.textContent);
    expect(points).toHaveLength(3);
    expect(points[0]).toContain("50%");
    expect(points[1]).toContain("60%");
    expect(points[2]).toContain("90%");
  });

  it("the Grid has a row per version and a column per model class, each cell the newest run, and \"no run\" for an empty pair", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Latest run per version and model class" }, SLOW);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Version", "standard", "strong"]);
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    // Versions are named by age: the first the skill had is Version 1.
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]).toBe("Version 2");
    expect(rows[0]![1]).toContain("90%");
    expect(rows[0]![2]).toBe("no run");
    expect(rows[1]![0]).toBe("Version 1");
    expect(rows[1]![1]).toBe("no run");
    expect(rows[1]![2]).toContain("60%");
    expect(table.querySelector("[data-level]")).toBeTruthy();
  });

  it("Compare starts on the two newest runs with a pass rate and shows both, the gap, the noise band and the verdict", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Compare two runs" }, SLOW);
    expect(urls.some((u) => u.includes("/compare?a=run_xxx7&b=run_zzz9"))).toBe(true);
    const cells = (name: string) => within(within(table).getByRole("row", { name: new RegExp(name) })).getAllByRole("cell").map((c) => c.textContent);
    expect(cells("Pass rate")).toEqual(["Pass rate", "60%", "90%", "+40 points"]);
    expect(cells("Model class").slice(1, 3)).toEqual(["strong", "standard"]);
    expect(cells("Noise band")[3]).toBe("±22 points");
    expect(cells("Within noise")[3]).toBe("No");
    // The pickers show dates, model classes and pass rates; run IDs are only values.
    expect(screen.getByRole("combobox", { name: "First run" }).textContent).toMatch(/strong, 60%/);
    expect(screen.getByRole("combobox", { name: "Second run" }).textContent).toMatch(/standard, 90%/);
  });

  it("picking another run reads that comparison", async () => {
    show();
    await screen.findByRole("table", { name: "Compare two runs" }, SLOW);
    fireEvent.click(screen.getByRole("combobox", { name: "First run" }));
    fireEvent.click(screen.getByRole("option", { name: /standard, 50%/ }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes("/compare?a=run_www6&b=run_zzz9"))).toBe(true), SLOW);
  });

  it("says when the gap cannot be judged", async () => {
    comparison = { a: summary(RUNS[3]!), b: summary(RUNS[0]!), gap: null, noise_band: null, within_noise: null };
    show();
    const table = await screen.findByRole("table", { name: "Compare two runs" }, SLOW);
    expect(table.textContent).toContain("Not enough replays to say");
  });

  it("shows plain words only: no run, suite or skill ID, no snake_case name", async () => {
    const { container } = show();
    await screen.findByRole("table", { name: "Compare two runs" }, SLOW);
    const text = container.textContent!;
    expect(text).not.toMatch(/run_|suite_|sha-|skills\/|SKILL\.md|wi_/);
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("Compare needs two runs with a pass rate", async () => {
    runs = [RUNS[0]!, RUNS[1]!];
    grid = [GRID[0]!];
    show();
    expect(await screen.findByText("Compare needs two runs with a pass rate.", undefined, SLOW)).toBeTruthy();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows Loading while reading, an empty state with no runs, and an error note when a read fails", async () => {
    runs = [];
    grid = [];
    show();
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    expect(await screen.findByText("No runs yet", undefined, SLOW)).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("review-plan");
    cleanup();
    fail = true;
    show();
    const alert = await screen.findByRole("alert", undefined, SLOW);
    expect(alert.textContent).not.toContain("review-plan");
    expect(alert.textContent).not.toContain("HTTP");
  });
});

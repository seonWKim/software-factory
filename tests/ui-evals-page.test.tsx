// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalRun, EvalRunSummary, SkillVersionDiff, SkillVersionRow } from "../web/src/api/evals.js";
import { BASE, evalsRoute, routeFor } from "../web/src/pages.js";

// The evals page at evals/<skill> (design 09-dashboard-evals): header, Versions, Compare Button, Grid and Trend in that
// order, "no run" in an empty grid cell, plain words only (hashes and run IDs only under a version's Details), Compare's
// ModalPanel with its DiffView, and Run now in the header, whose Dialog posts one run.
// The reads and the POST are a fake fetch.

// A variable path keeps the view's JSX out of the test type check, as the Efficiency page test does.
const VIEW_MODULE = "../web/src/views/evals.js";
const { EvalsPage, skillName } = (await import(/* @vite-ignore */ VIEW_MODULE)) as { EvalsPage: FunctionComponent<{ skill: string }>; skillName(ref: string): string };

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
const VERSIONS: SkillVersionRow[] = [
  { version: 3, folder_hash: "hash-c", created_at: "2026-11-22T10:00:00.000Z", current: true, run_id: "run_zzz9", pass_rate: 0.9, change: 0.3 },
  { version: 2, folder_hash: "hash-b", created_at: "2026-11-16T10:00:00.000Z", current: false, run_id: "run_xxx7", pass_rate: 0.6, change: -0.1 },
  { version: 1, folder_hash: "hash-a", created_at: "2026-11-09T10:00:00.000Z", current: false, run_id: null, pass_rate: null, change: null },
];
const DIFF = (a: string, b: string): SkillVersionDiff => ({
  a: VERSIONS.find((v) => v.folder_hash === a)!, b: VERSIONS.find((v) => v.folder_hash === b)!,
  lines: [{ op: "same", text: "# Review" }, { op: "removed", text: "Be brief." }, { op: "added", text: "Be thorough." }],
  cases: [{ case_id: "case_one1", a: "pass", b: "fail" }, { case_id: "case_two2", a: null, b: "errored" }],
});
let versions: SkillVersionRow[] = VERSIONS;
let fail = false;
let urls: string[] = [];
let posts: { url: string; body: unknown; token: string | null }[] = [];
/** The POST's answer: a stored run by default. */
let postAnswer = () => json(200, { run_id: "run_new1", status: "passed" });

beforeEach(() => {
  urls = [];
  posts = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    const enc = encodeURIComponent(SKILL);
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)), token: new Headers(init.headers).get("x-csrf-token") });
      return postAnswer();
    }
    if (url === "/api/v1/session") return json(200, { as_of: "2026-11-24T00:00:00.000Z", csrf_token: "tok", commands_enabled: true, actor: null, actor_source: null });
    if (fail) return json(500, { error: "boom" });
    if (url === `/api/v1/evals/${enc}/runs`) return json(200, { runs });
    if (url === `/api/v1/evals/${enc}/grid`) return json(200, { rows: grid });
    if (url === `/api/v1/evals/${enc}/versions`) return json(200, { versions, unlinked: [] });
    if (url.startsWith(`/api/v1/evals/${enc}/diff?`)) {
      const q = new URL(url, "http://x").searchParams;
      return json(200, DIFF(q.get("a")!, q.get("b")!));
    }
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  runs = RUNS;
  grid = GRID;
  versions = VERSIONS;
  fail = false;
  postAnswer = () => json(200, { run_id: "run_new1", status: "passed" });
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
  it("shows the header, Versions, the Compare Button, the Grid and Trend in that order, with Run now as the one primary Button", async () => {
    const { container } = show();
    await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("review-plan");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Versions", "Latest run per version and model class", "Pass rate over time"]);
    const header = container.querySelector("header")!;
    expect(within(header).getAllByRole("button").map((b) => b.textContent)).toEqual(["Run now"]);
    const primary = [...container.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent"));
    expect(primary.map((b) => b.textContent)).toEqual(["Run now"]);
    // The Compare Button is secondary, in a ButtonRow between the versions Card and the Grid Card.
    const compare = screen.getByRole("button", { name: "Compare versions" });
    expect(compare.className).not.toContain("bg-accent");
    const versionsCard = screen.getByRole("region", { name: "Versions" });
    const grid = screen.getByRole("region", { name: "Latest run per version and model class" });
    expect(versionsCard.compareDocumentPosition(compare) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(compare.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The run Compare card is gone: no run pickers on the page.
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("region", { name: "Compare two runs" })).toBeNull();
  });

  it("lists versions newest first as ListRows with pass rate, change and date, the current one with a Badge", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    const rows = [...list.querySelectorAll("[data-list-row]")];
    expect(rows.map((r) => r.getAttribute("data-version"))).toEqual(["3", "2", "1"]);
    expect(rows[0]!.textContent).toContain("Version 3");
    expect(rows[0]!.textContent).toContain("Pass rate 90%");
    expect(rows[0]!.textContent).toContain("+30 points since the version before");
    expect(rows[0]!.textContent).toContain("Saved Nov 22");
    expect(rows[1]!.textContent).toContain("−10 points");
    expect(rows[2]!.textContent).toContain("Pass rate no pass rate");
    expect(rows[2]!.textContent).toContain("no change to show");
    expect(within(list).getAllByText("Current")).toHaveLength(1);
    expect(rows[0]!.querySelector("[data-level]")!.textContent).toBe("Current");
    expect(rows[1]!.querySelector("[data-level]")).toBeNull();
  });

  it("shows a version's folder hash and run ID only inside its Details", async () => {
    const { container } = show();
    const list = await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    expect(container.textContent).not.toMatch(/hash-|run_/);
    const row = list.querySelector("[data-version=\"3\"]")!;
    fireEvent.click(within(row as HTMLElement).getByText("Details"));
    const details = row.querySelector("details")!;
    expect(details.textContent).toContain("hash-c");
    expect(details.textContent).toContain("run_zzz9");
    expect(row.querySelector("summary")!.textContent).toBe("Details");
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

  it("Compare opens a ModalPanel on the two newest versions with the unified diff and each case's result", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Compare versions" }, SLOW));
    const panel = await screen.findByRole("dialog", { name: "Compare versions" }, SLOW);
    await within(panel).findByRole("group", { name: "What changed in SKILL.md" }, SLOW);
    expect(urls.some((u) => u.includes("/diff?a=hash-b&b=hash-c"))).toBe(true);
    expect(within(panel).getByRole("combobox", { name: "First version" }).textContent).toContain("Version 2");
    expect(within(panel).getByRole("combobox", { name: "Second version" }).textContent).toContain("Version 3");
    // One column, each line marked − or +, an unchanged line with no mark.
    const lines = [...panel.querySelectorAll("[data-diff-view] li")].map((li) => [li.getAttribute("data-op"), li.textContent]);
    expect(lines).toEqual([["same", " # Review"], ["removed", "−Be brief."], ["added", "+Be thorough."]]);
    const table = within(panel).getByRole("table", { name: "Result of each case" });
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([["Case 1", "Passed", "Failed"], ["Case 2", "no result", "Could not judge"]]);
    expect(panel.textContent).not.toMatch(/case_|hash-/);
  });

  it("picking another version reads that diff", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Compare versions" }, SLOW));
    const panel = await screen.findByRole("dialog", { name: "Compare versions" }, SLOW);
    fireEvent.click(within(panel).getByRole("combobox", { name: "First version" }));
    fireEvent.click(screen.getByRole("option", { name: "Version 1" }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes("/diff?a=hash-a&b=hash-c"))).toBe(true), SLOW);
  });

  it("Compare is off with fewer than two versions", async () => {
    versions = [VERSIONS[0]!];
    show();
    const button = await screen.findByRole("button", { name: "Compare versions" }, SLOW);
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows plain words only: no run, suite or skill ID, no snake_case name", async () => {
    const { container } = show();
    await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    const text = container.textContent!;
    expect(text).not.toMatch(/run_|suite_|sha-|skills\/|SKILL\.md|wi_/);
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("says when the skill has no saved versions", async () => {
    versions = [];
    show();
    expect(await screen.findByText("This skill has no saved versions yet.", undefined, SLOW)).toBeTruthy();
  });

  it("shows Loading while reading, an empty state with no runs, and an error note when a read fails", async () => {
    runs = [];
    grid = [];
    show();
    expect(screen.getByLabelText("Eval runs")).toBeTruthy();
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

describe("Run now", () => {
  async function open() {
    const view = show();
    fireEvent.click(await screen.findByRole("button", { name: "Run now" }, SLOW));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    // The session token is read when the Dialog opens; Run is enabled once it is in.
    await vi.waitFor(() => expect((within(dialog).getByRole("button", { name: "Run" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
    return { ...view, dialog };
  }

  it("opens a Dialog with Field, Select and Input (type number) for model, judge model and replay count; replays start at 1", async () => {
    const { dialog } = await open();
    expect(within(dialog).getByRole("combobox", { name: "Model" }).textContent).toContain("standard");
    expect(within(dialog).getByRole("combobox", { name: "Judge model" }).textContent).toContain("strong");
    const replays = within(dialog).getByLabelText("Replays per case") as HTMLInputElement;
    expect(replays.type).toBe("number");
    expect(replays.value).toBe("1");
    // The footer is a ButtonRow with the primary Button last.
    const buttons = within(dialog).getAllByRole("button").filter((b) => b.getAttribute("role") !== "combobox" && !b.hasAttribute("aria-haspopup"));
    expect(buttons.map((b) => b.textContent).slice(-2)).toEqual(["Cancel", "Run"]);
    expect(buttons.at(-1)!.className).toContain("bg-accent");
    // The model options are model classes as stored, never a model ID.
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Model" }));
    expect(screen.getAllByRole("option").map((o) => o.textContent?.trim())).toEqual(["cheap", "standard", "strong"]);
  });

  it("the judge model follows the chosen model, and the run is posted with that class, as stored", async () => {
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: /strong/ }));
    expect(within(dialog).getByRole("combobox", { name: "Judge model" }).textContent).toContain("standard");
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ url: `/api/v1/evals/${encodeURIComponent(SKILL)}/runs`, body: { model_class: "strong", judge_model_class: "standard", replays: 1 }, token: "tok" });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
  });

  it.each([
    [403, "Only the owner starts a skill eval run: you are local:bob."],
    [409, "--replays 2: a run stores one verdict per case, so it replays each case once: nothing run"],
  ])("shows a %i reason in the Dialog, which stays open", async (status, error) => {
    postAnswer = () => json(status, { error });
    const { dialog } = await open();
    fireEvent.change(within(dialog).getByLabelText("Replays per case"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Run" }));
    const alert = await within(dialog).findByRole("alert", undefined, SLOW);
    expect(alert.textContent).toBe(error);
    expect(posts[0]!.body).toMatchObject({ replays: 2 });
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("shows in the header with no runs yet", async () => {
    runs = [];
    grid = [];
    show();
    expect(await screen.findByText("No runs yet", undefined, SLOW)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  });
});

// The Plugins page's Evals panel (design 09-dashboard-settings, 2026-11-24): an Evals button on each Skills row with a
// SKILL.md path opens the Evals content in a modal panel titled with the skill's name; closing it returns focus to the button. It reads /suite and /runs for the path,
// writes through POST /api/v1/evals/write with GET /api/v1/pauses's token, and opens every input, delete and try
// result in a Dialog; a 409 stays in the open Dialog. The reads and writes are a fake fetch.

const PLUGINS_MODULE = "../web/src/views/plugins.js";
const { PluginsPage } = (await import(/* @vite-ignore */ PLUGINS_MODULE)) as { PluginsPage: FunctionComponent };
const INTEGRATIONS_MODULE = "../web/src/views/settings/integrations.js";
const { IntegrationsTab } = (await import(/* @vite-ignore */ INTEGRATIONS_MODULE)) as { IntegrationsTab: FunctionComponent<{ view: unknown }> };

const PATH = "/home/me/.claude/skills/review-plan/SKILL.md";
const ENC = encodeURIComponent(PATH);
const SUITE = { id: "suite_abc1", skill_ref: PATH, title: "Plan reviews" };
const CASES = [
  { id: "case_one1", suite_id: SUITE.id, input: "Review this plan: ship it.", expected: ["Names a risk", "Says yes or no"] },
  { id: "case_two2", suite_id: SUITE.id, input: { plan: "x" }, expected: { checks: ["Is short"] } },
];
const SKILL_ROWS = [
  { name: "review-plan", folder: "/home/me/.claude/skills", description: null, roles: [], last_used: null, source: "claude", path: PATH, state: "ok" },
  { name: "tests-first", folder: "skills", description: null, roles: [], last_used: null },
];

let suiteView: { suite: typeof SUITE | null; cases: typeof CASES } = { suite: SUITE, cases: CASES };
let answer: { status: number; body: unknown } = { status: 200, body: {} };
let writes: unknown[] = [];

function stubPlugins() {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    urls.push(url);
    if (init?.method === "POST") {
      writes.push({ url, token: (init.headers as Record<string, string>)["x-csrf-token"], body: JSON.parse(String(init.body)) });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/plugins") return json(200, { as_of: "2026-11-24T00:00:00.000Z", csrf_token: "t", mcp: [], tools: [], skills: SKILL_ROWS, skill_folders: ["skills"], settings_token: "s" });
    if (url === "/api/v1/evals") return json(200, { skills: [] });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: "tok_evals" });
    if (url === `/api/v1/evals/${ENC}/suite`) return json(200, suiteView);
    if (url === `/api/v1/evals/${ENC}/runs`) return json(200, { runs: [run("run_a1", 20, { suite_id: SUITE.id }), run("run_b2", 19, { suite_id: SUITE.id }), run("run_old", 1, { suite_id: "suite_gone" })] });
    return json(404, { error: "Not found." });
  }));
}

async function openCard() {
  history.replaceState(null, "", "/app/plugins?tab=skills");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(PluginsPage)));
  fireEvent.click(await screen.findByRole("button", { name: "Evals for review-plan" }, SLOW));
  return screen.findByRole("dialog", { name: "Evals: review-plan" }, SLOW);
}

// The panel is a dialog too; a Dialog it opens is the last one.
const dialog = () => screen.getAllByRole("dialog").at(-1)!;
const confirmIn = (name: string) => fireEvent.click(within(dialog()).getByRole("button", { name }));
const closed = () => vi.waitFor(() => expect(screen.getAllByRole("dialog")).toHaveLength(1), SLOW);

describe("Plugins Skills tab: the Evals card", () => {
  beforeEach(() => {
    suiteView = { suite: SUITE, cases: CASES };
    answer = { status: 200, body: {} };
    writes = [];
    stubPlugins();
  });

  it("has an Evals button on each row with a SKILL.md path, and an off one with its reason on a row without", async () => {
    history.replaceState(null, "", "/app/plugins?tab=skills");
    render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PluginsPage)));
    const on = await screen.findByRole("button", { name: "Evals for review-plan" }, SLOW);
    const off = screen.getByRole("button", { name: "Evals for tests-first" });
    expect((on as HTMLButtonElement).disabled).toBe(false);
    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect(off.getAttribute("title")).toBe("Only a skill with a SKILL.md file can have evals.");
  });

  it("opens a dialog titled with the skill's name, with no aria-pressed on the button, reading the suite for the URL-encoded path", async () => {
    const card = await openCard();
    expect(screen.getByRole("button", { name: "Evals for review-plan" }).hasAttribute("aria-pressed")).toBe(false);
    expect(urls).toContain(`/api/v1/evals/${ENC}/suite`);
    const cases = await within(card).findByRole("table", undefined, SLOW);
    expect(within(cases).getAllByRole("row")).toHaveLength(CASES.length + 1);
    expect(card.textContent).toContain("Plan reviews");
    // Plain words: no suite, case or run ID, and no SKILL.md path.
    expect(card.textContent).not.toMatch(/suite_|case_|run_|SKILL\.md/);
  });

  it("closing the dialog (close button, Esc or the backdrop) returns focus to that row's Evals button", async () => {
    await openCard();
    const button = screen.getByRole("button", { name: "Evals for review-plan" });
    const close = [
      (card: HTMLElement) => fireEvent.click(within(card).getByRole("button", { name: "Close" })),
      (card: HTMLElement) => fireEvent.keyDown(card, { key: "Escape" }),
      (card: HTMLElement) => fireEvent.click(card),
    ];
    for (const how of close) {
      how(screen.getByRole("dialog", { name: "Evals: review-plan" }));
      await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
      expect(document.activeElement).toBe(button);
      fireEvent.click(button);
      await screen.findByRole("dialog", { name: "Evals: review-plan" }, SLOW);
    }
  });

  it("offers Add test set only when the skill has none, and posts suite.add with the pauses token", async () => {
    suiteView = { suite: null, cases: [] };
    const card = await openCard();
    fireEvent.click(await within(card).findByRole("button", { name: "Add test set" }, SLOW));
    await vi.waitFor(() => expect(dialog()).toBeTruthy());
    confirmIn("Add test set");
    await vi.waitFor(() => expect(writes).toHaveLength(1), SLOW);
    expect(writes[0]).toEqual({ url: "/api/v1/evals/write", token: "tok_evals", body: { op: "suite.add", skill: PATH, title: "review-plan" } });
    cleanup();
    suiteView = { suite: SUITE, cases: CASES };
    const full = await openCard();
    await within(full).findByRole("table", undefined, SLOW);
    expect(within(full).queryByRole("button", { name: "Add test set" })).toBeNull();
  });

  it("renames the suite and adds, edits, tries and imports cases through Dialogs", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    const rowHeights = () => within(card).getAllByRole("row").map((r) => r.textContent);
    const before = rowHeights();

    fireEvent.click(within(card).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(dialog()).getByLabelText("Name"), { target: { value: "Reviews" } });
    // Opening an input changes no row of the card.
    expect(rowHeights()).toEqual(before);
    confirmIn("Rename");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "suite.rename", skill: PATH, title: "Reviews" } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Add case" }));
    fireEvent.change(within(dialog()).getByLabelText("What the skill is given"), { target: { value: "A plan" } });
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "One\n\n Two \n" } });
    confirmIn("Add case");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.add", skill: PATH, input: "A plan", expected: ["One", "Two"] } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Edit case 1" }));
    expect((within(dialog()).getByLabelText("What the skill is given") as HTMLTextAreaElement).value).toBe(CASES[0]!.input);
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "Names a risk" } });
    confirmIn("Save");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.edit", case: "case_one1", expected: ["Names a risk"] } }), SLOW);
    expect((writes.at(-1) as { body: object }).body).not.toHaveProperty("input");
    await closed();

    answer = { status: 200, body: { op: "case.try", case: "case_two2", source: "agents-home", tried: { verdict: "fail", checks: [{ check: "Is short", answer: "no", reason: "It runs long." }], error: null } } };
    fireEvent.click(within(card).getByRole("button", { name: "Try case 2" }));
    confirmIn("Try");
    await within(dialog()).findByText("Failed", undefined, SLOW);
    expect(dialog().textContent).toContain("It runs long.");
    expect(writes.at(-1)).toMatchObject({ body: { op: "case.try", case: "case_two2" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Close" }));
    await closed();

    answer = { status: 200, body: { op: "import", skill: PATH, source: "agents-home", added: ["a", "b"], kept: ["c"] } };
    fireEvent.click(within(card).getByRole("button", { name: "Import cases" }));
    confirmIn("Import cases");
    await within(dialog()).findByText("Added 2; 1 already here.", undefined, SLOW);
    expect(writes.at(-1)).toMatchObject({ body: { op: "import", skill: PATH } });
  });

  it("each delete Dialog says how many of the suite's runs keep their history, and posts the delete", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    fireEvent.click(within(card).getByRole("button", { name: "Delete test set" }));
    await within(dialog()).findByText("2 past runs keep their history.", undefined, SLOW);
    expect(urls).toContain(`/api/v1/evals/${ENC}/runs`);
    confirmIn("Delete");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "suite.delete", skill: PATH } }), SLOW);
    await closed();

    fireEvent.click(within(card).getByRole("button", { name: "Delete case 2" }));
    await within(dialog()).findByText("2 past runs keep their history.", undefined, SLOW);
    confirmIn("Delete");
    await vi.waitFor(() => expect(writes.at(-1)).toMatchObject({ body: { op: "case.delete", case: "case_two2" } }), SLOW);
  });

  it("shows a 409 refusal in the open Dialog and reads nothing again", async () => {
    const card = await openCard();
    await within(card).findByRole("table", undefined, SLOW);
    answer = { status: 409, body: { error: "expected must be a list of rubric check texts: nothing written" } };
    fireEvent.click(within(card).getByRole("button", { name: "Add case" }));
    fireEvent.change(within(dialog()).getByLabelText("What the skill is given"), { target: { value: "A plan" } });
    fireEvent.change(within(dialog()).getByLabelText("Checks, one per line"), { target: { value: "One" } });
    const reads = urls.filter((u) => u.endsWith("/suite")).length;
    confirmIn("Add case");
    await within(dialog()).findByText(/nothing written/, undefined, SLOW);
    expect(urls.filter((u) => u.endsWith("/suite")).length).toBe(reads);
    expect(within(card).getAllByRole("row")).toHaveLength(CASES.length + 1);
  });
});

// Integrations: the eval source keeps its Switch; on opens its own Dialog naming agents-home, off resets the entry.
describe("Integrations: the eval source switch", () => {
  const settingsView = (entry: Record<string, string> | null) => ({
    csrf_token: "tok_s",
    keys: [{ key: "integrations", kind: "json", value: entry === null ? "{}" : JSON.stringify(entry), source: entry === null ? "default" : "override", file_value: null, default_value: "{}", applies_at: "", description: "", project_settable: false, projects: [] }],
    integrations: [
      { kind: "tacit", interface: "TacitLedger", plugin: entry?.tacit ?? "none", source: entry?.tacit ? "setting" : "config", configured: "none" },
      { kind: "eval_source", interface: "SkillEvalSource", plugin: entry?.eval_source ?? "none", source: entry?.eval_source ? "setting" : "config", configured: "none" },
    ],
  });
  let posts: unknown[] = [];
  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(200, { lines: ["ok"] });
      }
      return json(404, { error: "Not found." });
    }));
  });
  const showTab = (entry: Record<string, string> | null) =>
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(IntegrationsTab, { view: settingsView(entry) })));

  it("turning it on opens a Dialog naming agents-home, whose confirm sets eval_source in the entry", async () => {
    showTab({ tacit: "agents-home" });
    fireEvent.click(screen.getByRole("switch", { name: "Integration: SkillEvalSource" }));
    const d = await screen.findByRole("dialog", undefined, SLOW);
    expect(d.textContent).toContain("agents-home");
    expect(d.textContent).not.toMatch(/rule/i);
    fireEvent.click(within(d).getByRole("button", { name: "Turn on" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toMatchObject({ action: "set", key: "integrations" });
    expect(JSON.parse((posts[0] as { value: string }).value)).toEqual({ tacit: "agents-home", eval_source: "agents-home" });
  });

  it("turning it off resets the entry", async () => {
    showTab({ eval_source: "agents-home" });
    fireEvent.click(screen.getByRole("switch", { name: "Integration: SkillEvalSource" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toMatchObject({ action: "reset", key: "integrations" });
  });
});

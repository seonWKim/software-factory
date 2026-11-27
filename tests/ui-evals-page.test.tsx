// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EvalCalibration, EvalRun, SkillVersionDiff, SkillVersionRow } from "../web/src/api/evals.js";
import { BASE, evalsRoute, routeFor } from "../web/src/pages.js";
import { SLOW, json, run } from "./ui-evals-fixtures.js";

// The evals page at evals/<skill> (design 09-dashboard-evals, owner answer 4): the header with Run now, then the Cards
// Versions (Chart, judge agreement StatTile, warn Notice below 80%, a ListRow per version), Cases (a Badge per case and
// version, Add as a new case, the Judge checks Disclosure), Compare (two version Selects, wins, losses, ties and the
// verdict) and SKILL.md diff (a ValueBlock). Plain words only (hashes and run IDs only under a version's Details); Run
// now's Dialog posts one run.
// The reads and the POST are a fake fetch.

// A variable path keeps the view's JSX out of the test type check, as the Efficiency page test does.
const VIEW_MODULE = "../web/src/views/evals.js";
const { EvalsPage, skillName } = (await import(/* @vite-ignore */ VIEW_MODULE)) as { EvalsPage: FunctionComponent<{ skill: string }>; skillName(ref: string): string };

const SKILL = "skills/review-plan/SKILL.md";

// Newest first, as the route gives them.
const RUNS: EvalRun[] = [
  run("run_zzz9", 20, { pass_rate: 0.9, skill_version: "sha-new", model_class: "standard" }),
  run("run_yyy8", 18, { pass_rate: null, replays: null, model_class: null, skill_version: null }),
  run("run_xxx7", 15, { pass_rate: 0.6, model_class: "strong" }),
  run("run_www6", 10, { pass_rate: 0.5, model_class: "standard" }),
];

let runs: EvalRun[] = RUNS;
const VERSIONS: SkillVersionRow[] = [
  { version: 3, folder_hash: "hash-c", created_at: "2026-11-22T10:00:00.000Z", current: true, run_id: "run_zzz9", pass_rate: 0.9, change: 0.3, band: { low: 0.7, high: 0.9 }, cost_usd: 1.234, cases: [{ case_id: "case_one1", verdict: "pass" }, { case_id: "case_two2", verdict: "errored" }] },
  { version: 2, folder_hash: "hash-b", created_at: "2026-11-16T10:00:00.000Z", current: false, run_id: "run_xxx7", pass_rate: 0.6, change: -0.1, band: null, cost_usd: 0.004, cases: [{ case_id: "case_one1", verdict: "fail" }] },
  { version: 1, folder_hash: "hash-a", created_at: "2026-11-09T10:00:00.000Z", current: false, run_id: null, pass_rate: null, change: null },
];
const DIFF = (a: string, b: string): SkillVersionDiff & { wins: number; losses: number; ties: number; verdict: string | null } => ({
  a: VERSIONS.find((v) => v.folder_hash === a)!, b: VERSIONS.find((v) => v.folder_hash === b)!,
  lines: [{ op: "same", text: "# Review" }, { op: "removed", text: "Be brief." }, { op: "added", text: "Be thorough." }],
  cases: [{ case_id: "case_one1", a: "pass", b: "fail" }, { case_id: "case_two2", a: null, b: "errored" }],
  // caseTally of the cases: case_one1 is a loss; case_two2 has no pass or fail in the first, so it is not counted.
  wins: 0, losses: 1, ties: 0, verdict: "within noise",
});
let versions: SkillVersionRow[] = VERSIONS;
const CALIBRATION: EvalCalibration = {
  labels: 4, agreement: 0.75, calibrated: false, run: "run_zzz9",
  checks: [
    { case_id: "case_one1", replay: 1, check: "Names the riskiest step", answer: "yes", reason: "It names the deploy step.", label: null },
    { case_id: "case_one1", replay: 1, check: "Explains why", answer: "no", label: "right" },
    { case_id: "case_two2", replay: 1, check: "Says yes or no", answer: "no", label: null },
  ],
};
let calibration: EvalCalibration = CALIBRATION;
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
    if (url === `/api/v1/evals/${enc}/versions`) return json(200, { versions, unlinked: [] });
    if (url === `/api/v1/evals/${enc}/calibration`) return json(200, calibration);
    if (url.startsWith(`/api/v1/evals/${enc}/diff?`)) {
      const q = new URL(url, "http://x").searchParams;
      return json(200, DIFF(q.get("a")!, q.get("b")!));
    }
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  runs = RUNS;
  versions = VERSIONS;
  calibration = CALIBRATION;
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
  it("shows the header with Run now as the one primary Button, then Versions, Cases, Compare and SKILL.md diff, no other Card", async () => {
    const { container } = show();
    await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("review-plan");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Versions", "Cases", "Compare", "SKILL.md diff"]);
    const header = container.querySelector("header")!;
    expect(within(header).getAllByRole("button").map((b) => b.textContent)).toEqual(["Run now"]);
    const primary = [...container.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent"));
    expect(primary.map((b) => b.textContent)).toEqual(["Run now"]);
    const cards = ["Versions", "Cases", "Compare", "SKILL.md diff"].map((name) => screen.getByRole("region", { name }));
    for (const [k, card] of cards.slice(1).entries()) expect(cards[k]!.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect([...container.querySelectorAll("section")]).toEqual(cards);
    // No pop-up: Compare is on the page.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Compare versions" })).toBeNull();
  });

  it("lists versions newest first as ListRows with pass rate, band, cost, change and date, the current one with a Badge", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    const rows = [...list.querySelectorAll("[data-list-row]")];
    expect(rows.map((r) => r.getAttribute("data-version"))).toEqual(["3", "2", "1"]);
    expect(rows[0]!.textContent).toContain("Version 3");
    expect(rows[0]!.textContent).toContain("Pass rate 90%");
    expect(rows[0]!.textContent).toContain("between 70% and 90%");
    expect(rows[0]!.textContent).toContain("Costs $1.23 per run");
    expect(rows[1]!.textContent).toContain("Costs <$0.01 per run");
    expect(rows[1]!.textContent).toContain("no range to show");
    expect(rows[2]!.textContent).toContain("no cost recorded");
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

  it("Versions draws a Chart of pass rate by version, oldest first, skipping a version with no pass rate", async () => {
    show();
    const chart = await screen.findByRole("list", { name: "Pass rate by version" }, SLOW);
    expect(screen.getByRole("region", { name: "Versions" }).contains(chart)).toBe(true);
    expect(chart.closest("[data-chart]")).toBeTruthy();
    expect([...chart.querySelectorAll("li")].map((li) => li.getAttribute("title"))).toEqual(["Version 2: 60%", "Version 3: 90%"]);
  });

  it("Versions shows the judge's agreement in a StatTile and a warn Notice below 80%", async () => {
    show();
    const card = await screen.findByRole("region", { name: "Versions" }, SLOW);
    const tile = await vi.waitFor(() => card.querySelector("[data-agreement]")!, SLOW);
    expect(tile.querySelector("dt")!.textContent).toBe("Judge agreement");
    expect(tile.querySelector("dd")!.textContent).toBe("75%");
    expect(tile.textContent).toContain("with you, on 4 labelled checks");
    const notice = within(card).getByRole("alert");
    expect(notice.getAttribute("data-tone")).toBe("warn");
    expect(notice.textContent).toContain("The judge agrees with you less than 80% of the time");
  });

  it("Versions shows no Notice at 80% or more, and says so in words with no labels", async () => {
    calibration = { ...CALIBRATION, labels: 5, agreement: 0.8, calibrated: true };
    show();
    let card = await screen.findByRole("region", { name: "Versions" }, SLOW);
    await vi.waitFor(() => expect(card.querySelector("[data-agreement]")!.textContent).toContain("80%"), SLOW);
    expect(within(card).queryByRole("alert")).toBeNull();
    cleanup();
    calibration = { ...CALIBRATION, labels: 0, agreement: null, checks: CALIBRATION.checks.map((c) => ({ ...c, label: null })) };
    show();
    card = await screen.findByRole("region", { name: "Versions" }, SLOW);
    await vi.waitFor(() => expect(card.querySelector("[data-agreement]")!.textContent).toContain("No checks are labelled yet"), SLOW);
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("Cases has a numbered row per case and a column per version, each cell Passed, Failed, Could not judge or no result", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Result of each case in each version" }, SLOW);
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Case", "Version 3", "Version 2", "Version 1"]);
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([["Case 1", "Passed", "Failed", "no result"], ["Case 2", "Could not judge", "no result", "no result"]]);
    // Each cell is a Badge.
    for (const row of within(table).getAllByRole("row").slice(1)) {
      for (const cell of within(row).getAllByRole("cell").slice(1)) expect(cell.querySelector("[data-level], span")!.textContent).toBe(cell.textContent);
    }
    expect(within(table).getAllByRole("row")[1]!.querySelector("[data-level=\"succeeded\"]")!.textContent).toBe("Passed");
    expect(table.textContent).not.toContain("case_");
  });

  it("shows the judge's reason beside each check's Right and Wrong buttons", async () => {
    show();
    const list = await screen.findByRole("list", { name: "Checks the judge answered" }, SLOW);
    const first = list.querySelector("[data-judge-check]") as HTMLElement;
    expect(first.textContent).toContain("Because: It names the deploy step.");
    expect(within(first).getByRole("button", { name: "Right" })).toBeTruthy();
  });

  it("Compare starts on the two newest versions and shows wins, losses, ties and the verdict last", async () => {
    show();
    const card = await screen.findByRole("region", { name: "Compare" }, SLOW);
    const table = await within(card).findByRole("table", { name: "The second version against the first, case by case" }, SLOW);
    expect(urls.some((u) => u.includes("/diff?a=hash-b&b=hash-c"))).toBe(true);
    expect(within(card).getByRole("combobox", { name: "First version" }).textContent).toContain("Version 2");
    expect(within(card).getByRole("combobox", { name: "Second version" }).textContent).toContain("Version 3");
    const rows = within(table).getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell").map((c) => c.textContent));
    expect(rows).toEqual([
      ["Wins: the second passed, the first did not", "0"],
      ["Losses: the first passed, the second did not", "1"],
      ["Ties: both gave the same result", "0"],
      ["Verdict", "Within noise: no clear difference"],
    ]);
    expect(card.textContent).not.toMatch(/case_|hash-/);
  });

  it("SKILL.md diff shows each line in a ValueBlock: − removed, + added, no mark unchanged", async () => {
    show();
    const card = await screen.findByRole("region", { name: "SKILL.md diff" }, SLOW);
    const group = await within(card).findByRole("group", { name: "What changed in SKILL.md" }, SLOW);
    const block = group.querySelector("pre")!;
    const lines = [...block.querySelectorAll("[data-op]")].map((l) => [l.getAttribute("data-op"), l.textContent!.trimEnd()]);
    expect(lines).toEqual([["same", "  # Review"], ["removed", "− Be brief."], ["added", "+ Be thorough."]]);
  });

  it("picking another version reads that diff", async () => {
    show();
    const card = await screen.findByRole("region", { name: "Compare" }, SLOW);
    fireEvent.click(await within(card).findByRole("combobox", { name: "First version" }, SLOW));
    fireEvent.click(screen.getByRole("option", { name: "Version 1" }));
    await vi.waitFor(() => expect(urls.some((u) => u.includes("/diff?a=hash-a&b=hash-c"))).toBe(true), SLOW);
  });

  it("Compare and SKILL.md diff say so with fewer than two versions", async () => {
    versions = [VERSIONS[0]!];
    show();
    await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    for (const name of ["Compare", "SKILL.md diff"]) expect(screen.getByRole("region", { name }).textContent).toContain("Compare needs two saved versions.");
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("shows plain words only: no run, suite or skill ID, no snake_case name", async () => {
    const { container } = show();
    await screen.findByRole("list", { name: "Versions of this skill, newest first" }, SLOW);
    await screen.findByRole("group", { name: "What changed in SKILL.md" }, SLOW);
    // SKILL.md shows only as the file's name in the owner's Card title, never as a path.
    const text = container.textContent!;
    expect(text).not.toMatch(/run_|suite_|sha-|skills\/|\/SKILL\.md|wi_/);
    expect(text).not.toMatch(/[a-z]+_[a-z]+/);
  });

  it("says when the skill has no saved versions", async () => {
    versions = [];
    show();
    expect(await screen.findByText("This skill has no saved versions yet.", undefined, SLOW)).toBeTruthy();
  });

  it("shows Loading while reading, an empty state with no runs, and an error note when a read fails", async () => {
    runs = [];
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

describe("Judge checks", () => {
  const card = () => document.querySelector<HTMLElement>("[data-judge-checks]")!;
  const rows = async () => [...(await screen.findByRole("list", { name: "Checks the judge answered" }, SLOW)).querySelectorAll("[data-judge-check]")] as HTMLElement[];

  it("is a Disclosure in the Cases Card, after the table, listing each judged check of the newest finished run in plain words", async () => {
    show();
    const listed = await rows();
    const cases = screen.getByRole("region", { name: "Cases" });
    expect(cases.contains(card())).toBe(true);
    expect(card().tagName).toBe("DETAILS");
    expect(card().querySelector("summary")!.textContent).toBe("Judge checks");
    const table = within(cases).getByRole("table", { name: "Result of each case in each version" });
    expect(table.compareDocumentPosition(card()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(listed.map((r) => r.querySelector("p")!.textContent)).toEqual(["Names the riskiest step", "Explains why", "Says yes or no"]);
    expect(listed[0]!.textContent).toContain("Case 1");
    expect(listed[0]!.textContent).toContain("Judge said Yes");
    expect(listed[1]!.textContent).toContain("Judge said No");
    expect(listed[1]!.textContent).toContain("You marked it right");
    expect(listed[2]!.textContent).toContain("Case 2");
    expect(card().textContent).not.toMatch(/run_|case_/);
  });

  it("each check has a ButtonRow with a Right and a Wrong Button; a labelled check has both off", async () => {
    show();
    const listed = await rows();
    for (const row of listed) {
      const buttons = within(row).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Right", "Wrong"]);
      expect(buttons[0]!.parentElement!.className).toContain("flex flex-wrap items-center gap-2");
      expect(buttons[0]!.parentElement).toBe(buttons[1]!.parentElement);
    }
    await vi.waitFor(() => expect((within(listed[0]!).getByRole("button", { name: "Right" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
    expect(within(listed[1]!).getAllByRole("button").every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it("a press posts label.set with the session token and then reads the page's data again", async () => {
    postAnswer = () => json(200, { op: "label.set", label: "wrong" });
    show();
    const [first] = await rows();
    const wrong = within(first!).getByRole("button", { name: "Wrong" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(wrong.disabled).toBe(false), SLOW);
    const reads = urls.filter((u) => u.endsWith("/calibration")).length;
    fireEvent.click(wrong);
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({
      url: "/api/v1/evals/write", token: "tok",
      body: { op: "label.set", run: "run_zzz9", case: "case_one1", replay: 1, check: "Names the riskiest step", label: "wrong" },
    });
    await vi.waitFor(() => expect(urls.filter((u) => u.endsWith("/calibration")).length).toBeGreaterThan(reads), SLOW);
  });

  it("shows a refusal under the row's buttons", async () => {
    postAnswer = () => json(409, { error: "The judge did not answer that check in this replay, so nothing was labelled." });
    show();
    const [first] = await rows();
    const right = within(first!).getByRole("button", { name: "Right" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(right.disabled).toBe(false), SLOW);
    fireEvent.click(right);
    expect((await within(first!).findByRole("alert", undefined, SLOW)).textContent).toContain("nothing was labelled");
  });

  it("says when the newest finished run has no judged checks", async () => {
    calibration = { labels: 0, agreement: null, calibrated: false, run: null, checks: [] };
    show();
    expect(await screen.findByText("The newest finished run has no checks the judge answered.", undefined, SLOW)).toBeTruthy();
  });
});

describe("Cases: Add as a new case", () => {
  // run_zzz9, the newest finished run (run_new0 is still running), is linked to version 3: case_two2 failed there.
  // case_one1 failed only in version 2, an older run.
  const failedNewest = () => {
    runs = [run("run_new0", 21, { status: "running" }), ...RUNS];
    versions = [{ ...VERSIONS[0]!, cases: [{ case_id: "case_one1", verdict: "pass" }, { case_id: "case_two2", verdict: "fail" }] }, ...VERSIONS.slice(1)];
  };
  const table = () => screen.findByRole("table", { name: "Result of each case in each version" }, SLOW);
  const rowsOf = (t: HTMLElement) => within(t).getAllByRole("row").slice(1);
  async function open() {
    failedNewest();
    const view = show();
    const [, second] = rowsOf(await table());
    fireEvent.click(within(second!).getByRole("button", { name: "Add as a new case" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    await vi.waitFor(() => expect((within(dialog).getByRole("button", { name: "Add case" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
    return { ...view, dialog };
  }

  it("shows a secondary Button in the last column only for a case that failed in the newest finished run", async () => {
    failedNewest();
    const { container } = show();
    const t = await table();
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent).at(-1)).toBe("Actions");
    const [first, second] = rowsOf(t);
    expect(within(first!).queryByRole("button")).toBeNull();
    const button = within(second!).getByRole("button", { name: "Add as a new case" });
    expect(within(second!).getAllByRole("cell").at(-1)!.contains(button)).toBe(true);
    expect(button.className).not.toContain("bg-accent");
    expect(button.className).toContain("min-h-7");
    const primary = [...container.querySelectorAll("button")].filter((b) => b.className.includes("bg-accent"));
    expect(primary.map((b) => b.textContent)).toEqual(["Run now"]);
  });

  it("shows no Button and no extra column when no case failed in the newest finished run", async () => {
    show();
    const t = await table();
    expect(within(t).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Case", "Version 3", "Version 2", "Version 1"]);
    expect(within(t).queryByRole("button")).toBeNull();
  });

  it("opens a Dialog naming the case as Case N, posts case.from_run, then closes and reads versions and runs again", async () => {
    postAnswer = () => json(200, { op: "case.from_run", case: { id: "from-run:run_zzz9:case_two2" } });
    const { dialog, container } = await open();
    expect(within(dialog).getByRole("heading").textContent).toContain("Case 2");
    expect(dialog.textContent).not.toMatch(/run_|case_/);
    const reads = { versions: urls.filter((u) => u.endsWith("/versions")).length, runs: urls.filter((u) => u.endsWith("/runs")).length };
    fireEvent.click(within(dialog).getByRole("button", { name: "Add case" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ url: "/api/v1/evals/write", token: "tok", body: { op: "case.from_run", run: "run_zzz9", case: "case_two2" } });
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    await vi.waitFor(() => {
      expect(urls.filter((u) => u.endsWith("/versions")).length).toBeGreaterThan(reads.versions);
      expect(urls.filter((u) => u.endsWith("/runs")).length).toBeGreaterThan(reads.runs);
    }, SLOW);
    expect(container.textContent).not.toMatch(/run_|case_/);
  });

  it("shows a refusal in the Dialog, which stays open", async () => {
    const refusal = "That case has no failed replay in that run: nothing written.";
    postAnswer = () => json(409, { error: refusal });
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add case" }));
    expect((await within(dialog).findByRole("alert", undefined, SLOW)).textContent).toBe(refusal);
    expect(screen.getByRole("dialog")).toBeTruthy();
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
    show();
    expect(await screen.findByText("No runs yet", undefined, SLOW)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run now" })).toBeTruthy();
  });
});

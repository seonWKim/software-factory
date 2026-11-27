// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubBudget, ImproveView, Overview } from "../web/src/api.js";
import { localShortDate } from "../web/src/lib/format.js";
// Only modules with no store behind them: under jsdom on Node 22, node:sqlite (which src/setup.ts reaches) cannot load.
import { SANDBOX_LINES } from "../src/impl/runner/os-sandbox.js";
import { type Check, credentialPlain, sandboxChecks } from "../src/core/health-check.js";
import { reportRows } from "../src/ui/health.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-pause.test.tsx does).
const PAGE_MODULE = "../web/src/views/pages.js";
const { HealthPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { HealthPage: FunctionComponent };

// The Health page's GitHub budget tab (design 09-dashboard-app, 2026-11-16): shown only while overview.github_budget
// is stored; it shows remaining of limit, the reset, the counted calls, a banner while waiting or low, and the token's
// days left when known. Its lines, and the Checks card, are in plain words (design 09-health, 2026-11-20): numbers
// grouped by thousands, times local, no ISO time or file path outside the Details disclosure.

const RESET = "2099-01-01T09:12:00.000Z";
const SLOW = { timeout: 5_000 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const budget = (over: Partial<GitHubBudget> = {}): GitHubBudget => ({
  limit: 5000, remaining: 812, reset_at: RESET, budget_share: 1, share_limit: null, counted: 37, state: "ok", as_of: RESET, replica_id: "host:42",
  wait_reason: null, ...over,
});
const overview = (over: Partial<Overview> = {}): Overview => ({
  as_of: RESET, stages: {}, needs_you: 0, open: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, ...over,
});

let current: Overview;
let overviewReads = 0;
let healthBody: unknown;

/** The viewer's local clock time, as the page writes it ("9:51 PM"). */
const clock = (at: string) => new Intl.DateTimeFormat("en", { hour: "numeric", minute: "2-digit" }).format(new Date(at));

/** The rendered text without the Details disclosures (`data-raw`) and code elements. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-raw], code").forEach((n) => n.remove());
  return copy.textContent ?? "";
}
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const FILE_PATH = /(^|[\s(])~?\/[\w.-]+\//;

beforeEach(() => {
  current = overview();
  overviewReads = 0;
  healthBody = { checked_at: RESET, checks: [] };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/v1/overview") {
      overviewReads++;
      return json(200, current);
    }
    if (url === "/api/v1/health") return json(200, healthBody);
    if (url === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
    if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
    if (url === "/api/v1/model-credential") return json(200, { secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], csrf_token: "t" });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show(tab?: string) {
  history.replaceState(null, "", tab ? `/app/health?tab=${tab}` : "/app/health");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(HealthPage)));
  return screen.findByRole("tablist", { name: "Health sections" }, SLOW);
}

const tabNames = (list: HTMLElement) => within(list).getAllByRole("tab").map((t) => t.textContent);

describe("Health page: before the server's first health run ends", () => {
  it("pending: keeps the Health checks placeholder and reads again until the stored report arrives", async () => {
    healthBody = { checked_at: null, checks: [], pending: true };
    history.replaceState(null, "", "/app/health");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(createElement(QueryClientProvider, { client }, createElement(HealthPage)));
    await waitFor(() => expect(screen.getByLabelText("Health checks").getAttribute("aria-busy")).toBe("true"));
    healthBody = { checked_at: RESET, checks: [{ status: "ok", msg: "fine" }], pending: false };
    await screen.findByRole("tablist", { name: "Health sections" }, SLOW);
  });
});

describe("Health page: GitHub budget tab", () => {
  it("with overview.github_budget present the Cost tab's GitHub budget section shows remaining of limit, reset, counted calls and github_token_days", async () => {
    current = overview({ github_budget: budget(), github_token_days: 12 });
    const list = await show();
    // Five tabs (design 09-health, 2026-11-24; Activity since 2026-11-27); the budget is a section of Cost, after Spend and Efficiency.
    expect(tabNames(list)).toEqual(["Overview", "Runs", "Cost", "Review", "Activity"]);
    fireEvent.click(within(list).getByRole("tab", { name: "Cost" }));
    const panel = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect([...document.querySelectorAll("[data-health-section]")].map((e) => e.getAttribute("data-health-section"))).toEqual(["spend", "efficiency", "github"]);
    expect(panel.textContent).toContain(`812 of 5,000 GitHub requests left; resets at ${clock(RESET)}`);
    expect(panel.textContent).toContain("This factory made 37 of them since the last reset.");
    expect(panel.querySelector("[data-token-days]")!.textContent).toBe("GitHub token: 12 days left.");
    expect(within(panel).queryByRole("alert")).toBeNull();
  });

  it("hides the section when overview.github_budget is null; the old ?tab=github link still opens Cost", async () => {
    current = overview({ github_budget: null, github_token_days: null });
    const list = await show("github");
    expect(within(list).getByRole("tab", { name: "Cost" }).getAttribute("aria-selected")).toBe("true");
    // The overview has been read and rendered before the section is looked for.
    await waitFor(() => expect(overviewReads).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 20));
    expect(document.querySelector("[data-health-section=spend]")).not.toBeNull();
    expect(document.querySelector("[data-health-section=github]")).toBeNull();
    expect(screen.queryByRole("region", { name: "GitHub budget" })).toBeNull();
  });

  it("waiting shows its banner with the wait reason; low shows its banner; no token check shows no token line", async () => {
    current = overview({ github_budget: budget({ state: "waiting", remaining: 0, wait_reason: `waiting for the GitHub rate-limit reset at ${RESET}` }), github_token_days: null });
    await show("github");
    const waiting = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect(within(waiting).getByRole("alert").textContent).toBe(`No GitHub requests left until ${clock(RESET)}. GitHub reads and writes wait; local work goes on.`);
    // The stored reason, with its ISO time, is behind Details only.
    expect(waiting.querySelector("[data-raw]")!.textContent).toContain(`waiting for the GitHub rate-limit reset at ${RESET}`);
    expect(visibleText(waiting)).not.toMatch(ISO);
    expect(waiting.querySelector("[data-token-days]")).toBeNull();
    cleanup();
    current = overview({ github_budget: budget({ state: "low", remaining: 100 }), github_token_days: "unknown" });
    await show("github");
    const low = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    expect(within(low).getByRole("alert").textContent).toContain("GitHub budget low");
    expect(low.querySelector("[data-token-days]")!.textContent).toBe("GitHub token: days left not checked yet.");
  });

  it("groups the numbers by thousands, says the share with no bracketed number, and keeps the replica and ISO reset behind Details", async () => {
    current = overview({ github_budget: budget({ remaining: 4844, counted: 1250, share_limit: 5000, budget_share: 1 }), github_token_days: null });
    await show("github");
    const panel = await screen.findByRole("region", { name: "GitHub budget" }, SLOW);
    const lines = [...panel.querySelectorAll("[data-github-budget] > p")].map((p) => p.textContent);
    expect(lines).toEqual([
      `4,844 of 5,000 GitHub requests left; resets at ${clock(RESET)}`,
      "This factory made 1,250 of them since the last reset.",
      "Your share: 5,000 requests.",
    ]);
    expect(visibleText(panel)).not.toMatch(ISO);
    expect(visibleText(panel)).not.toContain("host:42");
    expect(panel.querySelector("[data-raw]")!.textContent).toContain("host:42");
  });
});

describe("Health page: the Checks card", () => {
  const AGO = new Date(Date.now() - 5 * 60_000).toISOString();

  it("all ok: 'All N checks pass · 5m ago', the rows folded with no second count", async () => {
    healthBody = { checked_at: AGO, checks: [
      { status: "ok", msg: "Your secret file is private", detail: "secret file at /home/u/.env is private (mode 600)" },
      { status: "ok", msg: "GitHub labels: all present", detail: 'status label "sf: triaging" exists' },
      { status: "ok", msg: "GitHub: 2,566 of 5,000 requests left this hour", detail: "GitHub: 2566/5000 left, resets 12:50, synced by replica host:42" },
    ] };
    await show();
    const card = await screen.findByRole("region", { name: "All 3 checks pass · 5m ago" }, SLOW);
    const folded = within(card).getByTestId("ok-checks") as HTMLDetailsElement;
    expect(folded.open).toBe(false);
    expect(folded.querySelector("summary")!.textContent).toBe("Show the checks");
    // The count is said once: in the title.
    expect(card.textContent!.match(/\b3\b/g)).toHaveLength(1);
    // Each row: its status, then its sentence; the raw text only behind its Details.
    const rows = [...folded.querySelectorAll("li")].map((li) => visibleText(li));
    expect(rows).toEqual(["OKYour secret file is private", "OKGitHub labels: all present", "OKGitHub: 2,566 of 5,000 requests left this hour"]);
    expect(visibleText(card)).not.toMatch(FILE_PATH);
    expect(visibleText(card)).not.toContain("host:42");
    expect([...card.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n")).toContain("/home/u/.env");
  });

  it("a fail or warn: the title says how many need attention, and those rows come first", async () => {
    healthBody = { checked_at: AGO, checks: [
      { status: "ok", msg: "fine" },
      { status: "warn", msg: "GitHub labels: 2 missing (run: npm run setup)", detail: 'status label "sf: done" exists (run: npm run setup)' },
      { status: "fail", msg: "Your secret file can be read by other users; the fix is in Details", detail: "secret file at /home/u/.env is private (mode 644; run: chmod 600 /home/u/.env)" },
    ] };
    await show();
    const card = await screen.findByRole("region", { name: "2 checks need attention · 5m ago" }, SLOW);
    const firstRows = [...card.querySelectorAll("ul")[0]!.children].map((li) => visibleText(li as HTMLElement));
    expect(firstRows[0]).toContain("Your secret file can be read by other users");
    expect(firstRows[1]).toContain("GitHub labels: 2 missing (run: npm run setup)");
    expect(within(card).getByTestId("ok-checks").querySelector("summary")!.textContent).toBe("1 ok");
    expect(visibleText(card)).not.toMatch(FILE_PATH);
  });
});

// No model credential and no bubblewrap or socat (design 09-health, 2026-11-23): the report the server builds from those
// checks shows each in plain words, the three sandbox lines as one row, and the credential row opens the dialog.
describe("Health page: the model credential and sandbox checks", () => {
  const WHY = "Claude Code's sandbox is off on this host: sandbox is enabled but dependencies are missing: bubblewrap (bwrap) not installed, socat not installed · install missing tools (e.g. apt install bubblewrap socat) or see https://code.claude.com/docs/en/sandboxing";

  it("the visible Checks text names no variable, command or URL; the raw lines are behind Details; Add model credential opens the dialog", async () => {
    // doctor's credential line with its Health fields (tests/health.test.ts checks secretChecks gives exactly this).
    const credential: Check = { ok: false, msg: "model credential missing: one of CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY (run: npm run setup)", ...credentialPlain(false) };
    const checks = [
      credential,
      ...sandboxChecks(SANDBOX_LINES.map((line) => ({ line, enforced: false, why: WHY }))),
    ];
    healthBody = { checked_at: RESET, checks: reportRows(checks) };
    await show();
    const card = await screen.findByRole("region", { name: /2 checks need attention/ }, SLOW);
    const text = visibleText(card);
    expect(text).toContain("Auto mode is off: this computer has no OS sandbox. Details: how to install it");
    for (const re of [/[A-Z]+_[A-Z_]+/, /npm run|apt install/, /https?:\/\//]) expect(text).not.toMatch(re);
    const raw = [...card.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n");
    for (const c of checks) expect(raw).toContain(c.msg);

    fireEvent.click(within(card).getByRole("button", { name: "Add model credential" }));
    expect(await screen.findByRole("dialog", { name: "Add a model credential" }, SLOW)).toBeTruthy();
  });
});

// The improve report is the Health page's Improve tab (design 09-dashboard-system, 2026-11-21; it left the Rules page),
// read from GET /api/v1/rules's `improve`; with no such read there is no tab. Each failure group is titled in plain words (a
// title per group: its detail, else its draft cause, else "Repeated failure"); its code, detail and draft sit behind a Disclosure.
describe("Health page: Improve tab", () => {
  const IMPROVE_TOKEN = "tok_improve";
  // Two days, so the window is never one whole local day in any time zone and the header always reads as a range
  // (a one-day UTC window read "Yesterday" under TZ=UTC on CI). The Yesterday case has its own test below.
  const report: ImproveView["report"] = {
    window_start: "2026-11-14T00:00:00.000Z", window_end: "2026-11-16T00:00:00.000Z", created_at: "2026-11-16T00:05:00.000Z", runs: 4, patterns: 1,
    groups: [
      { error_code: "checks_failed", detail: "npm test exited #", runs: 2, hotspot: false, draft: { cause: "a flaky port", fix: "pin the port", note: null }, filing: { status: "filed", reason: null, ref: "local:local-1", runs: null } },
      { error_code: "hotspot", detail: "web/src/i18n/en.ts", runs: 3, hotspot: true, draft: null, filing: { status: "skipped", reason: "recently_closed", ref: null, runs: null } },
      { error_code: "weird_new_code", detail: null, runs: 2, hotspot: false, draft: { cause: null, fix: null, note: { status: "withheld", reason: "withheld" } }, filing: null },
      { error_code: "other_code", detail: null, runs: 2, hotspot: false, draft: { cause: "a stale cache", fix: null, note: null }, filing: { status: "failed", reason: "brand_new_reason", ref: null, runs: null } },
    ],
  };
  const improve = (over: Partial<ImproveView> = {}): ImproveView => ({ report, run_now: true, csrf_token: IMPROVE_TOKEN, ...over });
  let rulesBody: unknown;
  let answer: { status: number; body: unknown };
  let posts: { url: string; init: RequestInit }[];
  let rulesReads: number;

  beforeEach(() => {
    rulesBody = { enabled: true, entries: [], applied: null, retired: null, error: null, csrf_token: null, judge: null, home: null, turn_on: null, improve: improve() };
    answer = { status: 200, body: { run_id: "run_queued_1" } };
    posts = [];
    rulesReads = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, init });
        return json(answer.status, answer.body);
      }
      if (url === "/api/v1/rules") {
        rulesReads++;
        return rulesBody === null ? json(404, { error: "Not found." }) : json(200, rulesBody);
      }
      if (url === "/api/v1/overview") return json(200, current);
      if (url === "/api/v1/health") return json(200, healthBody);
      if (url === "/api/v1/unreviewed-merges") return json(200, { merges: [] });
      if (url === "/api/v1/pauses") return json(200, { pauses: [], csrf_token: null });
      if (url === "/api/v1/model-credential") return json(200, { secrets: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], csrf_token: "t" });
      return json(404, { error: "Not found." });
    }));
  });

  const section = () => screen.findByRole("region", { name: "Improve report" }, SLOW);

  it("the improve report is the Review tab's last section; with no rules read it is not drawn", async () => {
    const list = await show();
    fireEvent.click(within(list).getByRole("tab", { name: "Review" }));
    await section();
    expect([...document.querySelectorAll("[data-health-section]")].map((e) => e.getAttribute("data-health-section"))).toEqual(["merges", "improve"]);
    cleanup();
    rulesBody = null;
    const again = await show("improve");
    expect(within(again).getByRole("tab", { name: "Review" }).getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("region", { name: "Merged without review" }, SLOW);
    await waitFor(() => expect(rulesReads).toBeGreaterThan(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("region", { name: "Improve report" })).toBeNull();
  });

  const REASONS: Record<string, string> = {
    issue_cap: "the daily limit of new issues was reached", comment_cap: "the daily limit of comments was reached", recently_closed: "a similar issue closed recently",
    no_source: "no issue tracker to file to", needs_person: "it needs a person to decide", host_sleep: "the computer was asleep", pause: "the factory was paused",
    in_flight: "it is being filed now", open_item: "an open item already covers it", call_cap: "the limit of model calls was reached", error: "an error stopped it",
    refused: "the model refused", max_tokens: "the model's answer was cut off", invalid_output: "the model's answer could not be read", withheld: "held back for a possible secret",
  };

  it("shows the header, one row per group titled in plain words; the code, detail and draft are behind a Disclosure", async () => {
    await show("improve");
    const s = await section();
    const windowText = s.querySelector("[data-improve-window]")!.textContent!;
    expect(windowText).toBe(`${localShortDate(report!.window_start)} to ${localShortDate(report!.window_end)}: 4 repeating problems across 4 runs`);
    expect(windowText).not.toMatch(ISO);
    expect(windowText).not.toContain("single-run");
    const rows = [...s.querySelectorAll<HTMLElement>("[data-improve-group]")];
    expect(rows.map((r) => r.querySelector("[data-group-title]")!.textContent)).toEqual(["npm test exited #", "Often-edited file", "Repeated failure", "a stale cache"]);
    for (const r of rows) {
      expect(r.matches("[data-list-row]")).toBe(true);
      expect(r.querySelector("[data-group-title]")!.textContent).not.toMatch(FILE_PATH);
    }
    expect(rows[0]!.querySelector("[data-details]")!.textContent).toContain("2 runs");
    expect(rows[0]!.querySelector("[data-filing]")!.textContent).toBe("filed: local:local-1");
    expect(rows[1]!.querySelector("[data-filing]")!.textContent).toBe("not filed (a similar issue closed recently)");
    expect(rows[2]!.querySelector("[data-filing]")!.textContent).toBe("not filed yet");
    // An unmapped reason reads "not filed" with no code and no parentheses.
    expect(rows[3]!.querySelector("[data-filing]")!.textContent).toBe("not filed");
    // The draft opens under "Draft and details", lazily.
    const toggle = within(rows[0]!).getByText("Draft and details").closest("summary")!;
    expect(rows[0]!.querySelector("[data-draft]")).toBeNull();
    fireEvent.click(toggle);
    expect((await waitFor(() => rows[0]!.querySelector("[data-draft]")!)).textContent).toContain("a flaky port");
    expect(rows[0]!.querySelector("[data-draft]")!.textContent).toContain("pin the port");
    expect(rows[0]!.querySelector("code")!.textContent).toBe("checks_failed");
    fireEvent.click(within(rows[2]!).getByText("Draft and details").closest("summary")!);
    expect((await waitFor(() => rows[2]!.querySelector("[data-draft]")!)).textContent).toBe("no draft (held back for a possible secret)");
  });

  it("a previous-local-day window reads Yesterday (date) with the group and run counts", async () => {
    const day = new Date(2026, 10, 18);
    const next = new Date(2026, 10, 19);
    const made = new Date(2026, 10, 19, 0, 5);
    const group = { error_code: "x_y", detail: "d", runs: 1, hotspot: false, draft: null, filing: null };
    rulesBody = { ...(rulesBody as object), improve: improve({ report: { ...report!, window_start: day.toISOString(), window_end: next.toISOString(), created_at: made.toISOString(), runs: 12, groups: Array.from({ length: 15 }, () => group) } }) };
    await show("improve");
    const s = await section();
    expect(s.querySelector("[data-improve-window]")!.textContent).toBe("Yesterday (Nov 18): 15 repeating problems across 12 runs");
  });

  it.each(Object.entries(REASONS))("the filing reason %s reads as a plain phrase, and a draft note too", async (code, phrase) => {
    const g = (i: number) => ({ error_code: `c${i}`, detail: `g${i}`, runs: 2, hotspot: false, draft: { cause: null, fix: null, note: { status: "skipped", reason: code } }, filing: { status: "skipped" as const, reason: code, ref: null, runs: null } });
    rulesBody = { ...(rulesBody as object), improve: improve({ report: { ...report!, groups: [g(1)] } }) };
    await show("improve");
    const s = await section();
    const row = s.querySelector<HTMLElement>("[data-improve-group]")!;
    expect(row.querySelector("[data-filing]")!.textContent).toBe(`not filed (${phrase})`);
    fireEvent.click(within(row).getByText("Draft and details").closest("summary")!);
    expect((await waitFor(() => row.querySelector("[data-draft]")!)).textContent).toBe(`no draft (${phrase})`);
  });

  it("with no report it says so; with no run_now there is no Run now button", async () => {
    rulesBody = { ...(rulesBody as object), improve: improve({ report: null, run_now: false, csrf_token: null }) };
    await show("improve");
    const s = await section();
    expect(s.textContent).toContain("no improve run has reported yet");
    expect(within(s).queryByRole("button", { name: "Check the last 24 hours now" })).toBeNull();
  });

  it("Run now posts to POST /api/v1/improve/run with the x-csrf-token header; a 200 shows the run_id", async () => {
    await show("improve");
    const s = await section();
    expect(s.textContent).not.toContain("queues an improve run of the last 24 hours");
    fireEvent.click(within(s).getByRole("button", { name: "Check the last 24 hours now" }));
    expect((await within(s).findByRole("status")).textContent).toBe("Improve run queued: run_queued_1");
    expect(posts.map((p) => p.url)).toEqual(["/api/v1/improve/run"]);
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(IMPROVE_TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({});
  });

  it("a 409 shows its error and run_id, and the rules are not reloaded into a success", async () => {
    answer = { status: 409, body: { error: "An improve run is already queued (run_busy).", run_id: "run_busy" } };
    await show("improve");
    const s = await section();
    const before = rulesReads;
    fireEvent.click(within(s).getByRole("button", { name: "Check the last 24 hours now" }));
    const alert = await within(s).findByRole("alert");
    expect(alert.textContent).toContain("An improve run is already queued (run_busy).");
    expect(within(s).queryByRole("status")).toBeNull();
    expect(rulesReads).toBe(before);
  });
});

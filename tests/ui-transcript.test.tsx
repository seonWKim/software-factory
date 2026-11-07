// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import type { StorageRange } from "../src/interfaces/shared-storage.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { transcript } from "../src/ui/transcript.js";

// The app's transcript view (design §9, issue #303): the item page's Runs section links a stored transcript; the
// view shows the outcome first, then the steps in order, collapses long assistant text and tool results, marks
// errors, jumps to the last 20 steps of a failed run and filters by step type. Pages come from the real
// transcript module over the fixtures, so a withheld step is exactly what the API sends.

const AT = "2026-11-07T00:00:00.000Z";
const SECRET = `ghp_${"Ab3".repeat(12)}`;
const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8").replaceAll("@@PLANTED_SECRET@@", SECRET);

const ITEM = "wi_1";
const FAILED = "run_failed";
const LEAKY = "run_leaky";
const PLAIN = "run_plain";
const overview = { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } };

function run(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id, kind: "implement", status, attempt: 2, started_at: AT, finished_at: "2026-11-07T00:03:00.000Z", created_at: AT, tokens: 1500,
    error: status === "failed" ? { code: "checks_failed", detail: "npm test failed" } : null, attempts: [{ attempt: 1, worker_id: "host:9:9" }, { attempt: 2, worker_id: "host:1:0" }], ...extra,
  };
}
const detail = {
  as_of: AT,
  item: { id: ITEM, source: { type: "github", id: "o/r#1", link: "https://github.com/o/r/issues/1" }, title: "Port", stage: "RUNNING", close_reason: null, blocked_on: "none", blocked_reason: null, tier: 1, loop_count: 0, restart_count: 0, token_cost: 0, pr_number: null, pr_url: null, version: 1, created_at: AT, updated_at: AT },
  timeline: [],
  runs: [run(FAILED, "failed"), run(LEAKY, "succeeded"), run(PLAIN, "succeeded"), run("run_none", "succeeded")],
  transcripts: { [FAILED]: [""], [LEAKY]: [""], [PLAIN]: [""] },
};

/** Big transcript: 200 Bash calls then an Edit, so a filtered page has to read on. */
const files: Record<string, string> = {
  [FAILED]: fixture("failed-run.jsonl"),
  [LEAKY]: fixture("planted-secret.jsonl"),
  [PLAIN]: fixture("plain.txt"),
};
const enc = new TextEncoder();
const storage = {
  ranges: [] as { key: string; start: number; end: number }[],
  async put() {},
  async get() {
    throw new Error("no whole-file read");
  },
  async list(prefix: string) {
    return Object.keys(files).map((r) => `transcripts/${ITEM}/${r}.json`).filter((k) => k.startsWith(prefix));
  },
  async delete() {},
  async getRange(key: string, start: number, end: number): Promise<StorageRange | null> {
    const r = /\/([^/]+)\.json$/.exec(key)?.[1];
    const text = r ? files[r] : undefined;
    if (text === undefined) return null;
    storage.ranges.push({ key, start, end });
    const all = enc.encode(text);
    return { bytes: all.subarray(Math.min(start, all.length), Math.min(end, all.length)), size: all.length };
  },
};
const runs = new Map(detail.runs.map((r) => [r.id, r]));
const fakeStore = {
  async listRuns() {
    return detail.runs.map((r) => ({
      id: r.id, work_item_id: ITEM, kind: r.kind, status: r.status, attempt: r.attempt, started_at: r.started_at, finished_at: r.finished_at, lease: null,
      outcome: r.status === "failed" ? { status: "failed", error_code: "checks_failed", detail: "npm test failed", infra: false } : { status: "succeeded", summary: "done", data: {} },
    }));
  },
  async listRunAttempts() {
    return [...runs.values()].map((r) => ({ run_id: r.id, attempt: 2, worker_id: "host:1:0" }));
  },
};
const scanner = new PatternEgressScanner(async () => []);
let bodies: string[] = [];

beforeEach(() => {
  bodies = [];
  storage.ranges = [];
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
  vi.stubGlobal("fetch", vi.fn(async (raw: string) => {
    const url = new URL(raw, "http://127.0.0.1");
    let value: unknown;
    let status = 200;
    const m = /^\/api\/v1\/items\/([^/]+)\/runs\/([^/]+)\/transcript$/.exec(url.pathname);
    if (m) {
      const r = await transcript({ store: fakeStore, scanner, storage }, decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), url.searchParams);
      status = r.status;
      value = r.value;
    } else if (url.pathname === `/api/v1/items/${ITEM}`) value = detail;
    else if (url.pathname === "/api/v1/overview") value = overview;
    else return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    const body = JSON.stringify(value);
    bodies.push(body);
    return new Response(body, { status, headers: { "content-type": "application/json" } });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const stepsNow = () => within(screen.getByRole("list", { name: "Transcript steps" })).getAllByRole("listitem");
const stepsOf = async () => within(await screen.findByRole("list", { name: "Transcript steps" })).getAllByRole("listitem");

describe("item page: Runs section", () => {
  it("lists kind, attempt, status, error, worker, started, took and tokens, and links a stored transcript", async () => {
    mount(`/app/items/${ITEM}`);
    const table = await screen.findByRole("table", { name: "Runs" });
    const head = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    for (const h of ["Kind", "Attempt", "Status", "Error", "Worker", "Started", "Took", "Tokens", "Transcript"]) expect(head).toContain(h);
    expect(head.indexOf("Kind")).toBeLessThan(head.indexOf("Attempt"));
    expect(head.indexOf("Worker")).toBeLessThan(head.indexOf("Tokens"));
    const failed = table.querySelector(`tr[data-run="${FAILED}"]`)!;
    expect(failed.textContent).toContain("checks_failed");
    expect(failed.textContent).toContain("host:1:0");
    expect(failed.textContent).toContain("1.5k");
    expect(within(failed).getByRole("link", { name: "Open" }).getAttribute("href")).toBe(`/app/items/${ITEM}/runs/${FAILED}`);
    expect(within(table.querySelector(`tr[data-run="run_none"]`)!).queryByRole("link")).toBeNull();

    fireEvent.click(within(failed).getByRole("link", { name: "Open" }));
    expect(location.pathname).toBe(`/app/items/${ITEM}/runs/${FAILED}`);
    expect(await screen.findByRole("status", { name: "Run outcome" })).toBeTruthy();
  });
});

describe("transcript view", () => {
  it("a failed run: the outcome at the top, then its steps in order", async () => {
    mount(`/app/items/${ITEM}/runs/${FAILED}`);
    const outcome = await screen.findByRole("status", { name: "Run outcome" });
    expect(outcome.textContent).toContain("Failed: checks_failed");
    expect(outcome.textContent).toContain("npm test failed");
    const steps = await stepsOf();
    // The outcome comes before the steps in the document.
    expect(outcome.compareDocumentPosition(steps[0]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(steps.map((s) => s.getAttribute("data-step"))).toEqual(["system", "text", "tool_use", "tool_result", "tool_use", "tool_result", "tool_use", "tool_result", "text", "result"]);
    expect(steps[6]!.textContent).toContain("npm test");
  });

  it("collapses assistant text past five lines and tool results by default, and highlights errors", async () => {
    mount(`/app/items/${ITEM}/runs/${FAILED}`);
    const steps = await stepsOf();
    const text = steps[1]!;
    expect(text.textContent).toContain("It decides the defaults.");
    expect(text.textContent).not.toContain("That is the plan.");
    fireEvent.click(within(text).getByRole("button", { name: /Show all 7 lines/ }));
    expect(text.textContent).toContain("That is the plan.");

    const result = steps[3]!;
    expect(result.textContent).not.toContain("DEFAULTS");
    const toggle = within(result).getByRole("button", { name: /Show result/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(result.textContent).toContain("export const DEFAULTS");

    expect(steps[7]!.getAttribute("data-error")).toBe("true");
    expect(steps[7]!.className).toMatch(/bg-red-50/);
    expect(steps[9]!.getAttribute("data-error")).toBe("true");
    expect(steps[2]!.getAttribute("data-error")).toBeNull();
  });

  it("a planted secret: its step shows [withheld: <rule>] and the secret is in neither the response nor the page", async () => {
    const { container } = mount(`/app/items/${ITEM}/runs/${LEAKY}`);
    const steps = await stepsOf();
    const withheld = steps.find((s) => s.textContent!.includes("[withheld: github_token]"))!;
    expect(withheld).toBeTruthy();
    expect(within(withheld).queryByRole("button")).toBeNull();
    expect(container.innerHTML).not.toContain(SECRET);
    expect(document.body.innerHTML).not.toContain(SECRET);
    for (const b of bodies) expect(b).not.toContain(SECRET);
    expect(steps[0]!.textContent).toContain("Checking the remote.");
  });

  it("jumps to the last 20 steps of a failed run, reading from the end", async () => {
    mount(`/app/items/${ITEM}/runs/${FAILED}`);
    await stepsOf();
    storage.ranges = [];
    fireEvent.click(screen.getByRole("button", { name: "Jump to the last 20 steps" }));
    await screen.findByRole("button", { name: "Show from the start" });
    const steps = await stepsOf();
    expect(steps.at(-1)!.getAttribute("data-step")).toBe("result");
    expect(steps.length).toBeLessThanOrEqual(20);
    // A size probe (0, 0) and the tail range: never a read from the start of a long file.
    expect(storage.ranges.length).toBeGreaterThan(0);
    expect(storage.ranges[0]).toMatchObject({ start: 0, end: 0 });
  });

  it("offers the jump only for a failed run", async () => {
    mount(`/app/items/${ITEM}/runs/${LEAKY}`);
    await stepsOf();
    expect(screen.queryByRole("button", { name: "Jump to the last 20 steps" })).toBeNull();
  });

  it("the step-type filter shows only matching steps", async () => {
    mount(`/app/items/${ITEM}/runs/${FAILED}`);
    await stepsOf();
    const group = screen.getByRole("group", { name: "Step type" });
    fireEvent.click(within(group).getByRole("button", { name: "Edits" }));
    await waitFor(() => expect(stepsNow().map((s) => s.textContent)).toEqual([expect.stringContaining("Edit")]));
    fireEvent.click(within(group).getByRole("button", { name: "Commands" }));
    await waitFor(() => expect(stepsNow().map((s) => s.textContent)).toEqual([expect.stringContaining("npm test")]));
    expect(within(group).getByRole("button", { name: "Commands" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("a transcript that is not stream-json shows as plain lines", async () => {
    mount(`/app/items/${ITEM}/runs/${PLAIN}`);
    const steps = await stepsOf();
    expect(steps.map((s) => s.querySelector("pre")!.textContent)).toEqual(["starting the agent", "not json: { broken", "step two finished"]);
    expect(screen.getByText(/shown as plain lines/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an unknown run shows the error without crashing", async () => {
    mount(`/app/items/${ITEM}/runs/run_nope`);
    expect((await screen.findByRole("alert")).textContent).toContain("404");
  });
});

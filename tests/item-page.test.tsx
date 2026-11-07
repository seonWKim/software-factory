// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { Markdown } from "../web/src/components/ui/markdown.js";

// The item page (design §9, issue #313): a split parent lists its phases and a phase links back to its parent;
// the spec triage wrote sits behind "spec written (show)" and renders as markdown, never as escaped JSON; the
// spec comment and PR link only for http(s) URLs; the Runs table names each run by kind and ID.

const AT = "2026-11-07T00:00:00.000Z";
const src = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
const base = (id: string, n: number, title: string, extra: object = {}) => ({
  id, source: src(n), title, stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0,
  restart_count: 0, token_cost: 0, pr_number: null, pr_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3,
  created_at: AT, updated_at: AT, ...extra,
});

// A fixture spec as triage writes it: a heading, a blank line, a list, and text that must not become HTML.
const PROBLEM = "## Problem\n\nThe page prints `JSON`.\n\nSecond paragraph with <b>raw html</b>.";
const DONE = ["Phases link to their pages", "No escaped JSON"];
const FILES = ["web/src/views/pages.tsx", "src/ui/api.ts"];

const DETAILS: Record<string, unknown> = {
  "/api/v1/items/wi_parent": {
    as_of: AT,
    item: base("wi_parent", 10, "Split parent", {
      spec_comment_url: "https://github.com/o/r/issues/10#issuecomment-5",
      pr_number: 12,
      pr_url: "https://github.com/o/r/pull/12",
      phases: [
        { id: "wi_p1", phase: 1, title: "First phase", stage: "RUNNING", source: src(11) },
        { id: "wi_p2", phase: 2, title: null, stage: "NEW", source: src(13) },
      ],
    }),
    timeline: [
      { version: 1, at: AT, actor: { kind: "system", id: "system" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null },
      {
        version: 2, at: AT, actor: { kind: "system", id: "system" }, reason: "triaged", detail: null,
        changes: {
          stage: { from: '"NEW"', to: '"READY"' },
          problem: { from: JSON.stringify("issue text"), to: JSON.stringify(PROBLEM) },
          done_criteria: { from: "null", to: JSON.stringify(DONE) },
          files_to_change: { from: "null", to: JSON.stringify(FILES) },
          scope: { from: "null", to: JSON.stringify("In scope: the item page.") },
        },
      },
    ],
    runs: [{ id: "run_triage_1", kind: "triage", status: "succeeded", attempt: 2, started_at: AT, finished_at: AT, created_at: AT, tokens: 10, error: null }],
  },
  "/api/v1/items/wi_p1": {
    as_of: AT,
    item: base("wi_p1", 11, "First phase", { parent_id: "wi_parent", phase: 1, spec_comment_url: "[withheld: github_token]", pr_number: 14, pr_url: "javascript:alert(1)" }),
    timeline: [],
    runs: [],
  },
};

beforeEach(() => {
  history.replaceState(null, "", "/app/");
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.split("?")[0]!;
    const body = DETAILS[path] ?? (path === "/api/v1/overview" ? { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } } : undefined);
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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

describe("item page: phases and parent", () => {
  it("a split parent lists its phases as links to their pages, and a phase links back to its parent", async () => {
    mount("/app/items/wi_parent");
    const phases = await screen.findByRole("list", { name: "Phases" });
    const links = within(phases).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["First phase", "/app/items/wi_p1"],
      ["o/r#13", "/app/items/wi_p2"],
    ]);
    fireEvent.click(links[0]!);
    const parent = await screen.findByTestId("parent");
    expect(parent.textContent).toContain("Phase 1");
    expect(within(parent).getByRole("link").getAttribute("href")).toBe("/app/items/wi_parent");
  });
});

describe("item page: timeline spec", () => {
  it("shows the spec collapsed behind 'spec written (show)' and renders it as markdown when opened, never escaped JSON", async () => {
    mount("/app/items/wi_parent");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    // Short changes read as words, not JSON text.
    expect(timeline.textContent).toContain("stage: NEW → READY");
    expect(timeline.textContent).toContain("stage: – → NEW");
    const toggle = within(timeline).getByRole("button", { name: "spec written (show)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(timeline.textContent).not.toContain("The page prints");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("spec written (hide)");
    const spec = timeline.querySelector<HTMLElement>("[data-spec]")!;
    for (const label of ["Problem", "Done criteria", "Files to change", "Scope"]) expect(within(spec).getAllByText(label).length).toBeGreaterThan(0);
    // The heading and the blank line render as a heading and paragraphs.
    expect(within(spec).getByRole("heading", { name: "Problem", level: 3 })).toBeTruthy();
    expect(within(spec).getByText("JSON").tagName).toBe("CODE");
    expect([...spec.querySelectorAll("li")].map((l) => l.textContent)).toEqual([...DONE, ...FILES]);
    // No escaped newline, no quote-wrapped JSON string or array, no HTML from the text.
    expect(timeline.textContent).not.toContain("\\n");
    expect(timeline.textContent).not.toContain('["');
    expect(timeline.textContent).not.toContain('"## Problem');
    expect(spec.querySelector("b")).toBeNull();
    expect(spec.textContent).toContain("<b>raw html</b>");
  });
});

describe("item page: links and runs", () => {
  it("links the spec comment and PR when the URL is http(s)", async () => {
    mount("/app/items/wi_parent");
    expect((await screen.findByRole("link", { name: "spec comment" })).getAttribute("href")).toBe("https://github.com/o/r/issues/10#issuecomment-5");
    expect(screen.getByRole("link", { name: "#12" }).getAttribute("href")).toBe("https://github.com/o/r/pull/12");
  });

  it("shows any other spec comment or PR URL as plain text", async () => {
    mount("/app/items/wi_p1");
    await screen.findByTestId("parent");
    expect(screen.queryByRole("link", { name: /spec comment/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /#14/ })).toBeNull();
    expect(screen.getByText(/spec comment \(\[withheld: github_token\]\)/)).toBeTruthy();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("the Runs table shows each run's kind and ID, its attempt and its status", async () => {
    mount("/app/items/wi_parent");
    const table = await screen.findByRole("table", { name: "Runs" });
    const run = table.querySelector<HTMLElement>('tr[data-run="run_triage_1"]')!;
    const cells = [...run.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells[0]).toContain("triage");
    expect(cells[0]).toContain("run_triage_1");
    expect(cells[1]).toContain("2");
    expect(cells[2]).toBe("succeeded");
  });
});

describe("Markdown", () => {
  it("escapes raw HTML and links only http(s) URLs; a javascript: link is plain text", () => {
    const { container } = render(
      <Markdown text={'<script>alert(1)</script> <img src=x onerror="alert(2)">\n\n[safe](https://example.com/a) [bad](javascript:alert(3)) [rel](/local) **bold**'} />,
    );
    expect(container.querySelector("script, img")).toBeNull();
    expect(container.textContent).toContain("<script>alert(1)</script>");
    const links = [...container.querySelectorAll("a")];
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["safe", "https://example.com/a"]]);
    expect(container.textContent).toContain("bad");
    expect(container.textContent).not.toContain("javascript:");
    expect(container.textContent).toContain("rel");
    expect(container.querySelector("strong")!.textContent).toBe("bold");
  });

  it("renders headings, lists, numbered lists and fenced code", () => {
    const { container } = render(<Markdown text={"# Title\n\n- one\n- two\n\n1. first\n2. second\n\n```\n<raw> code\n```"} />);
    expect(container.querySelector("h3")!.textContent).toBe("Title");
    expect([...container.querySelectorAll("ul > li")].map((l) => l.textContent)).toEqual(["one", "two"]);
    expect([...container.querySelectorAll("ol > li")].map((l) => l.textContent)).toEqual(["first", "second"]);
    expect(container.querySelector("pre code")!.textContent).toBe("<raw> code");
  });
});

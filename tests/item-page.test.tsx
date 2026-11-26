// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { Markdown } from "../web/src/components/ui/markdown.js";
import { NeedActions } from "../web/src/views/item-commands.js";

// The item page (design §9, issue #313): a split parent lists its phases and a phase links back to its parent;
// the spec triage wrote sits behind "spec written (show)" and renders as markdown, never as escaped JSON; the
// spec comment and PR link only for http(s) URLs; the Runs table names each run by kind and attempt. A waiting spec
// (issue #526) shows In short above Commands, its decisions as questions, and a confirm step before approve; Reject
// and Revise open a dialog (issue #527).

const AT = "2026-11-07T00:00:00.000Z";
const src = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
const base = (id: string, n: number, title: string, extra: object = {}) => ({
  id, source: src(n), title, stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0,
  restart_count: 0, token_cost: 0, change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3,
  created_at: AT, updated_at: AT, why: { code: "human", reason_code: "person", params: { reason: "Waiting for a person" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null }, ...extra,
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
      change_ref: "12",
      change_url: "https://github.com/o/r/pull/12",
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
  "/api/v1/items/wi_live": {
    as_of: AT,
    item: base("wi_live", 20, "Live interactive"),
    timeline: [],
    runs: [{ id: "run_i_1", kind: "interactive", status: "running", attempt: 1, started_at: AT, finished_at: null, created_at: AT, tokens: 0, error: null }],
  },
  "/api/v1/items/wi_done": {
    as_of: AT,
    item: base("wi_done", 21, "Finished interactive"),
    timeline: [],
    runs: [{ id: "run_i_2", kind: "interactive", status: "succeeded", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 0, error: null }],
  },
  "/api/v1/items/wi_closed": {
    as_of: AT,
    item: base("wi_closed", 40, "Rejected plan", {
      stage: "CLOSED", close_reason: "rejected", blocked_on: "none", blocked_reason: null, tier: null, item_phase: "rejected", restart_count: 0, loop_count: 0,
      why: { code: "closed", reason_code: "closed_as", params: { reason: "rejected" }, alarms: [], holder_id: null, next_actor: "none", refs: [], ref_url: null },
    }),
    timeline: [
      { version: 1, at: AT, actor: { kind: "system", id: "system" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null },
      { version: 2, at: AT, actor: { kind: "user", id: "local:someone" }, reason: "spec_rejected", changes: { stage: { from: '"READY"', to: '"CLOSED"' } }, detail: null },
    ],
    thread: [{ seq: 7, at: AT, kind: "command", author: "local:someone", role: "owner", channel: "local", anchor: "msg-7", body: "/reject out of scope" }],
    commands: [],
    runs: [],
  },
  "/api/v1/items/wi_about": {
    as_of: AT,
    item: base("wi_about", 30, "About spec", {
      request: "Item page shows what the work is about",
      spec: { problem: "The page shows no text about the work.", desired_output: "[withheld: github_token]", done_criteria: ["About shows the summary", "[withheld: github_token]", "Spec starts collapsed"] },
    }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_request": {
    as_of: AT,
    item: base("wi_request", 31, "Request only", { request: "Only the request so far", spec: null }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_withheld": {
    as_of: AT,
    item: base("wi_withheld", 32, "Flagged request", { request: "[withheld: github_token]", spec: null }),
    timeline: [],
    runs: [],
  },
  "/api/v1/items/wi_p1": {
    as_of: AT,
    item: base("wi_p1", 11, "First phase", { parent_id: "wi_parent", phase: 1, spec_comment_url: "[withheld: github_token]", change_ref: "14", change_url: "javascript:alert(1)" }),
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

/** The element at `selector`, once the page shows it. */
const found = (selector: string) =>
  waitFor(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`no ${selector} yet`);
    return el;
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
    // Short changes read as words, not JSON text, and only behind Details.
    const raw = [...timeline.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n");
    expect(raw).toContain("stage: NEW → READY");
    expect(raw).toContain("stage: – → NEW");
    const visible = timeline.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    expect(visible.textContent).not.toContain("NEW → READY");
    expect(visible.textContent).toContain("Created by the factory");
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
    expect((await screen.findByRole("link", { name: "Open the posted plan" })).getAttribute("href")).toBe("https://github.com/o/r/issues/10#issuecomment-5");
    expect(screen.getByRole("link", { name: "#12" }).getAttribute("href")).toBe("https://github.com/o/r/pull/12");
  });

  it("a closed item shows one status line with what closed it and a link to the reason, no commands sentence, and only facts with a value (issue #76)", async () => {
    mount("/app/items/wi_closed");
    const line = await waitFor(() => {
      const el = document.querySelector("[data-closed-status]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(line.textContent).toMatch(/^Closed: a person rejected the plan · /);
    expect(within(line as HTMLElement).getByRole("link", { name: "Read the reason" }).getAttribute("href")).toBe("#msg-7");
    expect(document.querySelector("[data-commands-none]")).toBeNull();
    expect(screen.queryByText(/^Closed: rejected$/)).toBeNull();
    const facts = [...document.querySelectorAll("[data-item-facts] dt")].map((d) => d.textContent);
    expect(facts).toEqual(["State", "Source", "Tokens", "Updated"]);
    expect(document.querySelector("[data-item-facts]")!.textContent).not.toContain("–");
  });

  it("an open item shows only the facts with a value: no dash, no zero", async () => {
    mount("/app/items/wi_live");
    const facts = await waitFor(() => {
      const dts = [...document.querySelectorAll("[data-item-facts] dt")].map((d) => d.textContent);
      expect(dts.length).toBeGreaterThan(0);
      return dts;
    });
    expect(facts).toContain("State");
    expect(facts).toContain("Updated");
    const dds = [...document.querySelectorAll("[data-item-facts] dd")].map((d) => d.textContent);
    expect(dds).not.toContain("–");
    expect(dds).not.toContain("0");
    expect(document.querySelector("[data-closed-status]")).toBeNull();
  });

  it("shows any other spec comment or PR URL as plain text", async () => {
    mount("/app/items/wi_p1");
    await screen.findByTestId("parent");
    expect(screen.queryByRole("link", { name: /posted plan/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /#14/ })).toBeNull();
    expect(screen.getByText(/Open the posted plan \(\[withheld: github_token\]\)/)).toBeTruthy();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("the Runs table shows each run as an ItemRow: its status, then its kind and attempt as the title, its ID only behind Copy ID", async () => {
    mount("/app/items/wi_parent");
    const table = await screen.findByRole("table", { name: "Runs" });
    const run = table.querySelector<HTMLElement>('tr[data-run="run_triage_1"]')!;
    const cells = [...run.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells[0]).toBe("Done");
    expect(cells[1]).toBe("Triage #2");
    expect(run.dataset.itemId).toBe("wi_parent");
    expect(run.textContent).not.toMatch(/run_|wi_/);
    fireEvent.click(within(run).getByRole("button", { name: "More actions: Triage #2" }));
    expect(within(run).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Copy ID"]);
  });
});

describe("item page: In short, decisions and the approve confirm (issue #526)", () => {
  const APPROVE = { name: "approve", usage: "/approve [notes]", description: "approve", allowed: true, reason: null };
  const SPEC = {
    in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
    decisions: [
      { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Fail the job", reason: "A failing job blocks merges.", owner_only: false },
      { question: "Name the step?", options: [], default: "scope", reason: "It shows in CI.", owner_only: false },
      { question: "Who owns the gate?", options: [], default: null, reason: null, owner_only: true },
    ],
  };
  let posts: { url: string; body: unknown }[];

  /** Serves wi_d with `blocked_reason` and the waiting spec (none at a block that is not the spec gate). */
  function serve(blocked_reason: string, stage = "READY") {
    const spec = blocked_reason === "spec_pending" || blocked_reason === "max_revisions" ? SPEC : null;
    const detail = { as_of: AT, item: base("wi_d", 30, "Decisions", { blocked_reason, stage }), timeline: [], runs: [], commands: [APPROVE], replies: [], spec };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        posts.push({ url: path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 3, command: "approve", work_item_id: "wi_d" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_d": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** Clicks Approve once it is enabled; returns the approve dialog, before anything is sent. */
  async function approve() {
    const button = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "Approve Decisions" });
    expect(posts).toEqual([]);
    return dialog;
  }

  const send = async (body: unknown) => {
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_d/commands", body }]));
  };

  it("shows In short above Commands, and each decision as a question: radios with the default selected and write my own, or a prefilled field", async () => {
    serve("spec_pending");
    mount("/app/items/wi_d");
    const commands = await screen.findByRole("region", { name: "Commands" });
    const inShort = screen.getByRole("region", { name: "In short" });
    expect(inShort.compareDocumentPosition(commands) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inShort.textContent).toContain("TO-BE: CI checks the scope.");
    const first = within(commands).getByRole("radiogroup", { name: "1. Fail the job, or only warn?" });
    const radios = within(first).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => r.parentElement!.textContent)).toEqual(["Fail the job(default)", "Only warn", "write my own"]);
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
    expect(commands.textContent).toContain("A failing job blocks merges.");
    expect((within(commands).getByRole("textbox", { name: "Answer 2" }) as HTMLInputElement).value).toBe("scope");
    expect((within(commands).getByRole("textbox", { name: "Answer 3" }) as HTMLInputElement).value).toBe("");
    // write my own opens a field for the answer.
    fireEvent.click(radios[2]!);
    fireEvent.change(within(first).getByRole("textbox", { name: "Answer 1" }), { target: { value: "Warn on docs only" } });
    expect(radios[2]!.checked).toBe(true);
  });

  it("a layout decision shows each option's sketch in monospace with the default marked; the others stay plain text", async () => {
    const SKETCH_A = "+--------+\n| Header |\n+--------+\n| Cards  |\n+--------+";
    const SKETCH_B = "+--------+\n| Header |\n+--------+\n| List   |\n+--------+";
    const layout = { question: "Which layout?", options: [SKETCH_A, SKETCH_B], default: SKETCH_B, reason: "A list scans faster.", owner_only: false, layout: true };
    SPEC.decisions.push(layout);
    try {
      serve("spec_pending");
      mount("/app/items/wi_d");
      const group = await screen.findByRole("radiogroup", { name: "4. Which layout?" });
      const sketches = [...group.querySelectorAll("pre")];
      expect(sketches.map((p) => p.textContent)).toEqual([SKETCH_A, SKETCH_B]);
      for (const p of sketches) expect(p.className).toContain("font-mono");
      const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
      expect(radios.map((r) => r.checked)).toEqual([false, true, false]);
      expect(radios[1]!.parentElement!.textContent).toBe(`${SKETCH_B}(default)`);
      expect(group.closest("fieldset")!.hasAttribute("data-layout")).toBe(true);
      const plain = screen.getByRole("radiogroup", { name: "1. Fail the job, or only warn?" });
      expect(plain.querySelector("pre")).toBeNull();
      expect(plain.closest("fieldset")!.hasAttribute("data-layout")).toBe(false);
    } finally {
      SPEC.decisions.pop();
    }
  });

  it("spec waiting for approval: the confirm names the answers and the defaults taken, then sends N: lines and the note", async () => {
    serve("spec_pending");
    mount("/app/items/wi_d");
    fireEvent.click(await screen.findByRole("radio", { name: "Only warn" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Answer 3" }), { target: { value: "the platform team" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "keep it small" } });
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the spec waiting for approval.");
    expect([...confirm.querySelectorAll("li")].map((l) => l.textContent)).toEqual([
      "1. Fail the job, or only warn? → Only warn (your answer)",
      "2. Name the step? → scope (default taken)",
      "3. Who owns the gate? → the platform team (your answer)",
    ]);
    expect(confirm.textContent).toContain("Next: The factory starts the implement run on this spec.");
    await send({ command: "approve", note: "1: Only warn\n2: scope\n3: the platform team\nkeep it small" });
  });

  it("spec at the revision limit: the confirm says it is approved as it is, and an unanswered decision with no default is named", async () => {
    serve("max_revisions");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the spec at the revision limit, as it is (no new revision).");
    expect(confirm.textContent).toContain("3. Who owns the gate? → no answer (no default)");
    expect(confirm.textContent).toContain("Next: The factory starts the implement run on this spec.");
    await send({ command: "approve", note: "1: Fail the job\n2: scope" });
  });

  it("floor block: the confirm names the tier raise and what happens next, with no decisions", async () => {
    serve("floor_tier", "RUNNING");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(screen.queryByRole("region", { name: "In short" })).toBeNull();
    expect(confirm.querySelector("[data-confirm-answers]")).toBeNull();
    expect(confirm.textContent).toContain("You approve a risk level raise to the risk level the floor check needs.");
    expect(confirm.textContent).toContain("Next: The item's risk level is raised and the implement run starts again.");
    await send({ command: "approve" });
  });

  it("Rule of Two hold: the confirm names the held run and that it starts", async () => {
    serve("rule_of_two", "RUNNING");
    mount("/app/items/wi_d");
    const confirm = await approve();
    expect(confirm.textContent).toContain("You approve the run held for a person by the Rule of Two.");
    expect(confirm.textContent).toContain("Next: The held run starts.");
    await send({ command: "approve" });
  });
});

beforeEach(() => {
  // jsdom has no showModal: open and close by the attribute.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
});

describe("item page: the Reject and Revise dialogs (issue #527)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
  let posts: { url: string; body: unknown }[];

  /** Serves wi_r at the spec gate with approve, revise and reject; `extra` sets the item's fields (a PR). */
  function serve(extra: object = {}) {
    const detail = {
      as_of: AT, item: base("wi_r", 40, "Forms", extra), timeline: [], runs: [], commands: ["approve", "revise", "reject"].map(cmd), replies: [], spec: { in_short: "AS-IS: a.\nTO-BE: b.", decisions: [] },
    };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { command: string };
        posts.push({ url: path, body });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 7, command: body.command, work_item_id: "wi_r" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_r": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** Clicks `name` once it is enabled; returns its dialog. */
  async function open(name: "reject" | "revise") {
    const label = name === "reject" ? "Reject" : "Revise";
    // Reject is in the item's "…" menu; Revise is a button of the row.
    const button = (await screen.findByRole("button", { name: name === "reject" ? "More commands" : label })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    if (name === "reject") fireEvent.click(await screen.findByRole("menuitem", { name: label }));
    return screen.getByRole("dialog", { name: `${label} Forms` });
  }

  it("Reject opens a Why? form with four reasons and a text box; the reason and the text are sent as the reject note", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("reject");
    expect(within(form).getByText("Why?")).toBeTruthy();
    const reasons = within(within(form).getByRole("radiogroup", { name: "Reason" })).getAllByRole("radio") as HTMLInputElement[];
    expect(reasons.map((r) => r.parentElement!.textContent)).toEqual(["not needed", "wrong approach", "duplicate", "too big; split it"]);
    const confirm = within(form).getByRole("button", { name: "Confirm reject" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(reasons[1]!);
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: " use the existing hook " } });
    expect(posts).toEqual([]);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_r/commands", body: { command: "reject", note: "wrong approach\nuse the existing hook" } }]));
  });

  it("free text alone is a reject note too; Cancel closes the form and sends nothing", async () => {
    serve();
    mount("/app/items/wi_r");
    let form = await open("reject");
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: "covered by #12" } });
    fireEvent.click(within(form).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
    form = await open("reject");
    fireEvent.change(within(form).getByRole("textbox", { name: "Reject details" }), { target: { value: "covered by #12" } });
    fireEvent.click(within(form).getByRole("button", { name: "Confirm reject" }));
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ command: "reject", note: "covered by #12" }]));
  });

  it("the Reject confirm says the item closes, and its PR too when it has one", async () => {
    serve();
    mount("/app/items/wi_r");
    let form = await open("reject");
    expect(form.querySelector("[data-dialog-consequence]")!.textContent).toBe("Rejecting closes this item.");
    cleanup();
    serve({ change_ref: "42", change_url: "https://github.com/o/r/pull/42" });
    mount("/app/items/wi_r");
    form = await open("reject");
    expect(form.querySelector("[data-dialog-consequence]")!.textContent).toBe("Rejecting closes this item and its PR #42, without a merge.");
  });

  it("after a Reject is sent, its outcome shows next to the Reject button", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("reject");
    fireEvent.click(within(form).getByRole("radio", { name: "duplicate" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm reject" }));
    const row = await found('[data-outcome-of="reject"]');
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Revise shows the spec sections, each with an optional comment box, and sends one revise with only the commented sections", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    expect([...form.querySelectorAll("[data-revise-section]")].map((x) => x.getAttribute("data-revise-section"))).toEqual(
      ["In short", "Problem", "Done when", "Scope", "Allowed paths"],
    );
    for (const s of ["In short", "Problem", "Done when", "Scope", "Allowed paths"]) expect(within(form).getByRole("textbox", { name: `Comment on ${s}` })).toBeTruthy();
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Problem" }), { target: { value: " Say why the gate is slow. " } });
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Allowed paths" }), { target: { value: "Also `docs/`." } });
    fireEvent.click(within(form).getByRole("button", { name: "Send revise" }));
    await waitFor(() => expect(posts).toEqual([{
      url: "/api/v1/items/wi_r/commands",
      body: { command: "revise", note: "### Problem\nSay why the gate is slow.\n\n### Allowed paths\nAlso `docs/`." },
    }]));
    const row = await found('[data-outcome-of="revise"]');
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
  });

  it("Revise's five comment boxes have distinct accessible names, one per section", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    const names = within(form).getAllByRole("textbox").map((t) => t.getAttribute("aria-label"));
    expect(names).toEqual(["In short", "Problem", "Done when", "Scope", "Allowed paths"].map((s) => `Comment on ${s}`));
    expect(new Set(names).size).toBe(names.length);
  });

  it("Revise stays disabled while no section has a comment; a blank comment does not count", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("revise");
    const send = within(form).getByRole("button", { name: "Send revise" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Scope" }), { target: { value: "   " } });
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    expect(posts).toEqual([]);
    fireEvent.change(within(form).getByRole("textbox", { name: "Comment on Done when" }), { target: { value: "Add a timing test." } });
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([{ command: "revise", note: "### Done when\nAdd a timing test." }]));
  });
});

describe("item page: refusals and the viewer's grants (issues #528, #453)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
  const STORED = "`/approve` was not applied: the spec is not waiting for approval (the item is triaging).";
  const NOT_OWNER = "only the owner may send this command (`not_owner`)";

  /** Serves wi_g with `detail`'s commands and replies. */
  function serve(detail: object) {
    const body = { as_of: AT, item: base("wi_g", 50, "Grants"), timeline: [], runs: [], commands: [], replies: [], spec: null, ...detail };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_g": body,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:helper", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const out = bodies[path];
      if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  it("a refusal shows as plain text beside its control, with no backticks; the stored text keeps them", async () => {
    const replies = [{ seq: 3, command: "approve", created_at: AT, handled_at: AT, refusal: STORED }];
    serve({ commands: [cmd("approve")], replies });
    mount("/app/items/wi_g");
    const row = await found('[data-outcome-of="approve"]');
    const shown = await waitFor(() => within(row).getByRole("alert"));
    expect(shown.textContent).toBe("/approve was not applied: the spec is not waiting for approval (the item is triaging).");
    expect(replies[0]!.refusal).toBe(STORED);
  });

  it("a command the owner check refuses is a disabled button with the controller's reason below the row, in plain text", async () => {
    serve({ commands: ["approve", "reject", "revise"].map((n) => ({ ...cmd(n), allowed: false, reason: NOT_OWNER })) });
    mount("/app/items/wi_g");
    await found('button[data-action="approve"]');
    for (const name of ["Approve", "Revise"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled, name).toBe(true);
    // Reject is in the "…" menu, disabled with its reason in its label.
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    const reject = screen.getByRole("menuitem", { name: /^Reject/ }) as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    expect(reject.textContent).toContain("only the owner may send this command (not_owner)");
    for (const name of ["approve", "revise"]) {
      expect(document.querySelector(`[data-outcome-of="${name}"]`)!.textContent).toContain("only the owner may send this command (not_owner)");
    }
    expect(document.querySelector("[data-decide]")!.textContent).not.toContain("`");
    expect(document.querySelector("[data-commands-none]")).toBeNull();
  });
});

describe("item page: the command box and pending proposals (design 09-dashboard-app)", () => {
  let posts: { url: string; body: unknown }[];
  const PROPOSALS = [
    { id: "prop_one", created_at: AT, commands: [{ index: 0, work_item_id: "wi_b", line: "/approve ship it" }, { index: 1, work_item_id: "wi_c", line: "/reject not needed" }] },
    { id: "prop_two", created_at: AT, commands: [{ index: 0, work_item_id: "wi_b", line: "/retry" }] },
  ];

  /** Serves wi_b, running (no command applies) or at the spec gate, with `proposals`; records every POST. */
  function serve(commands: string[], proposals: unknown[]) {
    const detail = {
      as_of: AT, item: base("wi_b", 50, "Box"), timeline: [], runs: [], replies: [], spec: null, proposals,
      commands: commands.map((name) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null })),
    };
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.split("?")[0]!;
      if (init?.method === "POST") {
        posts.push({ url: path, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ request_id: "app:x", seq: 9, command: "x", work_item_id: "wi_b" }), { status: 202, headers: { "content-type": "application/json" } });
      }
      const bodies: Record<string, unknown> = {
        "/api/v1/items/wi_b": detail,
        "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
        "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
      };
      const body = bodies[path];
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  }

  /** `name` in `scope` once it is enabled. */
  async function enabled(scope: HTMLElement, name: string) {
    const button = within(scope).getByRole("button", { name }) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    return button;
  }

  it("shows each pending proposal with its commands, a Confirm all and a Cancel; each press sends one request carrying its proposal ID", async () => {
    serve(["approve", "reject", "revise"], PROPOSALS);
    mount("/app/items/wi_b");
    const list = await screen.findByRole("list", { name: "Proposed commands" });
    const shown = [...list.querySelectorAll<HTMLElement>("[data-proposal]")];
    expect(shown.map((p) => p.dataset.proposal)).toEqual(["prop_one", "prop_two"]);
    expect(shown[0]!.textContent).toContain("/approve ship it");
    expect(shown[0]!.textContent).toContain("/reject not needed");
    expect(shown[0]!.textContent).toContain("wi_c");
    fireEvent.click(await enabled(shown[0]!, "Confirm all"));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_b/commands", body: { command: "proposal_confirm", proposal: "prop_one" } }]));
    fireEvent.click(await enabled(shown[1]!, "Cancel"));
    await waitFor(() => expect(posts.map((p) => p.body)).toEqual([
      { command: "proposal_confirm", proposal: "prop_one" },
      { command: "proposal_cancel", proposal: "prop_two" },
    ]));
    await waitFor(() => expect(within(shown[0]!).getByRole("status").textContent).toBe("sent"));
  });

  it("the one note box reads its words as a sentence on Ctrl+Enter, also when no typed command applies; an empty box sends nothing", async () => {
    serve(["approve"], []);
    mount("/app/items/wi_b");
    const box = (await screen.findByRole("textbox", { name: "Note" })) as HTMLTextAreaElement;
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByText("Say it in your own words")).toBeNull();
    expect(document.querySelector("[data-command-box]")).toBeNull();
    expect(screen.queryByRole("list", { name: "Proposed commands" })).toBeNull();
    await enabled(document.body, "Approve");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(posts).toEqual([]);
    fireEvent.change(box, { target: { value: "  approve wi_b but keep it small " } });
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_b/commands", body: { command: "sentence", note: "approve wi_b but keep it small" } }]));
    await waitFor(() => expect(box.value).toBe(""));
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

  it("folds a <details> block into a real fold, its summary and body as markdown, other HTML still text", () => {
    const { container } = render(<Markdown text={"<details><summary>What the PR contains</summary>\n\n- a **change**\n\n</details>\n\n<b>after</b>"} />);
    const fold = container.querySelector("details")!;
    expect(fold.querySelector("summary")!.textContent).toBe("What the PR contains");
    expect(fold.querySelector("ul > li strong")!.textContent).toBe("change");
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<b>after</b>");
  });

  it("marks the In short and Decisions for you sections, up to the next heading of their level", () => {
    const { container } = render(<Markdown text={"### In short (AS-IS → TO-BE)\nAS-IS: old\nTO-BE: new\n\n### Problem\nwhy\n\n### Decisions for you\n- pick one\n\n### Done when\n- done"} />);
    const callouts = [...container.querySelectorAll("[data-callout]")];
    expect(callouts.map((c) => c.getAttribute("data-callout"))).toEqual(["summary", "attention"]);
    expect(callouts[0]!.textContent).not.toContain("why");
    expect(callouts[1]!.textContent).toContain("pick one");
    expect(callouts[1]!.textContent).not.toContain("done");
  });

  it("shows AS-IS and TO-BE on separate lines when they arrive in one paragraph", () => {
    const { container } = render(<Markdown text={"AS-IS: the old way →\nTO-BE: the new way"} />);
    expect([...container.querySelectorAll("p")].map((p) => p.textContent)).toEqual(["AS-IS: the old way", "TO-BE: the new way"]);
  });
});

describe("item page: Interactive task badge", () => {
  it("a running interactive run shows the badge in the header and the label as the run's kind", async () => {
    mount("/app/items/wi_live");
    const table = await screen.findByRole("table", { name: "Runs" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(within(heading.parentElement!.parentElement!).getByText("Interactive task")).toBeTruthy();
    const cell = table.querySelector<HTMLElement>('tr[data-run="run_i_1"] [data-cell-title]')!;
    expect(cell.textContent).toContain("Interactive task");
    expect(cell.textContent).not.toMatch(/\binteractive\b/);
  });

  it("a finished interactive run shows no header badge, only the kind label in the table", async () => {
    mount("/app/items/wi_done");
    const table = await screen.findByRole("table", { name: "Runs" });
    // No header badge: the run's title is the only text that names it.
    expect(screen.queryAllByText("Interactive task")).toHaveLength(0);
    expect(table.querySelector('tr[data-run="run_i_2"] [data-cell-title]')!.textContent).toBe("Interactive task #1");
  });
});

describe("item page: timeline and Runs in plain words", () => {
  const ME = "local:me";
  const entry = (version: number, reason: string, actor: { kind: string; id: string }, changes = {}) => ({ version, at: AT, actor, reason, changes, detail: null });
  const run = (id: string, kind: string, status: string, attempt: number, error = null) => ({ id, kind, status, attempt, started_at: AT, finished_at: AT, created_at: AT, tokens: 5, error });

  /** Every reason literal the controller's units write, but the two that are not timeline reasons (a redeem-code refusal, a run attempt's). */
  function controllerReasons(): string[] {
    const dir = join(import.meta.dirname, "..", "src", "controller", "units");
    const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".unit.ts"));
    return [...new Set(files.flatMap((f) => [...readFileSync(join(dir, String(f)), "utf8").matchAll(/\breason: "([a-z_]+)"/g)].map((m) => m[1]!)))];
  }

  /** The item page with a timeline and runs, the viewer being `ME`; the page's element once its timeline shows. */
  async function serveWords(timeline: unknown[], runs: unknown[]) {
    const detail = { as_of: AT, item: base("wi_w", 40, "Words"), timeline, runs, commands: [], replies: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const body = path === "/api/v1/items/wi_w" ? detail : path === "/api/v1/session" ? { as_of: AT, csrf_token: "t", commands_enabled: true, actor: ME, actor_source: "environment" } : path === "/api/v1/overview" ? { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } } : undefined;
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    mount("/app/items/wi_w");
    return screen.findByRole("region", { name: "Timeline" });
  }

  /** A section's text without its Details. */
  const visible = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    return copy.textContent ?? "";
  };

  it("has a sentence for every reason the controller writes, and shows no snake_case word outside Details", async () => {
    const { en } = await import("../web/src/i18n/en.js");
    const reasons = [...new Set([...controllerReasons().filter((r) => r !== "invalid" && r !== "lease_expired"), "intake", "interactive_takeover"])];
    expect(reasons.filter((r) => !(`timeline.${r}` in en))).toEqual([]);
    const timeline = await serveWords(reasons.map((r, i) => entry(i + 1, r, { kind: "user", id: ME })), []);
    const rows = [...timeline.querySelectorAll("li")].filter((li) => li.parentElement?.tagName === "OL");
    expect(rows).toHaveLength(reasons.length);
    for (const row of rows) expect(visible(row)).not.toMatch(/[a-z]+_[a-z_]+/);
  });

  it("reads the viewer's actions as 'You …' and another person's as 'A person …', and an unknown reason as Changed", async () => {
    const timeline = await serveWords([
      entry(1, "retry_requested", { kind: "user", id: ME }, { blocked_on: { from: '"human"', to: '"none"' } }),
      entry(2, "interactive_takeover", { kind: "user", id: ME }),
      entry(3, "intake", { kind: "user", id: ME }),
      entry(4, "retry_requested", { kind: "user", id: "github:77", name: "Dana Smith" }),
      entry(5, "brand_new_reason", { kind: "system", id: "system" }),
    ], []);
    const text = visible(timeline);
    for (const s of ["You asked for a retry", "You took over in a terminal", "Created by you", "A person asked for a retry", "Changed"]) expect(text).toContain(s);
    expect(text).not.toContain("Dana");
    expect(text).not.toContain("brand_new_reason");
    expect(text).not.toContain("blocked_on");
    const raw = [...timeline.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n");
    expect(raw).toContain("blocked_on: human → none");
    expect(raw).toContain("brand_new_reason");
  });

  it("the Runs rows read Status / Run / Detail, fold consecutive cancelled tries, and show one error line", async () => {
    await serveWords([], [
      run("run_a", "implement", "canceled", 0),
      run("run_b", "implement", "canceled", 0),
      run("run_c", "implement", "canceled", 0),
      run("run_d", "implement", "failed", 1, { code: "schedule_to_close", detail: "run run_d passed its schedule_to_close deadline 2026-11-16T22:39:21.171Z" }),
      run("run_e", "implement", "failed", 2, { code: "some_unlisted_code", detail: "long text" }),
    ]);
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(within(table).getAllByRole("columnheader").slice(0, 3).map((h) => h.textContent)).toEqual(["Status", "Run", "Detail"]);
    const rows = [...table.querySelectorAll<HTMLElement>("tr[data-run]")];
    expect(rows.map((r) => r.getAttribute("data-run"))).toEqual(["run_e", "run_d", "run_c"]);
    const folded = rows[2]!;
    expect(folded.querySelectorAll("td")[0]!.textContent).toBe("Stopped");
    expect(folded.textContent).toContain("3 tries");
    expect(folded.textContent).not.toMatch(/run_/);
    const timedOut = rows[1]!;
    expect(visible(timedOut)).toContain("Timed out before it started");
    expect(visible(timedOut)).not.toMatch(/2026-11-16|schedule_to_close/);
    expect(timedOut.querySelector("[data-raw]")?.textContent).toContain("2026-11-16T22:39:21.171Z");
    expect(rows[0]!.querySelector("[data-row-second]")!.textContent).toContain("Failed");
    expect(visible(rows[0]!)).not.toContain("some_unlisted_code");
  });

});

describe("item page: About (the request and the approved spec)", () => {
  it("a request with an approved spec: About under the title with the summary line, the spec collapsed", async () => {
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Item page shows what the work is about");
    // Under the title: About comes before the decision box and every other Card.
    const regions = [...document.querySelectorAll("section[aria-label]")];
    expect(regions[0]).toBe(about);
    const toggle = about.querySelector("summary")!;
    expect(toggle.textContent).toBe("Approved spec");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(about.querySelector("details")!.open).toBe(false);
    expect(within(about).queryAllByRole("button")).toEqual([]);
    expect(about.textContent).not.toMatch(/wi_about/);
  });

  it("expanding the spec shows the problem, the desired output and each done criterion as a list item", async () => {
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    fireEvent.click(about.querySelector("summary")!);
    expect(about.querySelector("details")!.open).toBe(true);
    for (const label of ["Problem", "Desired output", "Done criteria"]) expect(within(about).getByText(label)).toBeTruthy();
    expect(about.textContent).toContain("The page shows no text about the work.");
    const items = within(within(about).getByRole("list", { name: "Done criteria" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["About shows the summary", "Withheld: the egress scan flagged this text.", "Spec starts collapsed"]);
  });

  it("a withheld text shows the withheld note, never the marker", async () => {
    mount("/app/items/wi_withheld");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Withheld: the egress scan flagged this text.");
    expect(about.textContent).not.toContain("[withheld");
    // The spec's withheld desired output and criterion read the same way.
    cleanup();
    mount("/app/items/wi_about");
    const spec = await screen.findByRole("region", { name: "About" });
    fireEvent.click(spec.querySelector("summary")!);
    expect(spec.querySelectorAll("[data-withheld]").length).toBe(2);
    expect(spec.textContent).not.toContain("[withheld");
  });

  it("a request with no approved spec: About with the summary only, no spec Disclosure", async () => {
    mount("/app/items/wi_request");
    const about = await screen.findByRole("region", { name: "About" });
    expect(about.textContent).toContain("Only the request so far");
    expect(about.querySelector("details")).toBeNull();
  });

  it("an item with neither a request nor a spec shows no About", async () => {
    mount("/app/items/wi_done");
    await screen.findByRole("table", { name: "Runs" });
    expect(screen.queryByRole("region", { name: "About" })).toBeNull();
  });

  it("at 390 px the About text wraps (break-words)", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    mount("/app/items/wi_about");
    const about = await screen.findByRole("region", { name: "About" });
    const summary = about.querySelector<HTMLElement>("[data-about-request] p")!;
    expect(summary.className).toContain("break-words");
    expect(about.className).toContain("min-w-0");
  });
});

describe("Needs you: an over-cap Approve opens the note dialog (design 09-dashboard-item-commands, 2026-11-24)", () => {
  const OVER = { sizes: { lines: 5000, files: 60 }, caps: { max_diff_lines: 1500, max_diff_files: 40 }, one_time_cap: { max_diff_lines: 5883, max_diff_files: 71 } };
  const approve = (extra: object = {}) => ({ name: "approve", usage: "/approve", description: "d", allowed: true, reason: null, ...extra });
  const reject = { name: "reject", usage: "/reject", description: "d", allowed: true, reason: null };

  /** Renders a Needs-you row's actions with `commands`; returns what it sent. */
  function row(commands: object[]) {
    const sent: [string, string][] = [];
    const cmd = { on: true, busy: false, local: {}, send: async (c: string, n: string) => (sent.push([c, n]), true) };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <NeedActions id="wi_1" title="Big change" commands={commands} pr={null} group="approve" checking={false} cmd={cmd} allow={[]} />
      </QueryClientProvider>,
    );
    return sent;
  }
  const menuApprove = async () => {
    fireEvent.click(screen.getByRole("button", { name: "More commands" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Approve" }));
  };

  it("the menu's Approve opens the dialog with the size, the cap, the one-time cap and a note; Confirm waits for the note and sends it trimmed", async () => {
    const sent = row([approve({ over_cap: OVER }), reject]);
    await menuApprove();
    const dialog = await screen.findByRole("dialog", { name: "Approve Big change" });
    expect(sent).toEqual([]);
    const facts = dialog.querySelector("[data-over-cap]")!.textContent;
    expect(facts).toContain("5000 lines in 60 files");
    expect(facts).toContain("1500 lines in 40 files");
    expect(facts).toContain("5883 lines in 71 files");
    const confirm = within(dialog).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Why approve it over the cap" }), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Why approve it over the cap" }), { target: { value: "  one generated table  " } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(sent).toEqual([["approve", "one generated table"]]));
  });

  it("the p key's hidden button opens the same dialog and sends nothing", async () => {
    const sent = row([approve({ over_cap: OVER })]);
    fireEvent.click(document.querySelector<HTMLElement>("[data-shortcut=p]")!);
    expect(await screen.findByRole("dialog", { name: "Approve Big change" })).toBeTruthy();
    expect(sent).toEqual([]);
  });

  it("an Approve that is not over the caps sends at once, with no dialog", async () => {
    const sent = row([approve(), reject]);
    await menuApprove();
    await waitFor(() => expect(sent).toEqual([["approve", ""]]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

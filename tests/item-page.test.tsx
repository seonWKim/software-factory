// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { Markdown } from "../web/src/components/ui/markdown.js";

// The item page (design §9, issue #313): a split parent lists its phases and a phase links back to its parent;
// the spec triage wrote sits behind "spec written (show)" and renders as markdown, never as escaped JSON; the
// spec comment and PR link only for http(s) URLs; the Runs table names each run by kind and ID. A waiting spec
// (issue #526) shows In short above Commands, its decisions as questions, and a confirm step before approve; Reject
// and Revise have their own forms (issue #527).

const AT = "2026-11-07T00:00:00.000Z";
const src = (n: number) => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });
const base = (id: string, n: number, title: string, extra: object = {}) => ({
  id, source: src(n), title, stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0,
  restart_count: 0, token_cost: 0, change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3,
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

describe("item page: In short, decisions and the approve confirm (issue #526)", () => {
  const APPROVE = { name: "approve", usage: "/approve [notes]", description: "approve" };
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

  /** Clicks approve once it is enabled; returns the confirm step, before anything is sent. */
  async function approve() {
    const button = await screen.findByRole("button", { name: "approve" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    const confirm = await screen.findByRole("group", { name: "Confirm approve" });
    expect(posts).toEqual([]);
    return confirm;
  }

  const send = async (body: unknown) => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm approve" }));
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
    expect(confirm.textContent).toContain("You approve a tier raise to the tier the floor check needs.");
    expect(confirm.textContent).toContain("Next: The item's tier is raised and the implement run starts again.");
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

describe("item page: the Reject and Revise forms (issue #527)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name });
  let posts: { url: string; body: unknown }[];

  /** Serves wi_r at the spec gate with approve, revise and reject; `extra` sets the item's fields (a PR). */
  function serve(extra: object = {}) {
    const detail = {
      as_of: AT, item: base("wi_r", 40, "Forms", extra), timeline: [], runs: [], commands: ["approve", "revise", "reject"].map(cmd), replies: [], spec: null,
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

  /** Clicks `name` once it is enabled; returns its form. */
  async function open(name: "reject" | "revise") {
    const button = (await screen.findByRole("button", { name })) as HTMLButtonElement;
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    return screen.getByRole("group", { name: name === "reject" ? "Why reject?" : "Revise the spec" });
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
    expect(screen.queryByRole("group", { name: "Why reject?" })).toBeNull();
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
    expect(form.querySelector("[data-reject-closes]")!.textContent).toBe("Rejecting closes this item.");
    cleanup();
    serve({ change_ref: "42", change_url: "https://github.com/o/r/pull/42" });
    mount("/app/items/wi_r");
    form = await open("reject");
    expect(form.querySelector("[data-reject-closes]")!.textContent).toBe("Rejecting closes this item and its PR #42, without a merge.");
  });

  it("after a Reject is sent, its outcome shows next to the Reject button", async () => {
    serve();
    mount("/app/items/wi_r");
    const form = await open("reject");
    fireEvent.click(within(form).getByRole("radio", { name: "duplicate" }));
    fireEvent.click(within(form).getByRole("button", { name: "Confirm reject" }));
    const row = document.querySelector<HTMLElement>('[data-command="reject"]')!;
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
    expect(screen.queryByRole("group", { name: "Why reject?" })).toBeNull();
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
    const row = document.querySelector<HTMLElement>('[data-command="revise"]')!;
    await waitFor(() => expect(within(row).getByRole("status").textContent).toBe("sent"));
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

describe("item page: refusals and the viewer's grants (issue #528)", () => {
  const cmd = (name: string) => ({ name, usage: `/${name}`, description: name });
  const STORED = "`/approve` was not applied: the spec is not waiting for approval (the item is triaging).";
  const WITHHELD = {
    names: ["approve", "reject", "revise"],
    reason: "local:helper has no role that allows it (`no_role`); the local owner can grant one with `factory users add local:helper --role approver`",
  };

  /** The element at `selector`, once the page shows it. */
  const found = (selector: string) =>
    waitFor(() => {
      const el = document.querySelector<HTMLElement>(selector);
      if (!el) throw new Error(`no ${selector} yet`);
      return el;
    });

  /** Serves wi_g with `detail`'s commands, replies and withheld commands. */
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
    const row = await found('[data-command="approve"]');
    const shown = await waitFor(() => within(row).getByRole("alert"));
    expect(shown.textContent).toBe("/approve was not applied: the spec is not waiting for approval (the item is triaging).");
    expect(replies[0]!.refusal).toBe(STORED);
  });

  it("commands the viewer's grants leave out get no control, only one plain line naming them and the controller's reason", async () => {
    serve({ commands: [], commands_withheld: WITHHELD });
    mount("/app/items/wi_g");
    const note = await found("[data-commands-withheld]");
    expect(note.textContent).toBe(
      "Not shown for you: approve, reject, revise. local:helper has no role that allows it (no_role); the local owner can grant one with factory users add local:helper --role approver.",
    );
    for (const name of ["approve", "reject", "revise"]) expect(screen.queryByRole("button", { name })).toBeNull();
    expect(document.querySelector("[data-commands-none]")).toBeNull();
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

// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImproveView, RuleEntryView, RulesView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-users-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/rules.js";
const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

// The Rules page (issue #571): the pending entries in two groups, rule candidates (C-) and structure proposals (P-),
// each under its line on what promoting one does; each card with its title, state, ID and one line of what it would
// change, and its detail (what, before → after, why, evidence, where, related; an empty part left out) read from GET /api/v1/rules/entry only when the card opens. Promote, Hold and Reject ask for a
// reason in a dialog before they send; Promote of a class (C-) sends the owner's wording, default and exception (the
// last two prefilled from its draft), Promote of a proposal (P-) shows its Now and Proposed lines and sends only the
// reason. A judged entry shows its decision and no
// verdict buttons; a class whose draft could not be read offers no Promote. With the ledger off (design 08-settings): a
// picker over the known agents homes shows the chosen one's check, and one primary Turn on, when the home in use is
// found, writes the `integrations` entry through POST /api/v1/settings and loads the rules with no reload.

const TOKEN = "tok_rules";
const SLOW = { timeout: 5_000 };
const AT = "2026-11-07T00:00:00.000Z";

const view = (over: Partial<RulesView> = {}): RulesView => ({
  enabled: true,
  applied: null,
  error: null,
  csrf_token: TOKEN,
  judge: null,
  home: null,
  turn_on: null,
  entries: [
    { id: "P-0007", title: "Split the review prompt", state: "held", kind: "edit-asset", target: "prompts/review.md", judged: null, draft: null, draft_error: null },
    {
      id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: null, draft_error: null,
      draft: { default: "Keep every flag.", exception: "a deprecated flag", incidents: ["T-1"], scope: "CLI" },
    },
  ],
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current: RulesView;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };
let gets: string[];
/** GET /api/v1/rules/entry's answer: a detail view, one per ID, or an HTTP status for a failed read. */
let detail: RuleEntryView | number | ((id: string) => RuleEntryView);

beforeEach(() => {
  current = view();
  posts = [];
  gets = [];
  detail = { id: "C-012", error: null, detail: null };
  answer = { status: 200, body: { id: "C-012", verdict: "promote" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      // The settings route's answer to Turn on: the ledger is on from the next GET.
      if (url === "/api/v1/settings" && answer.status === 200) current = view();
      return json(answer.status, answer.body);
    }
    gets.push(url);
    if (url === "/api/v1/rules") return json(200, current);
    if (url === "/api/v1/standing") return json(200, { as_of: AT, csrf_token: TOKEN, rules: [], proposals: [] });
    if (url.startsWith("/api/v1/rules/entry?")) {
      if (typeof detail === "number") return json(detail, { error: "boom" });
      return json(200, typeof detail === "function" ? detail(new URL(url, "http://x").searchParams.get("id")!) : detail);
    }
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-rule="${id}"]`)!;
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-dialog]")!;
const sent = () => posts.map((p) => JSON.parse(String(p.init.body)));

describe("Rules page", () => {
  it("is a sidebar page at /app/rules", () => {
    expect(routeFor("/app/rules").page.label).toBe("Rules");
    expect(PAGES.map((p) => p.path)).toContain("rules");
  });

  it("groups candidates and proposals, each under its line; each card shows its title, state, ID and what it would change", async () => {
    await show();
    const classes = await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    const proposals = screen.getByRole("list", { name: "Structure proposals" });
    expect(within(classes).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["C-012"]);
    expect(within(proposals).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["P-0007"]);
    // Candidates first, each group with its one line on what promoting one does.
    const groups = screen.getAllByRole("region").map((r) => [r.getAttribute("aria-label"), r.querySelector("[data-group-line]")!.textContent]);
    expect(groups).toEqual([
      ["Rule candidates", "Promoting a candidate adds its rule to every run's prompt from the next run on."],
      ["Structure proposals", "Promoting a proposal shows its before and after, then applies it to the target file once you confirm."],
    ]);
    expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    expect(card("C-012").textContent).toContain("Pending");
    expect(card("C-012").textContent).toContain("C-012");
    // The card does not repeat its title in a "Rule: …" line; a proposal still says its kind and target.
    expect(card("C-012").querySelector("[data-rule-what]")).toBeNull();
    expect(card("C-012").textContent).not.toContain("Rule:");
    // Title first, then the state badge, then the ID.
    const order = [...card("C-012").firstElementChild!.children].map((c) => c.textContent);
    expect(order).toEqual(["Keep existing CLI flags.", "Pending", "C-012"]);
    expect(card("P-0007").textContent).toContain("Held");
    expect(card("P-0007").querySelector("[data-rule-title]")!.textContent).toBe("Split the review prompt");
    expect(card("P-0007").querySelector("[data-rule-what]")!.textContent).toBe("edit-asset: prompts/review.md");
    // No detail is read on page load.
    expect(gets.filter((u) => u.includes("/rules/entry"))).toEqual([]);
    expect(document.querySelector("[data-rule-detail]")).toBeNull();
  });

  it("opening a card reads its detail on demand and shows before → after, why, evidence and where in that order", async () => {
    detail = {
      id: "C-012", error: null,
      detail: {
        id: "C-012", default: "Keep every existing CLI flag.", exceptions: "a deprecated flag", incidents: 3, evidence: [{ ref: "T-1", quote: "keep --json" }],
        root_reason: "renames skip callers", scope: "software, CLI",
      },
    };
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    const toggle = within(card("C-012")).getByRole("button", { name: "Why and where" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(card("C-012").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(gets.filter((u) => u.includes("/rules/entry"))).toEqual(["/api/v1/rules/entry?id=C-012"]);
    const parts = [...card("C-012").querySelectorAll<HTMLElement>("[data-detail-part]")];
    expect(parts.map((p) => p.dataset.detailPart)).toEqual(["change", "why", "evidence", "where"]);
    expect(parts.map((p) => p.querySelector("h3")!.textContent)).toEqual(["Before → after", "Why", "Evidence", "Where it applies"]);
    expect(parts[0]!.textContent).toContain("Rule: Keep every existing CLI flag.");
    expect(parts[0]!.textContent).toContain("Except: a deprecated flag");
    const why = parts[1]!.textContent!;
    expect(why.indexOf("Came up 3 times.")).toBeLessThan(why.indexOf("Root reason: renames skip callers"));
    expect(parts[2]!.querySelector("blockquote[data-quote]")!.textContent).toBe("keep --json");
    expect(parts[3]!.textContent).toContain("software, CLI");
  });

  it("a proposal's detail shows its kind and target; Why and Where it applies are left out when the ledger gives nothing, with no \"not given\"", async () => {
    detail = { id: "P-0007", error: null, detail: { id: "P-0007" } };
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-0007")).getByRole("button", { name: "Why and where" }));
    await waitFor(() => expect(card("P-0007").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    const part = (name: string) => card("P-0007").querySelector(`[data-detail-part="${name}"]`);
    expect(part("what")!.textContent).toContain("Kind: edit-asset");
    expect(part("what")!.textContent).toContain("Changes: prompts/review.md");
    for (const name of ["why", "where", "change", "evidence", "related"]) expect(part(name)).toBeNull();
    expect(card("P-0007").querySelector("[data-rule-detail]")!.textContent).not.toContain("not given");
    expect(card("P-0007").querySelector("[data-detail-description]")).toBeNull();
  });

  for (const [name, answerWith] of [
    ["returns nothing", { id: "C-012", detail: null, error: null }],
    ["fails in the ledger", { id: "C-012", detail: null, error: "The detail could not be read: evolve show exited 5" }],
    ["fails over HTTP", 502],
  ] as const) {
    it(`a show that ${name}: the card keeps its title and says the detail could not be read`, async () => {
      detail = answerWith;
      await show();
      await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
      fireEvent.click(within(card("C-012")).getByRole("button", { name: "Why and where" }));
      await waitFor(() => expect(card("C-012").querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
      expect(card("C-012").querySelector("[data-rule-detail]")!.textContent).toBe("The detail could not be read.");
      expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    });
  }

  it("a verdict button asks for a reason before it sends; promote of a class sends the edited wording, default and exception", async () => {
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: "Promote" }));
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(posts).toEqual([]);
    const wording = within(dialog()).getByRole("textbox", { name: "Rule wording" }) as HTMLTextAreaElement;
    expect(wording.value).toBe("Keep existing CLI flags.");
    fireEvent.change(wording, { target: { value: "Keep every existing CLI flag." } });
    const dflt = within(dialog()).getByRole("textbox", { name: "Default" }) as HTMLTextAreaElement;
    const exception = within(dialog()).getByRole("textbox", { name: "Exception" }) as HTMLTextAreaElement;
    expect([dflt.value, exception.value]).toEqual(["Keep every flag.", "a deprecated flag"]);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "seen twice" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.change(exception, { target: { value: " " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(exception, { target: { value: "a flag marked deprecated" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/rules/verdict");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(sent()).toEqual([{
      id: "C-012", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag.", default: "Keep every flag.", exception: "a flag marked deprecated",
    }]);
  });

  it("a judged entry shows its decision and no verdict buttons; a class with no draft offers no Promote", async () => {
    current = view({
      entries: [
        { id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: "promote", draft: null, draft_error: null },
        { id: "C-013", title: "Summary first.", state: "pending", judged: null, draft: null, draft_error: "evolve show exited 1: no class" },
      ],
    });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    expect(card("C-012").querySelector("[data-judged]")!.textContent).toBe("Judged: promote");
    expect(card("C-012").textContent).not.toContain("Pending");
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Why and where"]);
    expect(card("C-013").querySelector("[data-draft-error]")!.textContent).toContain("evolve show exited 1");
    expect((within(card("C-013")).getByRole("button", { name: "Promote" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card("C-013")).getByRole("button", { name: "Hold" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hold and reject send only the reason; they ask for no wording and no applied-to file", async () => {
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    for (const [label, reason] of [["Hold", "wait"], ["Reject", "not code"]] as const) {
      fireEvent.click(within(card("P-0007")).getByRole("button", { name: label }));
      for (const name of ["Rule wording", "Default", "Exception", "Applied to"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
      fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: reason } });
      fireEvent.click(within(dialog()).getByRole("button", { name: `Send ${label.toLowerCase()}` }));
      await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    }
    expect(sent()).toEqual([
      { id: "P-0007", verdict: "hold", reason: "wait" },
      { id: "P-0007", verdict: "reject", reason: "not code" },
    ]);
  });

  it("promote of a proposal shows its Now and Proposed lines, asks for no wording or file, and sends only the reason; with no lines Send is off", async () => {
    current = view({
      entries: [{ id: "P-20261101-158e", title: "Quiet notify", state: "open", kind: "edit-asset", target: "private/bin/notify", judged: null, draft: null, draft_error: null },
        { id: "P-0009", title: "No lines", state: "open", kind: "edit-asset", target: "x.md", judged: null, draft: null, draft_error: null }],
    });
    detail = (id) => ({ id, error: null, detail: id === "P-0009" ? { id } : { id, target: "private/bin/notify", current: "notify --loud", proposed: "notify --quiet" } });
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-20261101-158e")).getByRole("button", { name: "Promote" }));
    for (const name of ["Rule wording", "Default", "Exception", "Applied to"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting replaces the Now lines with the Proposed lines in the target file, then records the verdict. If the Now lines are not there exactly once, or evolve refuses, nothing is written and the error shows here.",
    );
    await waitFor(() => expect(dialog().querySelector('[data-change="proposed"]')!.textContent).toBe("notify --quiet"), SLOW);
    expect(dialog().querySelector('[data-change="current"]')!.textContent).toBe("notify --loud");
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "good shape" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(sent()).toEqual([{ id: "P-20261101-158e", verdict: "promote", reason: "good shape" }]);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());

    fireEvent.click(within(card("P-0009")).getByRole("button", { name: "Promote" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toBe("Promote is off: this proposal gives no Now and Proposed lines to apply.");
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    expect((within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed apply keeps the dialog open with the CLI's error", async () => {
    detail = (id) => ({ id, error: null, detail: { id, target: "prompts/review.md", current: "a", proposed: "b" } });
    answer = { status: 502, body: { error: "The ledger refused the verdict: evolve verdict exited 1: evolve: P-0007 was judged already" } };
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-0007")).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(dialog().querySelector('[data-change="proposed"]')).not.toBeNull(), SLOW);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send promote" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("evolve: P-0007 was judged already");
  });

  it("promote of a class keeps its own help text and has no Applied to field", async () => {
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: "Promote" }));
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting writes this rule into your rules file, records the verdict and runs sync-agents; it is part of every run's prompt from the next run on.",
    );
    expect(within(dialog()).queryByRole("textbox", { name: "Applied to" })).toBeNull();
  });

  it("a refusal stays in the dialog", async () => {
    answer = { status: 403, body: { error: "Only the owner judges rules; you are local:alice." } };
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: "Hold" }));
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send hold" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
  });

  it("a user who is not the owner sees the entries read-only with the reason, and no verdict buttons", async () => {
    current = view({ judge: "Only the owner judges rules; you are local:alice." });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    // Read-only: the detail opens, but no verdict button shows.
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Why and where"]);
  });

  const HOMES = [{ path: "/Users/me/agents", missing: "bin/evolve" }, { path: "/Users/me/.agents", missing: null }];
  const off = (over: Partial<RulesView> = {}): RulesView =>
    view({ enabled: false, entries: [], home: { path: "/Users/me/.agents", missing: null, homes: [HOMES[1]!] }, turn_on: '{"tacit":"agents-home"}', ...over });
  const h1s = () => screen.queryAllByRole("heading", { level: 1 }).map((h) => h.textContent);
  const check = () => document.querySelector<HTMLElement>("[data-home-check]")!;

  it("ledger off, home found: the picker shows the home in use and its check, and one primary Turn on is the only button", async () => {
    current = off();
    await show();
    const turnOn = await screen.findByRole("button", { name: "Turn on" }, SLOW);
    expect(screen.getAllByRole("button")).toEqual([turnOn]);
    expect(turnOn.className).toContain("bg-accent"); // the primary variant
    const radios = within(screen.getByRole("radiogroup", { name: "Agents home" })).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["/Users/me/.agents", true]]);
    expect(check().textContent).toBe("bin/tacit and bin/evolve are both executable in /Users/me/.agents.");
    // No path field: the picker offers only the known homes.
    expect(screen.queryByRole("textbox")).toBeNull();
    // The page's own header is the one "Rules"; the page adds no second h1 and no step list.
    expect(h1s()).toEqual(["Rules"]);
    expect(document.querySelector("ol")).toBeNull();
    // The empty state carries the action, and the page is capped at max-w-3xl.
    expect(turnOn.closest("div.max-w-3xl")).not.toBeNull();
  });

  it("the picker lists only the known homes, AGENTS_HOME first, and shows the check of the one chosen: the missing file, or both executable", async () => {
    current = off({ home: { path: "/Users/me/agents", missing: "bin/evolve", homes: HOMES }, turn_on: null });
    await show();
    const group = await screen.findByRole("radiogroup", { name: "Agents home" }, SLOW);
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["/Users/me/agents", true], ["/Users/me/.agents", false]]);
    expect(group.textContent).toContain("/Users/me/agents (in use)");
    expect(check().textContent).toBe("bin/evolve is missing or not executable in /Users/me/agents.");
    fireEvent.click(radios[1]!);
    expect(check().textContent).toContain("bin/tacit and bin/evolve are both executable in /Users/me/.agents.");
    expect(check().textContent).toContain("The factory reads the home in use, /Users/me/agents, not this one.");
    // Choosing writes nothing, and with the home in use not found there is no Turn on.
    expect(posts).toEqual([]);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });

  it("Turn on writes the integrations entry through POST /api/v1/settings, then loads the rules with no reload", async () => {
    current = off();
    answer = { status: 200, body: { ok: true, lines: ["integrations = {\"tacit\":\"agents-home\"}"] } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/settings");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(sent()).toEqual([{ action: "set", key: "integrations", value: '{"tacit":"agents-home"}' }]);
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    expect(card("C-012")).not.toBeNull();
  });

  it("a refused Turn on shows the refusal and stays off", async () => {
    current = off();
    answer = { status: 422, body: { error: "refused: integrations changes only by the owner" } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("only by the owner");
    expect(screen.queryByRole("list", { name: "Rule candidates" })).toBeNull();
  });

  it("ledger off, home not found: names the missing file, with no path field and no Turn on, and tells nobody where to put the CLIs", async () => {
    current = off({ home: { path: "/Users/me/.agents", missing: "bin/evolve", homes: [{ path: "/Users/me/.agents", missing: "bin/evolve" }] }, turn_on: null });
    await show();
    await waitFor(() => expect(document.querySelector("[data-home]")).not.toBeNull(), SLOW);
    const text = document.querySelector("[data-home]")!.textContent!;
    expect(text).toContain("bin/evolve is missing or not executable in /Users/me/.agents.");
    expect(text).not.toMatch(/\bput\b/i);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(h1s()).toEqual(["Rules"]);
  });

  it("Applied group after the waiting groups: each block's parts, \"not given\" for a missing one, raw text, the elsewhere lines; none when empty or off", async () => {
    current = view({
      applied: {
        rules: [
          { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: "모든 문서", incidents: ["T-1", "T-2"], judged: "2026-11-13", raw: null },
          { id: null, name: null, default: null, exceptions: null, scope: null, incidents: null, judged: null, raw: "## Notes\njust words" },
        ],
        elsewhere: ["- C-009 → CLAUDE.md"],
      },
    });
    await show();
    const applied = await screen.findByRole("list", { name: "Applied" }, SLOW);
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label")).at(-1)).toBe("Applied");
    const c = applied.querySelector<HTMLElement>('[data-applied="C-001"]')!.textContent!;
    for (const part of ["C-001", "summary first", "모든 문서", "2026-11-13", "Open with a summary.", "not given", "2: T-1, T-2"]) expect(c).toContain(part);
    // Details are a label/value list.
    expect([...applied.querySelectorAll('[data-applied="C-001"] dt')].map((d) => d.textContent)).toEqual(["Default", "Exception", "Evidence", "Judged"]);
    expect(applied.querySelector("[data-applied-raw]")!.textContent).toBe("## Notes\njust words");
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("Encoded elsewhere");
    // The elsewhere lines go through Markdown: a list item, no raw "- ".
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("C-009 → CLAUDE.md");
    expect(document.querySelector("[data-elsewhere] li")!.textContent).toBe("C-009 → CLAUDE.md");
    // The raw block has no action; the class has Retire and no edit.
    expect(screen.getAllByRole("button", { name: "Retire" })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: /edit/i })).toEqual([]);
  });

  const APPLIED: RulesView["applied"] = {
    rules: [
      { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: null, incidents: ["T-1"], judged: "2026-10-01", raw: null },
      { id: "C-002", name: "flags", default: "Keep every flag.", exceptions: null, scope: null, incidents: ["T-2"], judged: "2026-11-13", raw: null },
      { id: null, name: null, default: null, exceptions: null, scope: null, incidents: null, judged: null, raw: "## Notes" },
    ],
    elsewhere: [],
  };
  const applied = (id: string) => document.querySelector<HTMLElement>(`[data-applied="${id}"]`)!;

  it("Suggest reads each applied class's suggestions on demand; a suggested rule shows the badge with its reasons, the others none", async () => {
    current = view({ applied: APPLIED });
    detail = (id) => ({ id, error: null, detail: null, retire: id === "C-001" ? ["no new incident for 44 days since judged on 2026-10-01", "covered by C-002"] : [] });
    await show();
    await screen.findByRole("list", { name: "Applied" }, SLOW);
    // Nothing is suggested, and no entry read, before the press.
    expect(gets.filter((u) => u.includes("/rules/entry"))).toEqual([]);
    expect(screen.queryByText("Suggested to retire")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    expect((await within(applied("C-001")).findByText("Suggested to retire", {}, SLOW)).textContent).toBe("Suggested to retire");
    expect([...applied("C-001").querySelectorAll("[data-suggested] li")].map((li) => li.textContent)).toEqual([
      "no new incident for 44 days since judged on 2026-10-01", "covered by C-002",
    ]);
    await waitFor(() => expect(gets.filter((u) => u.includes("/rules/entry")).sort()).toEqual(["/api/v1/rules/entry?id=C-001", "/api/v1/rules/entry?id=C-002"]));
    expect(within(applied("C-002")).queryByText("Suggested to retire")).toBeNull();
    // A suggestion writes nothing.
    expect(posts).toEqual([]);
    // The next press reads again.
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    await waitFor(() => expect(gets.filter((u) => u.includes("/rules/entry"))).toHaveLength(4));
  });

  it("Retire opens a dialog with a required reason (not in the row) and sends the retire verdict with no rule fields", async () => {
    current = view({ applied: APPLIED });
    answer = { status: 200, body: { id: "C-001", verdict: "retire" } };
    await show();
    await screen.findByRole("list", { name: "Applied" }, SLOW);
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Retire" }));
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    const confirm = within(dialog()).getByRole("button", { name: "Send retire" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "covered by C-002" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(sent()).toEqual([{ id: "C-001", verdict: "retire", reason: "covered by C-002" }]);
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("a user who is not the owner sees Retire disabled", async () => {
    current = view({ applied: APPLIED, judge: "Only the owner judges rules; you are local:alice." });
    await show();
    await screen.findByRole("list", { name: "Applied" }, SLOW);
    const buttons = screen.getAllByRole("button", { name: "Retire" }) as HTMLButtonElement[];
    expect(buttons.map((b) => b.disabled)).toEqual([true, true]);
    fireEvent.click(buttons[0]!);
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
  });

  it("the Retired list is collapsed and gives each rule's reason and date; none when the ledger has none", async () => {
    current = view({ applied: APPLIED, retired: [{ id: "C-007", reason: "covered by C-001", date: "2026-11-14" }] });
    await show();
    const region = await screen.findByRole("region", { name: "Retired" }, SLOW);
    const details = region.querySelector<HTMLDetailsElement>("details[data-retired]")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Show retired rules");
    expect(details.querySelector('[data-retired-rule="C-007"]')!.textContent).toBe("C-007Retired 2026-11-14: covered by C-001");
    cleanup();
    current = view({ applied: APPLIED, retired: [] });
    await show();
    await screen.findByRole("list", { name: "Applied" }, SLOW);
    expect(screen.queryByRole("region", { name: "Retired" })).toBeNull();
  });

  const judgedEntries = (): RulesView["entries"] => [
    { id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: "promote", draft: null, draft_error: null },
    { id: "P-0007", title: "Split the review prompt", state: "held", judged: "reject", draft: null, draft_error: null },
  ];

  it("with every entry judged: 0 waiting, an empty state with its next step, and one \"N decided\" line", async () => {
    current = view({ entries: judgedEntries() });
    await show();
    await screen.findByText("Nothing waits for a verdict", {}, SLOW);
    expect(document.querySelector("[data-waiting]")!.textContent).toBe("0 waiting");
    expect(screen.queryByRole("list", { name: "Rule candidates" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Structure proposals" })).toBeNull();
    expect(document.querySelector("[data-decided] summary")!.textContent).toBe("2 decided");
    expect(card("P-0007").textContent).toContain("Judged: reject");
  });

  it("the waiting count and the group counts exclude judged entries; one PageHeader names the page and holds How this works", async () => {
    current = view({ entries: [...judgedEntries(), ...view().entries] });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    expect(document.querySelector("[data-waiting]")!.textContent).toBe("2 waiting");
    expect(screen.getByRole("region", { name: "Rule candidates" }).querySelectorAll("li[data-rule]")).toHaveLength(1);
    expect(h1s()).toEqual(["Rules"]);
    const how = document.querySelector<HTMLDetailsElement>("details[data-how]")!;
    expect(how.querySelector("summary")!.textContent).toBe("How this works");
    expect(how.open).toBe(false);
  });

  it("Applied is collapsed while something waits and open when nothing does; it says its order", async () => {
    current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    const details = () => document.querySelector<HTMLDetailsElement>("section[aria-label=Applied] > details")!;
    expect(details().open).toBe(false);
    expect(details().textContent).toContain("Listed in the order of your rules file.");
    cleanup();
    current = view({ applied: APPLIED, entries: judgedEntries() });
    await show();
    await screen.findByText("Nothing waits for a verdict", {}, SLOW);
    expect(details().open).toBe(true);
  });

  it("the search filters Applied rows case-insensitively over ID, name, default and scope; evidence is counted once per incident", async () => {
    current = view({
      entries: [],
      applied: {
        rules: [
          { id: "C-001", name: "Summary first", default: "Open with a summary.", exceptions: null, scope: "docs", incidents: ["T-1", "T-1", "T-2"], judged: "2026-10-01", raw: null },
          { id: "C-002", name: "flags", default: "Keep every flag.", exceptions: null, scope: "CLI", incidents: ["T-2"], judged: "2026-11-13", raw: null },
        ],
        elsewhere: [],
      },
    });
    await show();
    await screen.findByRole("list", { name: "Applied" }, SLOW);
    const ids = () => [...document.querySelectorAll<HTMLElement>("[data-applied]")].map((e) => e.dataset.applied);
    expect(ids()).toEqual(["C-001", "C-002"]);
    expect(applied("C-001").textContent).toContain("2: T-1, T-2");
    const search = screen.getByRole("searchbox", { name: /search/i });
    for (const [term, want] of [["SUMMARY", ["C-001"]], ["c-002", ["C-002"]], ["keep every", ["C-002"]], ["cli", ["C-002"]], ["", ["C-001", "C-002"]], ["zzz", []]] as const) {
      fireEvent.change(search, { target: { value: term } });
      expect(ids()).toEqual(want);
    }
    expect(screen.getByText("No applied rule matches.")).not.toBeNull();
  });

  it("a disabled Promote says why in a Tooltip; Promote is primary, Hold secondary, Reject danger and last", async () => {
    current = view({ entries: [{ id: "C-013", title: "Summary first.", state: "pending", judged: null, draft: null, draft_error: "x" }, ...view().entries] });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    const buttons = within(card("C-012")).getAllByRole("button").map((b) => b.textContent);
    expect(buttons).toEqual(["Why and where", "Promote", "Hold", "Reject"]);
    expect(within(card("C-012")).getByRole("button", { name: "Promote" }).className).toContain("bg-accent");
    expect(within(card("C-012")).getByRole("button", { name: "Reject" }).className).toContain("text-failed");
    const off = within(card("C-013")).getByRole("button", { name: "Promote" });
    fireEvent.mouseEnter(off.parentElement!);
    expect((await screen.findByRole("tooltip")).textContent).toContain("Promote is off");
  });

  it("the verdict dialog titles the verdict and ID, shows the full title and detail above the fields, and labels the reason as it reads", async () => {
    const long = "A".repeat(80);
    current = view({ entries: [{ id: "C-037", title: long, state: "pending", judged: null, draft: { default: "d", exception: "e", incidents: ["T-1"], scope: "s" }, draft_error: null }] });
    detail = { id: "C-037", error: null, detail: { id: "C-037", incidents: 2, scope: "software" } };
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    fireEvent.click(within(card("C-037")).getByRole("button", { name: "Promote" }));
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe("Promote C-037");
    expect(dialog().querySelector("[data-dialog-summary]")!.textContent).toBe(long);
    await waitFor(() => expect(dialog().querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    const all = dialog().innerHTML;
    expect(all.indexOf("data-dialog-summary")).toBeLessThan(all.indexOf("data-detail-part"));
    expect(all.indexOf("data-detail-part")).toBeLessThan(all.indexOf("<textarea"));
    const reason = within(dialog()).getByRole("textbox", { name: "Reason" });
    expect(dialog().querySelector(`label[for="${reason.id}"]`)!.textContent).toBe("Reason");
    expect(reason.getAttribute("aria-label")).toBeNull();
  });

  /** A proposal linked to two incidents, each with a date, the agent's proposal, the owner's quote and a root reason, newest first. */
  const TWO_INCIDENTS: RuleEntryView = {
    id: "P-20261103-34e9", error: null,
    detail: {
      id: "P-20261103-34e9", description: "Quiet evolve's notices at night.", kind: "edit-asset", target: "bin/evolve", incidents: 2,
      evidence: [
        { ref: "T-20261104-b2", date: "2026-11-04", proposal: "notify every hour", quote: "stop at 3am", root_reason: "no quiet hours" },
        { ref: "L-0042", date: "2026-11-01", proposal: "keep notifying", quote: "too loud" },
      ],
    },
  };
  const proposalEntry = (title = "Quiet notify"): RulesView["entries"] => [
    { id: "P-20261103-34e9", title, state: "open", kind: "edit-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null },
  ];
  const openDialog = async (label: string) => {
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-20261103-34e9")).getByRole("button", { name: label }));
    await waitFor(() => expect(dialog().querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
  };

  it("the Promote dialog of a proposal linked to two incidents shows both quotes and dates, newest first, above the inputs", async () => {
    current = view({ entries: proposalEntry() });
    detail = TWO_INCIDENTS;
    await openDialog("Promote");
    const items = [...dialog().querySelectorAll<HTMLElement>("[data-evidence]")];
    expect(items.map((i) => i.dataset.evidence)).toEqual(["T-20261104-b2", "L-0042"]);
    expect(items.map((i) => i.querySelector("[data-evidence-date]")!.textContent)).toEqual(["2026-11-04", "2026-11-01"]);
    expect(items.map((i) => i.querySelector("blockquote[data-quote]")!.textContent)).toEqual(["stop at 3am", "too loud"]);
    expect(items[0]!.textContent).toContain("Agent proposed: notify every hour");
    expect(items[0]!.textContent).toContain("Root reason: no quiet hours");
    expect(dialog().querySelector("[data-detail-description]")!.textContent).toBe("Quiet evolve's notices at night.");
    const all = dialog().innerHTML;
    expect(all.indexOf("data-evidence")).toBeLessThan(all.indexOf("<textarea"));
    expect(dialog().querySelector("[data-rule-detail]")!.textContent).not.toContain("not given");
  });

  it("the Reject dialog shows the full title too; the evidence shows 3 and the rest behind Show all N", async () => {
    const long = "B".repeat(90);
    current = view({ entries: proposalEntry(long) });
    const evidence = ["2026-11-01", "2026-11-05", "2026-11-03", "2026-11-04", "2026-11-02"].map((date, i) => ({ ref: `E-${i}`, date, quote: `q${i}` }));
    detail = { id: "P-20261103-34e9", error: null, detail: { id: "P-20261103-34e9", evidence } };
    await openDialog("Reject");
    expect(dialog().querySelector("[data-dialog-summary]")!.textContent).toBe(long);
    const shown = () => [...dialog().querySelectorAll<HTMLElement>("[data-evidence]")].map((i) => i.dataset.evidence);
    expect(shown()).toEqual(["E-0", "E-1", "E-2"]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show all 5" }));
    expect(shown()).toEqual(["E-0", "E-1", "E-2", "E-3", "E-4"]);
    expect(within(dialog()).queryByRole("button", { name: /Show all/ })).toBeNull();
  });

  it("before → after shows a proposal's current and proposed lines only when the ledger carries them", async () => {
    current = view({ entries: proposalEntry() });
    detail = { ...TWO_INCIDENTS, detail: { ...TWO_INCIDENTS.detail!, current: "notify always", proposed: "notify 08:00-22:00" } };
    await openDialog("Promote");
    expect(dialog().querySelector('[data-change="current"]')!.textContent).toBe("notify always");
    expect(dialog().querySelector('[data-change="proposed"]')!.textContent).toBe("notify 08:00-22:00");
    cleanup();
    detail = TWO_INCIDENTS;
    await openDialog("Promote");
    expect(dialog().querySelector('[data-detail-part="change"]')).toBeNull();
  });

  it("Related lists the applied rules that share an incident ID or name the target file, and is left out when none match", async () => {
    current = view({
      entries: proposalEntry(),
      applied: {
        rules: [
          { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: null, incidents: ["L-0042"], judged: null, raw: null },
          { id: "C-002", name: "quiet hours", default: "Keep bin/evolve quiet at night.", exceptions: null, scope: null, incidents: ["T-9"], judged: null, raw: null },
          { id: "C-003", name: "flags", default: "Keep every flag.", exceptions: null, scope: "CLI", incidents: ["T-1"], judged: null, raw: null },
        ],
        elsewhere: [],
      },
    });
    detail = TWO_INCIDENTS;
    await openDialog("Promote");
    expect([...dialog().querySelectorAll<HTMLElement>("[data-related]")].map((r) => r.dataset.related)).toEqual(["C-001", "C-002"]);
    cleanup();
    current = view({ entries: proposalEntry(), applied: { rules: [APPLIED!.rules[1]!], elsewhere: [] } });
    await openDialog("Promote");
    expect(dialog().querySelector('[data-detail-part="related"]')).toBeNull();
  });

  it("a long Korean title and long Korean quotes wrap in the dialog instead of overflowing it", async () => {
    const title = "프로모트할 때 근거와 맥락을 보여주어 소유자가 무엇을 근거로 한 제안인지 판단할 수 있게 한다".repeat(3);
    const said = "새벽 세 시에 알림이 계속 와서 잠을 못 잤으니 야간에는 알림을 보내지 않도록 바꿔 달라고 여러 번 말했다".repeat(4);
    current = view({ entries: proposalEntry(title) });
    detail = { ...TWO_INCIDENTS, detail: { ...TWO_INCIDENTS.detail!, evidence: TWO_INCIDENTS.detail!.evidence!.map((e) => ({ ...e, quote: said })) } };
    await openDialog("Promote");
    const summary = dialog().querySelector<HTMLElement>("[data-dialog-summary]")!;
    expect(summary.textContent).toBe(title);
    // Wrapped, never cut or kept on one line: the summary and every quote break inside the dialog's width.
    for (const el of [summary, ...dialog().querySelectorAll<HTMLElement>("blockquote[data-quote]")]) {
      expect(el.className).toContain("break-words");
      expect(el.className).not.toMatch(/\b(truncate|whitespace-nowrap)\b/);
    }
    expect(dialog().querySelectorAll("blockquote[data-quote]")).toHaveLength(2);
    expect(dialog().querySelector("[data-rule-detail]")!.className).toContain("min-w-0");
  });

  it("no Applied group when the file holds nothing or the ledger is off", async () => {
    current = view({ applied: { rules: [], elsewhere: [] } });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    expect(screen.queryByRole("region", { name: "Applied" })).toBeNull();
  });

  it("ledger off for a user who is not the owner: the reason, and no Turn on", async () => {
    current = off({ judge: "Only the owner turns the ledger on; you are local:alice.", csrf_token: null, turn_on: null });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

describe("Rules page: improve report and Run now (design 07-self-improvement, 2026-11-16)", () => {
  const IMPROVE_TOKEN = "tok_improve";
  const report: ImproveView["report"] = {
    window_start: "2026-11-15T00:00:00.000Z", window_end: "2026-11-16T00:00:00.000Z", created_at: "2026-11-16T00:05:00.000Z", runs: 4, patterns: 1,
    groups: [
      { error_code: "checks_failed", detail: "npm test exited #", runs: 2, draft: { cause: "a flaky port", fix: "pin the port", note: null }, filing: "filed: local:local-1" },
      { error_code: "no_commits", detail: null, runs: 2, draft: { cause: null, fix: null, note: "withheld (github_token)" }, filing: null },
    ],
  };
  const improve = (over: Partial<ImproveView> = {}): ImproveView => ({ report, run_now: true, csrf_token: IMPROVE_TOKEN, ...over });
  const section = () => screen.findByRole("region", { name: "Improve report" }, SLOW);

  it("shows the report's window, counts and one row per group with its draft and filing", async () => {
    current = view({ improve: improve() });
    await show();
    const s = await section();
    expect(s.querySelector("[data-improve-window]")!.textContent).toContain("2 groups (4 runs), 1 single-run patterns");
    const rows = [...s.querySelectorAll<HTMLElement>("[data-improve-group]")];
    expect(rows.map((r) => r.dataset.improveGroup)).toEqual(["checks_failed", "no_commits"]);
    expect(rows[0]!.querySelector("[data-draft]")!.textContent).toContain("a flaky port");
    expect(rows[0]!.querySelector("[data-draft]")!.textContent).toContain("pin the port");
    expect(rows[0]!.querySelector("[data-filing]")!.textContent).toBe("filed: local:local-1");
    expect(rows[1]!.querySelector("[data-draft]")!.textContent).toBe("withheld (github_token)");
    expect(rows[1]!.querySelector("[data-filing]")!.textContent).toBe("not filed yet");
  });

  it("with no report it says so; with no run_now there is no Run now button", async () => {
    current = view({ improve: improve({ report: null, run_now: false, csrf_token: null }) });
    await show();
    const s = await section();
    expect(s.textContent).toContain("no improve run has reported yet");
    expect(within(s).queryByRole("button", { name: "Run now" })).toBeNull();
  });

  it("Run now posts to POST /api/v1/improve/run with the x-csrf-token header; a 200 shows the run_id", async () => {
    current = view({ improve: improve() });
    answer = { status: 200, body: { run_id: "run_queued_1" } };
    await show();
    const s = await section();
    fireEvent.click(within(s).getByRole("button", { name: "Run now" }));
    expect((await within(s).findByRole("status")).textContent).toBe("Improve run queued: run_queued_1");
    expect(posts.map((p) => p.url)).toEqual(["/api/v1/improve/run"]);
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(IMPROVE_TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({});
  });

  it("a 409 shows its error and run_id, and the rules are not reloaded into a success", async () => {
    current = view({ improve: improve() });
    answer = { status: 409, body: { error: "An improve run is already queued (run_busy).", run_id: "run_busy" } };
    await show();
    const s = await section();
    const before = gets.filter((u) => u === "/api/v1/rules").length;
    fireEvent.click(within(s).getByRole("button", { name: "Run now" }));
    const alert = await within(s).findByRole("alert");
    expect(alert.textContent).toContain("An improve run is already queued (run_busy).");
    expect(alert.textContent).toContain("run_busy");
    expect(within(s).queryByRole("status")).toBeNull();
    expect(gets.filter((u) => u === "/api/v1/rules").length).toBe(before);
  });

  it("with the ledger off the section and Run now show above the ledger-off EmptyState", async () => {
    current = view({ enabled: false, entries: [], home: { path: "/Users/me/.agents", missing: null }, turn_on: '{"tacit":"agents-home"}', improve: improve() });
    await show();
    const s = await section();
    expect(within(s).getByRole("button", { name: "Run now" })).toBeTruthy();
    const empty = screen.getByText("No tacit ledger is on, so there are no rules to review.");
    expect(s.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

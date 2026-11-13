// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleEntryView, RulesView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-users-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/rules.js";
const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

// The Rules page (issue #571): the pending entries in two groups, rule candidates (C-) and structure proposals (P-),
// each under its line on what promoting one does; each card with its title, state, ID and one line of what it would
// change, and its detail (what, why, where) read from GET /api/v1/rules/entry only when the card opens. Promote, Hold and Reject ask for a
// reason in a dialog before they send; Promote of a class (C-) sends the owner's wording, default and exception (the
// last two prefilled from its draft), Promote of a proposal (P-) sends none. A judged entry shows its decision and no
// verdict buttons; a class whose draft could not be read offers no Promote. With the ledger off (design 08-settings): the agents home found gives one line and one
// primary Turn on, which writes the `integrations` entry through POST /api/v1/settings and loads the rules with no
// reload; not found, the page names the missing CLI and how to set AGENTS_HOME.

const TOKEN = "tok_rules";
const SLOW = { timeout: 5_000 };

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
      ["Structure proposals", "Promoting a proposal records your verdict only; you make the change by hand."],
    ]);
    expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    expect(card("C-012").textContent).toContain("Pending");
    expect(card("C-012").textContent).toContain("C-012");
    expect(card("C-012").querySelector("[data-rule-what]")!.textContent).toBe("Rule: Keep existing CLI flags.");
    expect(card("P-0007").textContent).toContain("Held");
    expect(card("P-0007").querySelector("[data-rule-title]")!.textContent).toBe("Split the review prompt");
    expect(card("P-0007").querySelector("[data-rule-what]")!.textContent).toBe("edit-asset: prompts/review.md");
    // No detail is read on page load.
    expect(gets.filter((u) => u.includes("/rules/entry"))).toEqual([]);
    expect(document.querySelector("[data-rule-detail]")).toBeNull();
  });

  it("opening a card reads its detail on demand and shows what, why and where in that order", async () => {
    detail = {
      id: "C-012", error: null,
      detail: { id: "C-012", default: "Keep every existing CLI flag.", exceptions: "a deprecated flag", incidents: 3, quotes: ["keep --json"], root_reason: "renames skip callers", scope: "software, CLI" },
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
    expect(parts.map((p) => p.dataset.detailPart)).toEqual(["what", "why", "where"]);
    expect(parts.map((p) => p.querySelector("h3")!.textContent)).toEqual(["What it would change", "Why", "Where it applies"]);
    expect(parts[0]!.textContent).toContain("Rule: Keep every existing CLI flag.");
    expect(parts[0]!.textContent).toContain("Except: a deprecated flag");
    const why = parts[1]!.textContent!;
    expect(why.indexOf("Came up 3 times.")).toBeLessThan(why.indexOf("keep --json"));
    expect(why.indexOf("keep --json")).toBeLessThan(why.indexOf("Root reason: renames skip callers"));
    expect(parts[1]!.querySelector("blockquote[data-quote]")!.textContent).toBe("keep --json");
    expect(parts[2]!.textContent).toContain("software, CLI");
  });

  it("a proposal's detail shows its kind and target; a part the ledger lacks says not given", async () => {
    detail = { id: "P-0007", error: null, detail: { id: "P-0007", incidents: 1 } };
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-0007")).getByRole("button", { name: "Why and where" }));
    await waitFor(() => expect(card("P-0007").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    const part = (name: string) => card("P-0007").querySelector(`[data-detail-part="${name}"]`)!.textContent;
    expect(part("what")).toContain("Kind: edit-asset");
    expect(part("what")).toContain("Changes: prompts/review.md");
    expect(part("why")).toContain("Came up once.");
    expect(part("where")).toContain("not given");
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
    expect(card("C-012").querySelector("[data-judged]")!.textContent).toContain("Judged: promote");
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

  it("promote of a proposal asks for no wording and an Applied to file prefilled with its target; empty, Send is off and the field says why", async () => {
    current = view({
      entries: [{ id: "P-20261101-158e", title: "Quiet notify", state: "open", kind: "edit-asset", target: "private/bin/notify", judged: null, draft: null, draft_error: null }],
    });
    await show();
    await screen.findByRole("list", { name: "Structure proposals" }, SLOW);
    fireEvent.click(within(card("P-20261101-158e")).getByRole("button", { name: "Promote" }));
    for (const name of ["Rule wording", "Default", "Exception"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent)
      .toBe("Promoting records the verdict and names the file the change went into; you make the change by hand.");
    const applied = within(dialog()).getByRole("textbox", { name: "Applied to" }) as HTMLInputElement;
    expect(applied.value).toBe("private/bin/notify");
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "good shape" } });
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.change(applied, { target: { value: "  " } });
    expect(confirm.disabled).toBe(true);
    expect(applied.parentElement!.textContent).toContain("Name the file the change went into: Send stays off until you do.");
    fireEvent.change(applied, { target: { value: "private/bin/notify-quiet" } });
    expect(confirm.disabled).toBe(false);
    expect(applied.parentElement!.textContent).not.toContain("Send stays off");
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(sent()).toEqual([{ id: "P-20261101-158e", verdict: "promote", reason: "good shape", applied_to: "private/bin/notify-quiet" }]);
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
    expect((await screen.findByRole("note", {}, SLOW)).textContent).toContain("Only the owner");
    // Read-only: the detail opens, but no verdict button shows.
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Why and where"]);
  });

  const off = (over: Partial<RulesView> = {}): RulesView =>
    view({ enabled: false, entries: [], home: { path: "/Users/me/.agents", missing: null }, turn_on: '{"tacit":"agents-home"}', ...over });
  const headings = () => screen.queryAllByRole("heading").map((h) => h.textContent);

  it("ledger off, home found: one line names the home and one primary Turn on is the only button", async () => {
    current = off();
    await show();
    const turnOn = await screen.findByRole("button", { name: "Turn on" }, SLOW);
    expect(screen.getAllByRole("button")).toEqual([turnOn]);
    expect(turnOn.className).toContain("bg-accent"); // the primary variant
    expect(document.querySelector("[data-home]")!.textContent).toBe("Found your agents home at /Users/me/.agents");
    // The app's page title is the one "Rules"; the page adds no section titled Rules and no step list.
    expect(headings()).not.toContain("Rules");
    expect(document.querySelector("ol")).toBeNull();
    // 12 px (space-y-3) between the empty box and what follows.
    expect(turnOn.parentElement!.className.split(" ")).toContain("space-y-3");
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

  it("ledger off, home not found: names the missing CLI and how to set AGENTS_HOME, with no path field and no Turn on", async () => {
    current = off({ home: { path: "/Users/me/.agents", missing: "bin/evolve" }, turn_on: null });
    await show();
    await waitFor(() => expect(document.querySelector("[data-home]")).not.toBeNull(), SLOW);
    const text = document.querySelector("[data-home]")!.textContent!;
    expect(text).toContain("bin/evolve is missing or not executable");
    expect(text).toContain("AGENTS_HOME");
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(headings()).not.toContain("Rules");
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
    for (const part of ["C-001", "summary first", "Default: Open with a summary.", "Exception: not given", "Scope: 모든 문서", "Evidence: T-1, T-2", "Judged: 2026-11-13"]) expect(c).toContain(part);
    expect(applied.querySelector("[data-applied-raw]")!.textContent).toBe("## Notes\njust words");
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("Encoded elsewhere");
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("- C-009 → CLAUDE.md");
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

  it("no Applied group when the file holds nothing or the ledger is off", async () => {
    current = view({ applied: { rules: [], elsewhere: [] } });
    await show();
    await screen.findByRole("list", { name: "Rule candidates" }, SLOW);
    expect(screen.queryByRole("region", { name: "Applied" })).toBeNull();
  });

  it("ledger off for a user who is not the owner: the reason, and no Turn on", async () => {
    current = off({ judge: "Only the owner turns the ledger on; you are local:alice.", csrf_token: null, turn_on: null });
    await show();
    expect((await screen.findByRole("note", {}, SLOW)).textContent).toContain("Only the owner");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

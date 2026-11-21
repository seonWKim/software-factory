// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuleEntryView, RulesView } from "../web/src/api.js";

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
/** GET /api/v1/standing's answer. */
let standing: unknown;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };
let gets: string[];
/** GET /api/v1/rules/entry's answer: a detail view, one per ID, or an HTTP status for a failed read. */
let detail: RuleEntryView | number | ((id: string) => RuleEntryView);

beforeEach(() => {
  current = view();
  standing = { as_of: AT, csrf_token: TOKEN, rules: [], proposals: [] };
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
    if (url === "/api/v1/standing") return json(200, standing);
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
  history.replaceState(null, "", "/app/rules");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
}

/** The page's two sections, by title. */
const section = (name: "In effect" | "Waiting for you") => screen.getByRole("region", { name });
/** Opens the page's one Details disclosure (at its end) once the rules are loaded, and returns it. */
async function openDetails(): Promise<HTMLElement> {
  const details = await waitFor(() => {
    const d = document.querySelector<HTMLDetailsElement>("details[data-page-details]");
    if (!d) throw new Error("no page Details yet");
    return d;
  }, SLOW);
  if (!details.open) fireEvent.click(details.querySelector("summary")!);
  return details;
}

const card = (id: string) => document.querySelector<HTMLElement>(`[data-rule="${id}"]`)!;
/** A card's "Why and where" toggle: the summary of its Disclosure. */
const whyToggle = (id: string) => within(card(id)).getByText("Why and where").closest("summary")!;
const dialog = () => document.querySelector<HTMLDialogElement>("dialog[data-dialog]")!;
/** Picks a verdict: Promote is the row's visible button; Hold and Reject are items of its ⋯ menu. */
const choose = (el: HTMLElement, label: string) => {
  if (label === "Promote") {
    fireEvent.click(within(el).getByRole("button", { name: "Promote" }));
    return;
  }
  fireEvent.click(within(el).getByRole("button", { name: /^Decide:/ }));
  fireEvent.click(within(el).getByRole("menuitem", { name: label }));
};
const sent = () => posts.map((p) => JSON.parse(String(p.init.body)));

describe("Rules page", () => {
  it("Waiting for you groups candidates then proposals, each under its line; each row shows its title (ID in its tooltip), state and what kind of change it is", async () => {
    await show();
    const waiting = await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const classes = within(waiting).getByRole("list", { name: "Rule candidates" });
    const proposals = within(waiting).getByRole("list", { name: "Structure proposals" });
    expect(within(classes).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["C-012"]);
    expect(within(proposals).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["P-0007"]);
    // Candidates first, each group (a part of the section, not a region) with its one line on what promoting one does.
    expect([...waiting.querySelectorAll("[data-group-line]")].map((l) => l.textContent)).toEqual([
      "Promoting a candidate adds its rule to every run's prompt from the next run on.",
      "Promoting a proposal shows its before and after, then applies it to the target file once you confirm.",
    ]);
    expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    expect(card("C-012").textContent).toContain("Pending");
    // The ID is not printed; it is in the tooltip of the title.
    expect(card("C-012").textContent).not.toContain("C-012");
    fireEvent.mouseEnter(card("C-012").querySelector("[data-id]")!.parentElement!);
    expect(within(card("C-012")).getByRole("tooltip").textContent).toBe("C-012");
    fireEvent.mouseLeave(card("C-012").querySelector("[data-id]")!.parentElement!);
    // The card does not repeat its title in a "Rule: …" line; a proposal still says its kind and target.
    expect(card("C-012").querySelector("[data-rule-what]")).toBeNull();
    expect(card("C-012").textContent).not.toContain("Rule:");
    // Each entry is a ListRow: the title line first, then the details line with the state badge.
    expect(card("C-012").matches("[data-list-row]")).toBe(true);
    expect(card("C-012").querySelector("[data-details]")!.textContent).toBe("Pending");
    expect(card("P-0007").textContent).toContain("Held");
    expect(card("P-0007").querySelector("[data-rule-title]")!.textContent).toBe("Split the review prompt");
    // No file name or path in the row: one file reads "1 file".
    expect(card("P-0007").querySelector("[data-rule-what]")!.textContent).toBe("Edit a file: 1 file");
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const toggle = whyToggle("C-012");
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    fireEvent.click(whyToggle("P-0007"));
    await waitFor(() => expect(card("P-0007").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    const part = (name: string) => card("P-0007").querySelector(`[data-detail-part="${name}"]`);
    expect(part("what")!.textContent).toContain("Kind: Edit a file: 1 file");
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
      await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
      fireEvent.click(whyToggle("C-012"));
      await waitFor(() => expect(card("C-012").querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
      expect(card("C-012").querySelector("[data-rule-detail]")!.textContent).toBe("The detail could not be read.");
      expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    });
  }

  it("a verdict button asks for a reason before it sends; promote of a class sends the edited wording, default and exception", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Promote");
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(card("C-012").querySelector("[data-judged]")!.textContent).toBe("Judged: promote");
    expect(card("C-012").textContent).not.toContain("Pending");
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep existing CLI flags."]);
    expect(whyToggle("C-012")).not.toBeNull();
    expect(card("C-013").querySelector("[data-draft-error]")!.textContent).toContain("evolve show exited 1");
    expect(within(card("C-012")).queryByRole("button", { name: /^Decide:/ })).toBeNull();
    fireEvent.click(within(card("C-013")).getByRole("button", { name: /^Decide:/ }));
    expect((within(card("C-013")).getByRole("button", { name: "Promote" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card("C-013")).getByRole("menuitem", { name: "Hold" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("hold and reject send only the reason; they ask for no wording and no applied-to file", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    for (const [label, reason] of [["Hold", "wait"], ["Reject", "not code"]] as const) {
      choose(card("P-0007"), label);
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-20261101-158e"), "Promote");
    for (const name of ["Rule wording", "Default", "Exception", "Applied to"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting replaces the Now lines with the Proposed lines in the target file, then records the verdict. If the Now lines are not there exactly once, or the change is refused, nothing is written and the error shows here.",
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

    choose(card("P-0009"), "Promote");
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toBe("Promote is off: this proposal gives no Now and Proposed lines to apply.");
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    expect((within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a failed apply keeps the dialog open with the CLI's error", async () => {
    detail = (id) => ({ id, error: null, detail: { id, target: "prompts/review.md", current: "a", proposed: "b" } });
    answer = { status: 502, body: { error: "The ledger refused the verdict: evolve verdict exited 1: evolve: P-0007 was judged already" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-0007"), "Promote");
    await waitFor(() => expect(dialog().querySelector('[data-change="proposed"]')).not.toBeNull(), SLOW);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send promote" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("evolve: P-0007 was judged already");
  });

  it("promote of a class keeps its own help text and has no Applied to field", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Promote");
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting writes this rule into your rules, records the verdict and updates your agents' instructions; it is part of every run's prompt from the next run on.",
    );
    expect(within(dialog()).queryByRole("textbox", { name: "Applied to" })).toBeNull();
  });

  it("a refusal stays in the dialog", async () => {
    answer = { status: 403, body: { error: "Only the owner judges rules; you are local:alice." } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Hold");
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send hold" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
  });

  it("a user who is not the owner sees the entries read-only with the reason, and no verdict buttons", async () => {
    current = view({ judge: "Only the owner judges rules; you are local:alice." });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    // Read-only: the detail opens, but no verdict button shows.
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep existing CLI flags."]);
    expect(whyToggle("C-012")).not.toBeNull();
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
    expect(check().textContent).toBe("The rules tools are ready in /Users/me/.agents.");
    // No path field: the picker offers only the known homes.
    expect(screen.queryByRole("textbox")).toBeNull();
    // The page's own header is the one "Rules"; the page adds no second h1 and no step list.
    expect(h1s()).toEqual(["Rules"]);
    expect(document.querySelector("ol")).toBeNull();
    // The empty state carries the action, and the page is capped at the list column, max-w-5xl.
    expect(turnOn.closest("div.max-w-5xl")).not.toBeNull();
  });

  it("the picker lists only the known homes, AGENTS_HOME first, and shows the check of the one chosen: the missing file, or both executable", async () => {
    current = off({ home: { path: "/Users/me/agents", missing: "bin/evolve", homes: HOMES }, turn_on: null });
    await show();
    const group = await screen.findByRole("radiogroup", { name: "Agents home" }, SLOW);
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([["/Users/me/agents", true], ["/Users/me/.agents", false]]);
    expect(group.textContent).toContain("/Users/me/agents (in use)");
    expect(check().textContent).toBe("The rules tools are missing or not executable in /Users/me/agents.");
    fireEvent.click(radios[1]!);
    expect(check().textContent).toContain("The rules tools are ready in /Users/me/.agents.");
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(card("C-012")).not.toBeNull();
  });

  it("a refused Turn on shows the refusal and stays off", async () => {
    current = off();
    answer = { status: 422, body: { error: "refused: integrations changes only by the owner" } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("only by the owner");
    expect(screen.queryByRole("region", { name: "Waiting for you" })).toBeNull();
  });

  it("ledger off, home not found: names the missing file, with no path field and no Turn on, and tells nobody where to put the CLIs", async () => {
    current = off({ home: { path: "/Users/me/.agents", missing: "bin/evolve", homes: [{ path: "/Users/me/.agents", missing: "bin/evolve" }] }, turn_on: null });
    await show();
    await waitFor(() => expect(document.querySelector("[data-home]")).not.toBeNull(), SLOW);
    const text = document.querySelector("[data-home]")!.textContent!;
    expect(text).toContain("The rules tools are missing or not executable in /Users/me/.agents.");
    expect(text).not.toMatch(/\bput\b/i);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(h1s()).toEqual(["Rules"]);
  });

  it("In effect lists each applied rule's sentence; its parts, \"not given\" for a missing one, and an unreadable block's raw text sit behind Details; the elsewhere lines follow", async () => {
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
    const applied = await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(applied.closest("section")!.getAttribute("aria-label")).toBe("In effect");
    const row = applied.querySelector<HTMLElement>('[data-applied="C-001"]')!;
    const c = row.textContent!;
    expect(c).not.toContain("C-001");
    // The row's sentence is the rule's name; its date and parts are behind Details, not on the row.
    expect(row.querySelector("p")!.textContent).toBe("summary first");
    expect(row.querySelector("[data-details]")).toBeNull();
    for (const part of ["summary first", "모든 문서", "2026-11-13", "Open with a summary.", "not given", "2: T-1, T-2"]) expect(c).toContain(part);
    // Details are a label/value list.
    expect([...applied.querySelectorAll('[data-applied="C-001"] dt')].map((d) => d.textContent)).toEqual(["Default", "Exception", "Evidence", "Judged"]);
    // An unreadable block says so; its raw text is behind Details.
    const raw = applied.querySelector<HTMLElement>("[data-applied-raw]")!;
    expect(raw.matches("[data-list-row]")).toBe(true);
    expect(raw.querySelector("p")!.textContent).toBe("A rule this page could not read");
    expect(raw.querySelector("details pre, details [data-value-block], details")!.textContent).toContain("## Notes\njust words");
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("Encoded elsewhere");
    // The elsewhere lines go through Markdown: a list item, no raw "- ".
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("C-009 → CLAUDE.md");
    expect(document.querySelector("[data-elsewhere] li")!.textContent).toBe("C-009 → CLAUDE.md");
    // The raw block has no action; the class has one ⋯ menu (Retire is in it) and no visible Retire button or edit.
    expect(screen.getAllByRole("button", { name: /^Actions:/ })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Retire" })).toEqual([]);
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
    await screen.findByRole("list", { name: "In effect" }, SLOW);
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
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    // No visible Retire button: Retire is the danger item of the row's ⋯ menu, at the right of the title line.
    expect(within(applied("C-001")).queryByRole("button", { name: "Retire" })).toBeNull();
    const more = within(applied("C-001")).getByRole("button", { name: "Actions: summary first" });
    expect(more.closest("[data-row-menu]")!.parentElement).toBe(applied("C-001"));
    fireEvent.click(more);
    const item = within(applied("C-001")).getByRole("menuitem", { name: "Retire" });
    expect(item.className).toContain("text-pill-bad-fg");
    fireEvent.click(item);
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe("Retire: summary first");
    const confirm = within(dialog()).getByRole("button", { name: "Send retire" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "covered by C-002" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(sent()).toEqual([{ id: "C-001", verdict: "retire", reason: "covered by C-002" }]);
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("a user who is not the owner sees the menu's Edit and Retire disabled, with the owner-only tooltip; Open evidence stays on", async () => {
    current = view({ applied: APPLIED, judge: "Only the owner judges rules; you are local:alice." });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    for (const name of ["Edit", "Retire"]) {
      const item = within(applied("C-001")).getByRole("menuitem", { name }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
      expect(document.querySelector("dialog[data-dialog]")).toBeNull();
    }
    expect((within(applied("C-001")).getByRole("menuitem", { name: "Open evidence" }) as HTMLButtonElement).disabled).toBe(false);
    // The owner-only reason is the menu's tooltip.
    fireEvent.mouseEnter(applied("C-001").querySelector("[data-row-menu] span")!);
    expect(within(applied("C-001")).getByRole("tooltip").textContent).toBe("Only the owner edits or retires a rule.");
  });

  it("each applied class's ⋯ menu holds Edit, Open evidence and Retire in that order; a raw block has no menu", async () => {
    current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(screen.getAllByRole("button", { name: /^Actions:/ })).toHaveLength(2);
    expect(document.querySelector("[data-applied-raw] [data-row-menu]")).toBeNull();
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    const items = within(applied("C-001")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Edit", "Open evidence", "Retire"]);
    expect(items.map((i) => i.className.includes("text-pill-bad-fg"))).toEqual([false, false, true]);
  });

  it("Edit opens the three-field dialog prefilled with the rule, asks for no reason, and posts the new text to /api/v1/rules/edit", async () => {
    const rule = { id: "C-001", name: "summary first", default: "Open with a summary.\nThen the detail.", exceptions: "a one-word reply", scope: null, incidents: ["T-1"], judged: null, raw: null };
    current = view({ applied: { rules: [rule], elsewhere: [] } });
    answer = { status: 200, body: { id: "C-001" } };
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Edit" }));
    const d = dialog();
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("Edit: summary first");
    const field = (name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement;
    expect([field("Rule wording").value, field("Default").value, field("Exception").value]).toEqual(["summary first", "Open with a summary.\nThen the detail.", "a one-word reply"]);
    for (const name of ["Rule wording", "Default", "Exception"]) expect(field(name).maxLength).toBe(2000);
    expect(within(d).getAllByRole("textbox")).toHaveLength(3);
    expect(within(d).queryByRole("textbox", { name: "Reason" })).toBeNull();
    // The confirm is the one primary action, in the ButtonRow; an empty field turns it off.
    const save = within(d).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(within(d).getAllByRole("button").filter((b) => b.className.includes("bg-accent"))).toEqual([save]);
    fireEvent.change(field("Exception"), { target: { value: " " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field("Exception"), { target: { value: "a yes or no" } });
    fireEvent.change(field("Rule wording"), { target: { value: "summary on top" } });
    fireEvent.click(save);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(posts.map((p) => p.url)).toEqual(["/api/v1/rules/edit"]);
    expect(sent()).toEqual([{ id: "C-001", text: "summary on top", default: "Open with a summary.\nThen the detail.", exception: "a yes or no" }]);
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("an edit the server refuses keeps the dialog open with its error", async () => {
    current = view({ applied: APPLIED });
    answer = { status: 502, body: { error: "The rule was saved, but sync-agents failed: locked" } };
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Exception" }), { target: { value: "none" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toBe("The rule was saved, but sync-agents failed: locked");
  });

  it("Open evidence opens a read-only dialog titled with the rule's name, with each incident's quote", async () => {
    current = view({ applied: APPLIED });
    detail = (id) => ({
      id, error: null, retire: [], detail: {
        id, incidents: 2, root_reason: "summaries buried the point", scope: "모든 문서",
        evidence: [{ ref: "T-1", date: "2026-11-03", quote: "lead with the answer" }, { ref: "T-2", quote: "한 줄 요약 먼저" }],
      },
    });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Open evidence" }));
    const d = dialog();
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("Evidence: summary first");
    await waitFor(() => expect(d.querySelectorAll("[data-quote]")).toHaveLength(2), SLOW);
    expect([...d.querySelectorAll("[data-quote]")].map((q) => q.textContent)).toEqual(["lead with the answer", "한 줄 요약 먼저"]);
    expect([...d.querySelectorAll("[data-detail-part]")].map((p) => p.getAttribute("data-detail-part"))).toEqual(expect.arrayContaining(["why", "evidence", "where"]));
    expect(gets).toContain("/api/v1/rules/entry?id=C-001");
    expect(within(d).queryAllByRole("textbox")).toEqual([]);
    fireEvent.click(within(d).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(posts).toEqual([]);
  });

  it("a rule with two default lines shows each on its own line in its Details", async () => {
    current = view({ applied: { rules: [{ ...APPLIED!.rules[0]!, default: "Open with a summary.\nKeep it to one line." }], elsewhere: [] } });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    const lines = applied("C-001").querySelectorAll("[data-lines] > [data-markdown]");
    expect([...lines].map((l) => l.textContent)).toEqual(["Open with a summary.", "Keep it to one line."]);
  });

  const PUSHBACKS = { rows: [{ id: "T-0201", pushback: "keep the --json flag", date: "2026-11-20" }, { id: "T-0202", pushback: "요약 먼저", date: null }], error: null };

  it("Pushbacks sits under the page's Details with its count: each row the owner's words and date, no ID, and one secondary sm Dismiss", async () => {
    current = view({ applied: APPLIED, pushbacks: PUSHBACKS });
    await show();
    const details = await openDetails();
    const list = await within(details).findByRole("list", { name: "Pushbacks" }, SLOW);
    expect(list.closest("details[data-page-details]")).toBe(details);
    expect(screen.getByRole("region", { name: "Pushbacks" }).textContent).toContain("2");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("[data-pushback-words]")!.textContent)).toEqual(["keep the --json flag", "요약 먼저"]);
    expect(rows[0]!.querySelector("[data-details]")!.textContent).toBe("2026-11-20");
    expect(rows[1]!.querySelector("[data-details]")).toBeNull();
    for (const r of rows) {
      expect(r.textContent).not.toMatch(/\b[PT]-\d/);
      const buttons = within(r).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Dismiss"]);
      expect(buttons[0]!.className).toContain("min-h-7");
      expect(buttons[0]!.className).toContain("border-border-strong");
    }
  });

  it("Dismiss opens a dialog that says it records the pushback as noise, posts its ID, and the list reloads without it", async () => {
    current = view({ applied: APPLIED, pushbacks: PUSHBACKS });
    answer = { status: 200, body: { id: "T-0201" } };
    await show();
    await openDetails();
    const list = await screen.findByRole("list", { name: "Pushbacks" }, SLOW);
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]!).getByRole("button", { name: "Dismiss" }));
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toContain("noise");
    expect(posts).toEqual([]);
    current = view({ applied: APPLIED, pushbacks: { rows: [PUSHBACKS.rows[1]!], error: null } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(posts.map((p) => p.url)).toEqual(["/api/v1/rules/pushbacks/dismiss"]);
    expect(sent()).toEqual([{ id: "T-0201" }]);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Pushbacks" })).getAllByRole("listitem")).toHaveLength(1));
  });

  it("a user who is not the owner sees Dismiss disabled with the owner-only tooltip", async () => {
    current = view({ applied: APPLIED, pushbacks: PUSHBACKS, judge: "Only the owner judges rules; you are local:alice." });
    await show();
    await openDetails();
    const list = await screen.findByRole("list", { name: "Pushbacks" }, SLOW);
    const row = within(list).getAllByRole("listitem")[0]!;
    const button = within(row).getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.mouseEnter(button.parentElement!);
    expect(within(row).getByRole("tooltip").textContent).toBe("Only the owner dismisses a pushback.");
  });

  it("no Pushbacks card with the ledger giving none; an unreadable list is a Notice and the rest of the page loads", async () => {
    current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(screen.queryByRole("region", { name: "Pushbacks" })).toBeNull();
    cleanup();
    current = view({ applied: APPLIED, pushbacks: { rows: [], error: "The pushbacks could not be read: boom" } });
    await show();
    await openDetails();
    const card = await screen.findByRole("region", { name: "Pushbacks" }, SLOW);
    expect(card.textContent).toContain("The pushbacks could not be read.");
    expect(screen.getByRole("list", { name: "In effect" })).toBeTruthy();
  });

  it("Retired sits under the page's Details: each rule's reason and date; a line when the ledger has none", async () => {
    current = view({ applied: APPLIED, retired: [{ id: "C-007", reason: "covered by C-001", date: "2026-11-14" }] });
    await show();
    const details = await openDetails();
    const list = within(details).getByRole("list", { name: "Retired" });
    expect(list.querySelector('[data-retired-rule="C-007"]')!.textContent).toBe("Retired ruleRetired 2026-11-14: covered by C-001");
    expect(list.querySelector('[data-retired-rule="C-007"]')!.matches("[data-list-row]")).toBe(true);
    expect(screen.queryByRole("region", { name: "Retired" })).toBeNull();
    cleanup();
    current = view({ applied: APPLIED, retired: [] });
    await show();
    expect(within(await openDetails()).getByText("No rule has been retired.")).not.toBeNull();
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
    expect(section("Waiting for you").querySelector("li[data-rule]")).toBeNull();
    // The decided entries sit under the page's Details, under an "N decided" heading.
    const details = await openDetails();
    expect(details.querySelector("[data-decided] h3")!.textContent).toBe("2 decided");
    expect(within(details).getByRole("list", { name: "Decided" }).contains(card("P-0007"))).toBe(true);
    expect(card("P-0007").textContent).toContain("Judged: reject");
  });

  it("the waiting count and the section count exclude judged entries; one PageHeader names the page; How this works is under Details", async () => {
    current = view({ entries: [...judgedEntries(), ...view().entries] });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(document.querySelector("[data-waiting]")!.textContent).toBe("2 waiting");
    expect(section("Waiting for you").querySelectorAll("li[data-rule]")).toHaveLength(2);
    expect(h1s()).toEqual(["Rules"]);
    const details = document.querySelector<HTMLDetailsElement>("details[data-page-details]")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-how] h3")!.textContent).toBe("How this works");
  });

  it("two sections, In effect then Waiting for you, and one Details at the end; no tabs; every row in both is a ListRow", async () => {
    current = view({ applied: APPLIED, improve: { report: null } as unknown as NonNullable<RulesView["improve"]> });
    standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: true, set_by: "github:1", created_at: AT, updated_at: AT, last_fired_at: null, recent: [] }],
      proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: AT }],
    };
    await show();
    await waitFor(() => expect(document.querySelector('[data-proposal="sp_1"]')).not.toBeNull(), SLOW);
    // Exactly two regions, in this order; no tablist.
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["In effect", "Waiting for you"]);
    expect(screen.queryByRole("tablist")).toBeNull();
    // In effect: the standing rule that is on, then the applied rules.
    const effect = within(section("In effect")).getByRole("list", { name: "In effect" });
    const rows = [...effect.querySelectorAll<HTMLElement>(":scope > li")];
    expect(rows.map((r) => r.dataset.rule ?? r.dataset.applied ?? "raw")).toEqual(["spec-t1", "C-001", "C-002", "raw"]);
    expect(rows.every((r) => r.matches("[data-list-row]"))).toBe(true);
    expect(within(section("In effect")).getByText("Approves tier 1 plans for you")).not.toBeNull();
    // Waiting for you: the standing proposal, then candidates, then structure proposals, each group a list of its own.
    const waiting = section("Waiting for you");
    expect([...waiting.querySelectorAll("ul")].map((u) => u.getAttribute("aria-label"))).toEqual(["Turn on auto-approve", "Rule candidates", "Structure proposals"]);
    const wrows = [...waiting.querySelectorAll<HTMLElement>("ul > li")];
    expect(wrows.map((r) => r.dataset.proposal ?? r.dataset.rule)).toEqual(["sp_1", "C-012", "P-0007"]);
    expect(wrows.every((r) => r.matches("[data-list-row]"))).toBe(true);
    // The waiting count is a Badge beside the title, counting the standing proposal too.
    const badge = document.querySelector<HTMLElement>("[data-waiting]")!;
    expect(badge.querySelector("[data-level]")!.textContent).toBe("3 waiting");
    expect(badge.parentElement!.querySelector("h1")!.textContent).toBe("Rules");
    // One Details disclosure, the page's last element, holding the improve link, Retired and How this works.
    const all = document.querySelectorAll("details[data-page-details]");
    expect(all).toHaveLength(1);
    const details = all[0]!;
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(details.parentElement!.lastElementChild).toBe(details);
    const link = details.querySelector<HTMLAnchorElement>("[data-improve-link] a")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["See the improve report on the Health page", "/app/health?tab=improve"]);
    for (const part of ["[data-retired-part]", "[data-how]"]) expect(details.querySelector(part)).not.toBeNull();
    // No improve report on the page itself.
    expect(screen.queryByText("Improve report")).toBeNull();
  });

  it("a standing rule that is off sits under Details, with its switch; In effect says so when nothing is on", async () => {
    standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: false, set_by: null, created_at: null, updated_at: null, last_fired_at: null, recent: [] }],
      proposals: [],
    };
    await show();
    const details = await openDetails();
    await waitFor(() => expect(details.querySelector('[data-standing-off] [data-rule="spec-t1"]')).not.toBeNull(), SLOW);
    expect(within(details).getByRole("switch", { name: "Approves tier 1 plans for you" })).not.toBeNull();
    expect(section("In effect").querySelector('[data-rule="spec-t1"]')).toBeNull();
    expect(section("In effect").querySelector("[data-in-effect-empty]")!.textContent).toBe("No rule is in effect yet.");
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
    await screen.findByRole("list", { name: "In effect" }, SLOW);
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

  it("Promote is the row's visible action; its ⋯ menu lists every verdict, Promote first and Reject last in the danger tone; a disabled Promote says why in the row", async () => {
    current = view({ entries: [{ id: "C-013", title: "Summary first.", state: "pending", judged: null, draft: null, draft_error: "x" }, ...view().entries] });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep existing CLI flags.", "Promote", "⋯"]);
    // Promote is a secondary button, not the view's primary action.
    expect(within(card("C-012")).getByRole("button", { name: "Promote" }).className).not.toContain("bg-accent");
    fireEvent.click(within(card("C-012")).getByRole("button", { name: /^Decide:/ }));
    const items = within(card("C-012")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Promote", "Hold", "Reject"]);
    expect(items[2]!.className).toContain("text-pill-bad-fg");
    expect((within(card("C-013")).getByRole("button", { name: "Promote" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card("C-013").querySelector("[data-draft-error]")!.textContent).toContain("Promote is off");
  });

  it("a waiting proposal's row shows its kind and file count only; its before and after lines are behind Why and where; one without lines shows no excerpt", async () => {
    current = view({
      entries: [
        { id: "P-20261103-34e9", title: "Quiet notify", state: "open", kind: "edit-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null },
        { id: "P-0007", title: "Split the review prompt", state: "held", kind: "edit-asset", target: "prompts/review.md", judged: null, draft: null, draft_error: null },
      ],
      excerpts: { "P-20261103-34e9": { before: "notify every hour", after: "notify at 8am" } },
    } as Partial<RulesView>);
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const row = card("P-20261103-34e9");
    expect(row.querySelector("[data-rule-what]")!.textContent).toBe("Edit a file: 1 file");
    expect(row.querySelector("[data-rule-excerpt]")).toBeNull();
    expect(row.textContent).not.toContain("notify every hour");
    fireEvent.click(whyToggle("P-20261103-34e9"));
    await waitFor(() => expect(row.querySelector("details [data-rule-excerpt]")).not.toBeNull(), SLOW);
    expect(row.querySelector('[data-excerpt="before"]')!.textContent).toBe("Beforenotify every hour");
    expect(row.querySelector('[data-excerpt="after"]')!.textContent).toBe("Afternotify at 8am");
    expect(row.querySelector("[data-rule-what]")!.textContent).not.toContain("bin/");
    fireEvent.click(whyToggle("P-0007"));
    await waitFor(() => expect(card("P-0007").querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
    expect(card("P-0007").querySelector("[data-rule-excerpt]")).toBeNull();
  });

  it("the verdict dialog titles the verdict and the entry title, shows the title once and the detail above the fields, and labels the reason as it reads", async () => {
    const long = "A".repeat(80);
    current = view({ entries: [{ id: "C-037", title: long, state: "pending", judged: null, draft: { default: "d", exception: "e", incidents: ["T-1"], scope: "s" }, draft_error: null }] });
    detail = { id: "C-037", error: null, detail: { id: "C-037", incidents: 2, scope: "software" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-037"), "Promote");
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Promote: ${long}`);
    expect(dialog().querySelector("h2")!.textContent).not.toContain("C-037");
    // The title shows once, in the heading: the body does not repeat it.
    expect(dialog().querySelector("[data-dialog-summary]")).toBeNull();
    await waitFor(() => expect(dialog().querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    // Outside the heading, the title shows only as the prefilled rule wording (a field), never as body text.
    const body = dialog().cloneNode(true) as HTMLElement;
    body.querySelectorAll("h2, textarea").forEach((n) => n.remove());
    expect(body.textContent).not.toContain(long);
    const all = dialog().innerHTML;
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
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-20261103-34e9"), label);
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

  it("the Reject dialog shows the full title in its heading; the evidence shows 3 and the rest behind Show all N", async () => {
    const long = "B".repeat(90);
    current = view({ entries: proposalEntry(long) });
    const evidence = ["2026-11-01", "2026-11-05", "2026-11-03", "2026-11-04", "2026-11-02"].map((date, i) => ({ ref: `E-${i}`, date, quote: `q${i}` }));
    detail = { id: "P-20261103-34e9", error: null, detail: { id: "P-20261103-34e9", evidence } };
    await openDialog("Reject");
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Reject: ${long}`);
    expect(dialog().querySelector("[data-dialog-summary]")).toBeNull();
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

  it("a long Korean title stays in the heading and long Korean quotes wrap in the dialog instead of overflowing it", async () => {
    const title = "프로모트할 때 근거와 맥락을 보여주어 소유자가 무엇을 근거로 한 제안인지 판단할 수 있게 한다".repeat(3);
    const said = "새벽 세 시에 알림이 계속 와서 잠을 못 잤으니 야간에는 알림을 보내지 않도록 바꿔 달라고 여러 번 말했다".repeat(4);
    current = view({ entries: proposalEntry(title) });
    detail = { ...TWO_INCIDENTS, detail: { ...TWO_INCIDENTS.detail!, evidence: TWO_INCIDENTS.detail!.evidence!.map((e) => ({ ...e, quote: said })) } };
    await openDialog("Promote");
    // The title is the heading's (the dialog's own wrapping); every quote breaks inside the dialog's width.
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Promote: ${title}`);
    for (const el of dialog().querySelectorAll<HTMLElement>("blockquote[data-quote]")) {
      expect(el.className).toContain("break-words");
      expect(el.className).not.toMatch(/\b(truncate|whitespace-nowrap)\b/);
    }
    expect(dialog().querySelectorAll("blockquote[data-quote]")).toHaveLength(2);
    expect(dialog().querySelector("[data-rule-detail]")!.className).toContain("min-w-0");
  });

  it("each waiting row's ⋯ menu sits at the right end of its title line, not on a line of its own", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    for (const id of ["C-012", "P-0007"]) {
      const menu = card(id).querySelector<HTMLElement>("[data-row-menu]")!;
      // The menu is the row's last child, beside the column that holds the title, in the same flex row.
      expect(menu.parentElement).toBe(card(id));
      expect(menu.previousElementSibling!.querySelector("[data-rule-title]")).not.toBeNull();
      expect(card(id).className).toContain("flex");
      expect(within(menu).getByRole("button", { name: /^Decide:/ })).toBeTruthy();
    }
  });

  it("kinds read in plain words and a target of several files reads as a count, in the row and in the detail; the full target stays in Why and where", async () => {
    current = view({
      entries: [
        { id: "P-1", title: "Many files", state: "open", kind: "edit-asset", target: "prompts/a.md, prompts/b.md, bin/evolve, docs/c.md", judged: null, draft: null, draft_error: null },
        { id: "P-2", title: "Learning", state: "open", kind: "promote-learning", target: "skills/git/learnings.md", judged: null, draft: null, draft_error: null },
        { id: "P-3", title: "New", state: "open", kind: "new-asset", target: "skills/new/SKILL.md", judged: null, draft: null, draft_error: null },
        { id: "P-4", title: "Other", state: "open", kind: "rename-thing", target: "x.md", judged: null, draft: null, draft_error: null },
      ],
    });
    detail = (id) => ({ id, error: null, detail: { id } });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const what = (id: string) => card(id).querySelector("[data-rule-what]")!.textContent;
    expect(["P-1", "P-2", "P-3", "P-4"].map(what)).toEqual([
      "Edit a file: 4 files", "Turn a learning into a rule: 1 file", "Add a new file: 1 file", "Change: 1 file",
    ]);
    for (const raw of ["edit-asset", "promote-learning", "new-asset", "rename-thing"]) expect(document.body.textContent).not.toContain(raw);
    fireEvent.click(within(card("P-1")).getByText("Why and where").closest("summary")!);
    const part = await waitFor(() => {
      const el = card("P-1").querySelector<HTMLElement>('[data-detail-part="what"]');
      if (!el) throw new Error("the detail is not open yet");
      return el;
    }, SLOW);
    expect(part.textContent).toContain("Kind: Edit a file: 4 files");
    expect(part.textContent).toContain("Changes: prompts/a.md, prompts/b.md, bin/evolve, docs/c.md");
    expect(part.textContent).not.toContain("edit-asset");
  });

  it("with the rules home off, the Turn on empty state comes before Auto-approve specs", async () => {
    current = off();
    standing = { as_of: AT, csrf_token: TOKEN, rules: [], proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: AT }] };
    await show();
    const turnOn = await screen.findByRole("button", { name: "Turn on" }, SLOW);
    const approvals = await screen.findByRole("region", { name: "Auto-approve specs" }, SLOW);
    expect(turnOn.compareDocumentPosition(approvals) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("Improve report")).toBeNull();
  });

  it("no rules string names a tool, the ledger or a CLI path", async () => {
    const { rules } = await import("../web/src/i18n/en/rules.js");
    for (const [key, text] of Object.entries(rules)) expect([key, text]).not.toEqual([key, expect.stringMatching(/evolve|tacit|sync-agents|ledger|bin\//i)]);
  });

  it("the intro says what the page is for in plain words, and no raw rule ID, provider ID, ISO time or kind shows outside Details", async () => {
    current = view({ entries: [...view().entries, { id: "P-0009", title: "Quiet notify", state: "open", kind: "edit-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null }] });
    standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: true, set_by: "github:123", created_at: "2026-11-19T12:41:45.603Z", updated_at: AT, last_fired_at: null, recent: [] }],
      proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: "2026-11-19T12:41:45.603Z" }],
    };
    await show();
    await waitFor(() => expect(document.querySelector('[data-proposal="sp_1"]')).not.toBeNull(), SLOW);
    expect(document.querySelector("header p")!.textContent).toBe("When you correct the agents, the factory suggests rules. Approve, hold, or reject them here.");
    const copy = document.body.cloneNode(true) as HTMLElement;
    // Outside every Details disclosure (closed or not) and the tooltips.
    copy.querySelectorAll("details, [data-raw], [role=tooltip]").forEach((n) => n.remove());
    const text = copy.textContent!;
    for (const raw of ["spec-t1", "github:", "2026-11-19T", "edit-asset"]) expect(text).not.toContain(raw);
    expect(text).toContain("Approves tier 1 plans for you");
    const how = document.querySelector<HTMLElement>("[data-how]")!.textContent!;
    for (const word of [/pushback/i, /ledger/i, /agents home/i]) expect(how).not.toMatch(word);
  });

  it("In effect says nothing is in effect when the file holds nothing and no standing rule is on", async () => {
    current = view({ applied: { rules: [], elsewhere: [] } });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(screen.queryByRole("region", { name: "Applied" })).toBeNull();
    expect(section("In effect").querySelector("[data-in-effect-empty]")!.textContent).toBe("No rule is in effect yet.");
  });

  it("ledger off for a user who is not the owner: the reason, and no Turn on", async () => {
    current = off({ judge: "Only the owner turns the ledger on; you are local:alice.", csrf_token: null, turn_on: null });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

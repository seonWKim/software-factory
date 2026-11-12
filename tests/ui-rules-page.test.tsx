// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesView } from "../web/src/api.js";
import { PAGES, routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-users-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/rules.js";
const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

// The Rules page (issue #571): each pending entry with its title, state and ID; Promote, Hold and Reject ask for a
// reason in a dialog before they send; Promote of a class (C-) sends the owner's wording as the rule, Promote of a
// proposal (P-) sends none. With the ledger off (design 08-settings): the agents home found gives one line and one
// primary Turn on, which writes the `integrations` entry through POST /api/v1/settings and loads the rules with no
// reload; not found, the page names the missing CLI and how to set AGENTS_HOME.

const TOKEN = "tok_rules";
const SLOW = { timeout: 5_000 };

const view = (over: Partial<RulesView> = {}): RulesView => ({
  enabled: true,
  error: null,
  csrf_token: TOKEN,
  judge: null,
  home: null,
  turn_on: null,
  entries: [
    { id: "C-012", title: "Keep existing CLI flags.", state: "pending" },
    { id: "P-0007", title: "Split the review prompt", state: "held" },
  ],
  ...over,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let current: RulesView;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = view();
  posts = [];
  answer = { status: 200, body: { id: "C-012", verdict: "promote" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      // The settings route's answer to Turn on: the ledger is on from the next GET.
      if (url === "/api/v1/settings" && answer.status === 200) current = view();
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/rules") return json(200, current);
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

  it("lists each pending entry's title, state and ID, and no evidence, kind, scope or draft", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    expect(card("C-012").textContent).toContain("Pending");
    expect(card("C-012").textContent).toContain("C-012");
    expect(card("P-0007").textContent).toContain("Held");
    expect(card("P-0007").querySelector("[data-rule-title]")!.textContent).toBe("Split the review prompt");
    for (const gone of ["Evidence", "Rule draft", "Candidate class"]) expect(card("C-012").textContent).not.toContain(gone);
  });

  it("a verdict button asks for a reason before it sends; promote of a class sends the edited wording", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: "Promote" }));
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(posts).toEqual([]);
    const wording = within(dialog()).getByRole("textbox", { name: "Rule wording" }) as HTMLTextAreaElement;
    expect(wording.value).toBe("Keep existing CLI flags.");
    fireEvent.change(wording, { target: { value: "Keep every existing CLI flag." } });
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "seen twice" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/rules/verdict");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(sent()).toEqual([{ id: "C-012", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." }]);
  });

  it("hold and reject send only the reason; promote of a proposal asks for no wording and sends no text", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    for (const [label, reason] of [["Hold", "wait"], ["Reject", "not code"], ["Promote", "good shape"]] as const) {
      fireEvent.click(within(card("P-0007")).getByRole("button", { name: label }));
      expect(within(dialog()).queryByRole("textbox", { name: "Rule wording" })).toBeNull();
      fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: reason } });
      fireEvent.click(within(dialog()).getByRole("button", { name: `Send ${label.toLowerCase()}` }));
      await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    }
    expect(sent()).toEqual([
      { id: "P-0007", verdict: "hold", reason: "wait" },
      { id: "P-0007", verdict: "reject", reason: "not code" },
      { id: "P-0007", verdict: "promote", reason: "good shape" },
    ]);
  });

  it("a refusal stays in the dialog", async () => {
    answer = { status: 403, body: { error: "Only the owner judges rules; you are local:alice." } };
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: "Hold" }));
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send hold" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
  });

  it("a user who is not the owner sees the entries read-only with the reason, and no verdict buttons", async () => {
    current = view({ judge: "Only the owner judges rules; you are local:alice." });
    await show();
    expect((await screen.findByRole("note", {}, SLOW)).textContent).toContain("Only the owner");
    expect(within(card("C-012")).queryByRole("button")).toBeNull();
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
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    expect(card("C-012")).not.toBeNull();
  });

  it("a refused Turn on shows the refusal and stays off", async () => {
    current = off();
    answer = { status: 422, body: { error: "refused: integrations changes only by the owner" } };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: "Turn on" }, SLOW));
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("only by the owner");
    expect(screen.queryByRole("list", { name: "Rules waiting for you" })).toBeNull();
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

  it("ledger off for a user who is not the owner: the reason, and no Turn on", async () => {
    current = off({ judge: "Only the owner turns the ledger on; you are local:alice.", csrf_token: null, turn_on: null });
    await show();
    expect((await screen.findByRole("note", {}, SLOW)).textContent).toContain("Only the owner");
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

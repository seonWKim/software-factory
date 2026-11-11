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

// The Rules page (issue #571): each pending entry with its evidence lines and rule draft; Promote, Hold and Reject ask
// for a reason in a dialog before they send; Promote lets the owner edit the wording; with the plugin none, one action
// explains how to turn on agents-home.

const TOKEN = "tok_rules";
const SLOW = { timeout: 5_000 };

const view = (over: Partial<RulesView> = {}): RulesView => ({
  enabled: true,
  error: null,
  csrf_token: TOKEN,
  judge: null,
  entries: [
    { id: "r1", kind: "class", scope: ["software"], evidence: ["wi_1: keep the existing CLI flag", "wi_2: do not drop --json"], rule_draft: "Keep existing CLI flags." },
    { id: "r2", kind: "pushback", scope: [], evidence: ["split the test"], rule_draft: "" },
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
  answer = { status: 200, body: { id: "r1", verdict: "promote" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
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

  it("lists each pending entry's kind, rule draft and evidence lines", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    expect(card("r1").textContent).toContain("Candidate class");
    expect(card("r1").querySelector("[data-rule-draft]")!.textContent).toBe("Keep existing CLI flags.");
    expect(within(card("r1")).getByRole("list", { name: "Evidence for r1" }).textContent).toContain("do not drop --json");
    expect(card("r2").querySelector("[data-rule-draft]")!.textContent).toContain("No draft yet");
  });

  it("a verdict button asks for a reason before it sends; promote sends the edited wording", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    fireEvent.click(within(card("r1")).getByRole("button", { name: "Promote" }));
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
    expect(sent()).toEqual([{ id: "r1", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag." }]);
  });

  it("hold and reject send only the reason; an unchanged promote sends no text", async () => {
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    for (const [label, reason] of [["Hold", "wait"], ["Reject", "not code"], ["Promote", "fine as drafted"]] as const) {
      fireEvent.click(within(card("r1")).getByRole("button", { name: label }));
      expect(within(dialog()).queryByRole("textbox", { name: "Rule wording" }) === null).toBe(label !== "Promote");
      fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: reason } });
      fireEvent.click(within(dialog()).getByRole("button", { name: `Send ${label.toLowerCase()}` }));
      await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    }
    expect(sent()).toEqual([
      { id: "r1", verdict: "hold", reason: "wait" },
      { id: "r1", verdict: "reject", reason: "not code" },
      { id: "r1", verdict: "promote", reason: "fine as drafted" },
    ]);
  });

  it("a refusal stays in the dialog", async () => {
    answer = { status: 403, body: { error: "Only the owner judges rules; you are local:alice." } };
    await show();
    await screen.findByRole("list", { name: "Rules waiting for you" }, SLOW);
    fireEvent.click(within(card("r1")).getByRole("button", { name: "Hold" }));
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send hold" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
  });

  it("a user who is not the owner sees the entries read-only with the reason, and no verdict buttons", async () => {
    current = view({ judge: "Only the owner judges rules; you are local:alice." });
    await show();
    expect((await screen.findByRole("note", {}, SLOW)).textContent).toContain("Only the owner");
    expect(within(card("r1")).queryByRole("button")).toBeNull();
  });

  it("with the plugin none: an empty state with one action that explains how to enable agents-home", async () => {
    current = { enabled: false, entries: [], error: null, csrf_token: null, judge: null };
    await show();
    const action = await screen.findByRole("button", { name: "How to turn on the ledger" }, SLOW);
    expect(screen.getAllByRole("button")).toEqual([action]);
    expect(action.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(action);
    expect(action.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("rules-enable")!.textContent).toContain('"tacit": "agents-home"');
  });
});

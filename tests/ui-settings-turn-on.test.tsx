// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesView, SettingsView } from "../web/src/api.js";

// Settings → Integrations (design 09-dashboard-rules.md): the TacitLedger switch, when off, opens a Dialog with the
// Rules page's agents home picker, read once from GET /api/v1/rules; Turn on posts that read's `turn_on` through
// POST /api/v1/settings with the settings token. tsconfig.test.json checks this file without JSX, so the tab is built
// with createElement and loaded by a specifier the node check skips.
const TAB_MODULE = "../web/src/views/settings/integrations.js";
const { IntegrationsTab } = (await import(/* @vite-ignore */ TAB_MODULE)) as { IntegrationsTab: FunctionComponent<{ view: SettingsView }> };

const SETTINGS_TOKEN = "tok_settings";
const TURN_ON = '{"tacit":"agents-home"}';
const SLOW = { timeout: 5_000 };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const settings = (plugin: string, source: "config" | "setting"): SettingsView =>
  ({
    csrf_token: SETTINGS_TOKEN,
    keys: [{ key: "integrations", value: source === "setting" ? { tacit: plugin } : null }],
    integrations: [{ kind: "tacit", interface: "TacitLedger", plugin, source, configured: "none" }],
  }) as unknown as SettingsView;

const rules = (over: Partial<RulesView> = {}): RulesView => ({
  enabled: false, entries: [], applied: null, error: null, csrf_token: null, judge: null,
  home: { path: "/h/.agents", missing: null, homes: [{ path: "/h/.agents", missing: null }, { path: "/o/agents", missing: null }] },
  turn_on: TURN_ON, ...over,
});

let current: RulesView;
let calls: { url: string; method: string; body?: string }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = rules();
  calls = [];
  answer = { status: 200, body: { ok: true, lines: ["integrations set"] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    if (init?.method === "POST") return json(answer.status, answer.body);
    if (url === "/api/v1/rules") return json(200, current);
    if (url === "/api/v1/calendar") return json(200, { plugins: [] });
    return json(404, {});
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = (view: SettingsView) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(IntegrationsTab, { view })));
};
const flip = () => fireEvent.click(screen.getByRole("switch", { name: "Integration: TacitLedger" }));
const dialog = async () => within(await screen.findByRole("dialog", { name: "Turn on TacitLedger?" }, SLOW));
const rulesReads = () => calls.filter((c) => c.url === "/api/v1/rules").length;
const posted = () => calls.filter((c) => c.method === "POST");

describe("Settings → Integrations: turning the TacitLedger on", () => {
  it("opens a dialog with the shared picker and sends nothing, then Turn on posts the server's turn_on once", async () => {
    open(settings("none", "config"));
    flip();
    const d = await dialog();
    await d.findByRole("radiogroup", { name: "Agents home" }, SLOW);
    expect((d.getByRole("radio", { name: "/h/.agents (in use)" }) as HTMLInputElement).checked).toBe(true);
    expect(d.getByText("bin/tacit and bin/evolve are both executable in /h/.agents.")).not.toBeNull();
    expect(posted()).toEqual([]);
    expect(rulesReads()).toBe(1);
    const on = d.getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    await waitFor(() => expect(on.disabled).toBe(false));
    fireEvent.click(on);
    await waitFor(() => expect(posted()).toHaveLength(1), SLOW);
    expect(posted()[0]).toMatchObject({ url: "/api/v1/settings" });
    expect(JSON.parse(posted()[0]!.body!)).toEqual({ action: "set", key: "integrations", value: TURN_ON });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
  });

  it("with the home in use missing, Turn on is off, the missing file is shown and nothing is sent", async () => {
    current = rules({ turn_on: null, home: { path: "/h/.agents", missing: "bin/evolve", homes: [{ path: "/h/.agents", missing: "bin/evolve" }] } });
    open(settings("none", "config"));
    flip();
    const d = await dialog();
    await d.findByText("bin/evolve is missing or not executable in /h/.agents.", {}, SLOW);
    const on = d.getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    expect(on.disabled).toBe(true);
    fireEvent.click(on);
    expect(posted()).toEqual([]);
  });

  it("a non-owner sees the Rules page's reason with Turn on off, and a refusal that reaches the server stays in the dialog", async () => {
    const reason = "Only the owner turns the ledger on; you are local:guest.";
    current = rules({ judge: reason, turn_on: null });
    open(settings("none", "config"));
    flip();
    const d = await dialog();
    await d.findByText(reason, {}, SLOW);
    expect((d.getByRole("button", { name: "Turn on" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    current = rules();
    answer = { status: 403, body: { ok: false, error: reason } };
    open(settings("none", "config"));
    flip();
    const again = await dialog();
    const on = again.getByRole("button", { name: "Turn on" }) as HTMLButtonElement;
    await waitFor(() => expect(on.disabled).toBe(false), SLOW);
    fireEvent.click(on);
    await again.findByText(reason, {}, SLOW);
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("Cancel closes the dialog, sends nothing and leaves the switch off", async () => {
    open(settings("none", "config"));
    flip();
    const d = await dialog();
    fireEvent.click(d.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted()).toEqual([]);
    expect(screen.getByRole("switch", { name: "Integration: TacitLedger" }).getAttribute("aria-checked")).toBe("false");
  });

  it("with the ledger on, the switch turns it off at once with no dialog", async () => {
    open(settings("agents-home", "setting"));
    flip();
    await waitFor(() => expect(posted()).toHaveLength(1), SLOW);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(JSON.parse(posted()[0]!.body!)).toEqual({ action: "reset", key: "integrations" });
    expect(rulesReads()).toBe(0);
  });
});

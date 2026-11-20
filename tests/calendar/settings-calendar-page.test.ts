// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarPluginView, CalendarView } from "../../web/src/api.js";

// The Settings page's Calendar section (design 08-settings, 2026-11-13). tsconfig.test.json checks this file without
// JSX, so the section is built with createElement and its .tsx module is loaded by a specifier the node check skips.
const SECTION_MODULE = "../../web/src/views/settings-calendar.js";
const { CalendarSection } = (await import(/* @vite-ignore */ SECTION_MODULE)) as { CalendarSection: FunctionComponent<{ token: string }> };

const TOKEN = "tok_cal";
const NAME = "fixture-calendar";
const URL_ = "https://consent.example/auth?state=s1";
const plugin = (over: Partial<CalendarPluginView> = {}): CalendarPluginView => ({ name: NAME, connected: false, default_client: true, synced_at: null, error: null, attempt: null, ...over });

let view: CalendarView;
let posts: { url: string; body: Record<string, unknown>; token: string | null }[];
let answers: { status: number; body: unknown }[];
let opened: string[];

beforeEach(() => {
  view = { plugins: [plugin()] };
  posts = [];
  answers = [];
  opened = [];
  vi.stubGlobal("open", (u: string) => void opened.push(u));
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown>, token: new Headers(init.headers).get("x-csrf-token") });
      const a = answers.shift() ?? { status: 200, body: {} };
      return json(a.status, a.body);
    }
    if (url === "/api/v1/calendar") return json(200, view);
    return json(404, { error: "not found" });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(CalendarSection, { token: TOKEN })));
  return screen.findByRole("region", { name: "Calendar" });
}

describe("Calendar section", () => {
  it("lists each plugin by its own name, not connected, with its last sync and last error", async () => {
    view = { plugins: [plugin(), plugin({ name: "other", connected: true, synced_at: new Date().toISOString(), error: "events read failed (HTTP 500)" })] };
    const section = await show();
    const row = section.querySelector<HTMLElement>(`[data-calendar="${NAME}"]`)!;
    expect(row.textContent).toContain("not connected");
    expect(row.textContent).toContain("Not synced yet");
    within(row).getByRole("button", { name: `Connect ${NAME}` });
    const other = section.querySelector<HTMLElement>('[data-calendar="other"]')!;
    expect(other.textContent).toContain("connected");
    expect(other.textContent).toMatch(/Last sync just now/);
    expect(other.textContent).toContain("Last error: events read failed (HTTP 500)");
    within(other).getByRole("button", { name: "Disconnect other" });
  });

  it("Connect opens the consent page at once, with no dialog", async () => {
    await show();
    answers = [{ status: 202, body: { plugin: NAME, state: "signing_in", consent_url: URL_ } }];
    view = { plugins: [plugin({ attempt: { state: "signing_in", events: null, error: null } })] };
    fireEvent.click(screen.getByRole("button", { name: `Connect ${NAME}` }));
    expect(await screen.findByRole("link", { name: "Open the sign-in page" })).toHaveProperty("href", URL_);
    expect(posts).toEqual([{ url: "/api/v1/calendar/connect", body: { plugin: NAME }, token: TOKEN }]);
    expect(opened).toEqual([URL_]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Use my own client (advanced) asks for the needed values in password fields, sends them once, opens the consent page and forgets them", { timeout: 15_000 }, async () => {
    await show();
    answers = [
      { status: 200, body: { plugin: NAME, state: "needs_input", needs: ["CLIENT_ID", "CLIENT_SECRET"] } },
      { status: 202, body: { plugin: NAME, state: "signing_in", consent_url: URL_ } },
    ];
    fireEvent.click(screen.getByRole("button", { name: `Use my own client for ${NAME}` }));
    const dialog = await screen.findByRole("dialog", { name: `Connect ${NAME} with your own client` });
    expect(posts).toEqual([{ url: "/api/v1/calendar/connect", body: { plugin: NAME, own_client: true }, token: TOKEN }]);
    const id = within(dialog).getByLabelText<HTMLInputElement>("CLIENT_ID");
    const secret = within(dialog).getByLabelText<HTMLInputElement>("CLIENT_SECRET");
    expect([id.type, secret.type]).toEqual(["password", "password"]);
    const signIn = within(dialog).getByRole("button", { name: "Sign in" });
    expect(signIn).toHaveProperty("disabled", true);
    fireEvent.change(id, { target: { value: "the-id" } });
    fireEvent.change(secret, { target: { value: "the-secret" } });
    view = { plugins: [plugin({ attempt: { state: "signing_in", events: null, error: null } })] };
    fireEvent.click(signIn);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts[1]).toEqual({ url: "/api/v1/calendar/connect", body: { plugin: NAME, own_client: true, values: { CLIENT_ID: "the-id", CLIENT_SECRET: "the-secret" } }, token: TOKEN });
    expect(opened).toEqual([URL_]);
    expect(await screen.findByRole("link", { name: "Open the sign-in page" })).toHaveProperty("href", URL_);
    expect(document.body.innerHTML).not.toContain("the-secret");

    // Asked again, the fields start empty: the values left the page's state with the attempt.
    view = { plugins: [plugin()] };
    answers = [{ status: 200, body: { plugin: NAME, state: "needs_input", needs: ["CLIENT_ID", "CLIENT_SECRET"] } }];
    // The section polls GET /api/v1/calendar (every 3 s) until the sign-in is no longer open.
    const own = () => screen.getByRole("button", { name: `Use my own client for ${NAME}` });
    await waitFor(() => expect(own()).toHaveProperty("disabled", false), { timeout: 5000 });
    fireEvent.click(own());
    const again = await screen.findByRole("dialog", { name: `Connect ${NAME} with your own client` });
    expect(within(again).getByLabelText<HTMLInputElement>("CLIENT_SECRET").value).toBe("");
  });

  it("shows the result the server reports: Connected, N events read, or why it failed", async () => {
    view = { plugins: [plugin({ connected: true, attempt: { state: "connected", events: 7, error: null } })] };
    const section = await show();
    await waitFor(() => expect(section.textContent).toContain("Connected, 7 events read"));
    cleanup();
    view = { plugins: [plugin({ attempt: { state: "failed", events: null, error: "the callback's state did not match this sign-in: refused, nothing stored" } })] };
    const failed = await show();
    await waitFor(() => expect(failed.textContent).toContain("Not connected: the callback's state did not match"));
  });

  it("Disconnect asks first in a danger Dialog: Cancel sends nothing, Confirm sends the plugin", async () => {
    view = { plugins: [plugin({ connected: true })] };
    await show();
    fireEvent.click(await screen.findByRole("button", { name: `Disconnect ${NAME}` }));
    let dialog = await screen.findByRole("dialog", { name: `Disconnect ${NAME}` });
    expect(dialog.textContent).toContain("Removes its secrets from the secret file");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: `Disconnect ${NAME}` }));
    dialog = await screen.findByRole("dialog", { name: `Disconnect ${NAME}` });
    answers = [{ status: 200, body: { plugin: NAME, connected: false } }];
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" })));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([{ url: "/api/v1/calendar/disconnect", body: { plugin: NAME }, token: TOKEN }]);
  });

  it("with a default client, the one-step Connect comes first, with Use my own client (advanced) beside it", async () => {
    const section = await show();
    const buttons = within(section).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.slice(0, 2)).toEqual(["Connect", "Use my own client (advanced)"]);
    within(section).getByRole("button", { name: `Connect ${NAME}` });
    expect(section.textContent).not.toContain("This build has no default Google client.");
  });

  it("with no default client, no Connect that can only fail: the plain message and Use my own client as the main action", async () => {
    view = { plugins: [plugin({ default_client: false })] };
    const section = await show();
    expect(within(section).queryByRole("button", { name: `Connect ${NAME}` })).toBeNull();
    expect(within(section).queryByRole("button", { name: "Connect" })).toBeNull();
    expect(section.textContent).toContain("This build has no default Google client. Connect with your own OAuth client.");
    const own = within(section).getByRole("button", { name: `Use my own client for ${NAME}` });
    expect(own.textContent).toBe("Use my own client");
    answers = [{ status: 200, body: { plugin: NAME, state: "needs_input", needs: ["CLIENT_ID", "CLIENT_SECRET"] } }];
    fireEvent.click(own);
    await screen.findByRole("dialog", { name: `Connect ${NAME} with your own client` });
    expect(posts).toEqual([{ url: "/api/v1/calendar/connect", body: { plugin: NAME, own_client: true }, token: TOKEN }]);
  });

  it("a refused plain connect shows its error once", async () => {
    const error = 'the sign-in asks for GOOGLE_CLIENT_ID, which only the "use my own client" option sends: nothing stored';
    const section = await show();
    answers = [{ status: 422, body: { error } }];
    fireEvent.click(screen.getByRole("button", { name: `Connect ${NAME}` }));
    await waitFor(() => expect(section.textContent).toContain(error));
    // The next read (the server keeps no failed attempt for a refusal) adds no second copy.
    await waitFor(() => expect(posts).toHaveLength(1));
    await act(async () => new Promise((r) => setTimeout(r, 50)));
    expect(section.textContent!.split(error).length - 1).toBe(1);
  });

  it("beside Connect, a note about the provider's sign-in warning starts collapsed and opens from its toggle", async () => {
    const section = await show();
    const toggle = within(section).getByRole("button", { name: "About Google's sign-in warning" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const body = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(body.hidden).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain('Google may show "Google hasn\'t verified this app" for this client, the default one or your own. That is expected, and Continue is safe.');
    expect(body.textContent).toContain("A client in Testing status must be reconnected every 7 days, unless you set it to In production on the OAuth consent screen. For your own account that needs no verification.");
  });

  it("an invalid_grant sync error shows Reconnect Google Calendar with the note open, not the raw error, and keeps the connect actions", async () => {
    view = { plugins: [plugin({ connected: true, synced_at: new Date().toISOString(), error: "invalid_grant" })] };
    const section = await show();
    const row = section.querySelector<HTMLElement>(`[data-calendar="${NAME}"]`)!;
    await waitFor(() => expect(within(row).getByRole("alert").textContent).toBe("Reconnect Google Calendar"));
    expect(row.textContent).not.toContain("Last error");
    const toggle = within(row).getByRole("button", { name: "About Google's sign-in warning" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)!.textContent).toContain("must be reconnected every 7 days");
    within(row).getByRole("button", { name: `Connect ${NAME}` });
    within(row).getByRole("button", { name: `Use my own client for ${NAME}` });
    within(row).getByRole("button", { name: `Disconnect ${NAME}` });
  });

  it("any other sync error shows as Last error, with no reconnect state", async () => {
    view = { plugins: [plugin({ connected: true, error: "google-calendar: token refresh failed (HTTP 401)" })] };
    const section = await show();
    const row = section.querySelector<HTMLElement>(`[data-calendar="${NAME}"]`)!;
    expect(row.textContent).toContain("Last error: google-calendar: token refresh failed (HTTP 401)");
    expect(row.textContent).not.toContain("Reconnect Google Calendar");
    expect(within(row).queryByRole("button", { name: `Connect ${NAME}` })).toBeNull();
    expect(within(row).queryByRole("button", { name: "About Google's sign-in warning" })).toBeNull();
  });

  it("a refused connect shows its reason beside the button", async () => {
    await show();
    answers = [{ status: 403, body: { error: "Only the owner connects a calendar; you are local:other." } }];
    fireEvent.click(screen.getByRole("button", { name: `Connect ${NAME}` }));
    expect((await screen.findByRole("alert")).textContent).toBe("Only the owner connects a calendar; you are local:other.");
  });
});

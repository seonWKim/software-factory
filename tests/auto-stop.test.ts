// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, type ReactElement, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStop, SettingRow, SettingsView, SystemAction } from "../web/src/api.js";

// The last auto-mode stop (design 03-risk), shown beside the Mode toggle and in the system banner: when and why, a
// link to its alarm, and one click back to auto through POST /api/v1/settings. A burst of agent-run failures stops
// nothing, so there is no stop line: only its alarm in the open-alarms line.

// tsconfig.test.json checks this file without JSX, so the views are built with createElement and their .tsx modules are
// loaded by a specifier the node check skips (as in ui-settings-page.test.tsx).
const SETTINGS_MODULE = "../web/src/views/settings.js";
const BANNER_MODULE = "../web/src/views/system-banner.js";
const { SettingsPage } = (await import(/* @vite-ignore */ SETTINGS_MODULE)) as { SettingsPage: FunctionComponent };
const { FloorNotes } = (await import(/* @vite-ignore */ BANNER_MODULE)) as {
  FloorNotes: FunctionComponent<{ actions: readonly SystemAction[]; deadlocks: number }>;
};

const AT = "2026-11-13T11:52:30.000Z";
const TOKEN = "tok_stop";
const row = (key: string, extra: Partial<SettingRow>): SettingRow => ({
  key, description: key, kind: "number", value: "0", source: "default", file_value: null, default_value: "0", applies_at: "the next tick",
  project_settable: false, projects: [], ...extra,
});
const settingsView = (mode: "auto" | "manual", auto_stop: AutoStop | null): SettingsView => ({
  as_of: AT,
  csrf_token: TOKEN,
  repo: "o/r",
  project: null,
  project_keys: [],
  keys: [
    row("mode", { kind: "mode", value: JSON.stringify(mode), source: "override", default_value: '"manual"', project_settable: true }),
    row("auto_merge_max_tier", {}),
  ],
  pr_only: [],
  file_keys: null,
  ignored: [],
  history: [],
  auto_stop,
});
const stop = (cause: string): AutoStop => ({ alert_id: "al_1", at: AT, cause });
const time = new Date(AT).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const alarm = (auto_stop?: AutoStop): SystemAction => ({
  code: "alarm", text: "Alarm: something", command: "factory doctor", until: null, ...(auto_stop ? { auto_stop } : {}),
});

let view: SettingsView;
let posts: { url: string; init: RequestInit }[] = [];

beforeEach(() => {
  posts = [];
  view = settingsView("manual", null);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push({ url, init });
      return json({ ok: true, lines: ["mode = \"auto\""] });
    }
    if (url === "/api/v1/settings") return json(view);
    if (url === "/api/v1/session") return json({ as_of: AT, csrf_token: "t", commands_enabled: true, actor: "local:me", actor_source: "environment" });
    return new Response("{}", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(el: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, el));
}

/** The Settings page's Mode section, once loaded. */
async function modeSection(): Promise<HTMLElement> {
  mount(createElement(SettingsPage));
  return screen.findByRole("region", { name: "Mode" });
}

/** Clicks "Turn auto back on" in `within` and returns the write it posted. */
async function turnAutoOn(scope: HTMLElement) {
  const button = await within(scope).findByRole("button", { name: "Turn auto back on" });
  await act(async () => fireEvent.click(button));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("/api/v1/settings");
  expect((posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
  return JSON.parse(String(posts[0]!.init.body)) as unknown;
}

describe("auto stop: red main", () => {
  it("the Mode toggle shows manual, when and why auto stopped, a link to the alarm and Turn auto back on", async () => {
    view = settingsView("manual", stop("red_main"));
    const section = await modeSection();
    const note = await within(section).findByText(`Back to manual at ${time}: the checks failed on the base branch after a merge`);
    expect(time).toMatch(/^\d\d:\d\d$/);
    expect(section.textContent).toContain("manual");
    const link = within(section).getByRole("link", { name: "See the alarm" });
    expect(link.getAttribute("href")).toBe("/app/#alarm-al_1");
    expect(note.closest("[data-auto-stop]")).not.toBeNull();
    // One click, no confirmation: mode auto through the setting save path.
    expect(await turnAutoOn(section)).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });

  it("the system banner shows the same line as the alarm's own target, with its link and button", async () => {
    view = settingsView("manual", stop("red_main"));
    mount(createElement(FloorNotes, { actions: [alarm(stop("red_main")), alarm()], deadlocks: 0 }));
    const line = (await screen.findByText(`Back to manual at ${time}: the checks failed on the base branch after a merge`)).closest("li")!;
    expect(line.id).toBe("alarm-al_1");
    expect(within(line).getByRole("link", { name: "See the alarm" }).getAttribute("href")).toBe("/app/#alarm-al_1");
    // The stop has its own line, so the open-alarms line counts only the other alarm.
    expect(screen.getByText("Open alarms: 1.")).not.toBeNull();
    expect(await turnAutoOn(line)).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });
});

describe("auto stop: budget checkpoint", () => {
  it("the Mode toggle and the system banner both show the checkpoint and the time", async () => {
    view = settingsView("manual", stop("budget_checkpoint"));
    const text = `Back to manual at ${time}: an item reached its budget checkpoint`;
    const section = await modeSection();
    expect(await within(section).findByText(text)).not.toBeNull();
    cleanup();
    mount(createElement(FloorNotes, { actions: [alarm(stop("budget_checkpoint"))], deadlocks: 0 }));
    const line = (await screen.findByText(text)).closest("li")!;
    expect(within(line).getByRole("link", { name: "See the alarm" })).not.toBeNull();
    expect(await within(line).findByRole("button", { name: "Turn auto back on" })).not.toBeNull();
    expect(screen.queryByText(/Open alarms/)).toBeNull();
  });
});

describe("auto stop: a burst of agent-run failures", () => {
  it("leaves the mode auto with no stop line; its alarm shows in the open-alarms line", async () => {
    view = settingsView("auto", null);
    const section = await modeSection();
    expect(section.textContent).toContain("auto");
    expect(section.querySelector("[data-auto-stop]")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Turn auto back on" })).toBeNull();
    cleanup();
    mount(createElement(FloorNotes, { actions: [alarm()], deadlocks: 0 }));
    expect(screen.getByText("Open alarms: 1.")).not.toBeNull();
    expect(document.querySelector("[data-action='auto_stop']")).toBeNull();
  });
});

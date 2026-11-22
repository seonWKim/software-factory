// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, type ReactElement, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoStop, SettingRow, SettingsView, SystemAction } from "../web/src/api.js";

/** The items of a row's ⋯ menu as [label, data-action]; the menu is closed again after reading. */
function menuOf(row: HTMLElement): [string | null, string | null][] {
  const more = within(row).getByRole("button", { name: "More commands" });
  fireEvent.click(more);
  const items = within(row).getAllByRole("menuitem").map((m) => [m.textContent, m.getAttribute("data-action")] as [string | null, string | null]);
  fireEvent.click(more);
  return items;
}

// The last auto-mode stop (design 03-risk), shown beside the Mode toggle (with its link to the alarm and its button)
// and on its alarm's Needs-you row (the Check group, design 09-dashboard-tasks): one sentence in local time, the
// server's full text behind a Details toggle, and a "⋯" menu of Turn auto back on (the same settings write) and What
// failed. Turn auto back on opens the mode confirmation Dialog (design 09-dashboard-settings, 2026-11-22); only its
// Confirm writes. A burst of agent-run failures stops nothing, so there is no stop: its alarm's row has Show failures.

// tsconfig.test.json checks this file without JSX, so the views are built with createElement and their .tsx modules are
// loaded by a specifier the node check skips (as in ui-settings-page.test.tsx).
const SETTINGS_MODULE = "../web/src/views/settings.js";
const BANNER_MODULE = "../web/src/views/system-banner.js";
const { SettingsPage } = (await import(/* @vite-ignore */ SETTINGS_MODULE)) as { SettingsPage: FunctionComponent };
const { CheckRow } = (await import(/* @vite-ignore */ BANNER_MODULE)) as { CheckRow: FunctionComponent<{ action: SystemAction }> };
/** The Check group's rows of `actions`, as NeedsList draws them. */
const checks = (actions: readonly SystemAction[]) => createElement("ul", null, actions.map((action, i) => createElement(CheckRow, { key: i, action })));

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
/** The server's full text of an auto-stop alarm (alarmText and its detail). */
const FULL = "Alarm: back to manual: the checks failed on the base branch after a merge: `npm test` exited 1 on the new tip of `main`";
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

/** The open mode confirmation Dialog. */
const modeDialog = () => screen.getByRole("dialog", { name: "Turn on auto mode?" });

/** Confirms the open mode Dialog and returns the one write it posted; nothing was posted before Confirm. */
async function confirmAuto() {
  expect(posts).toHaveLength(0);
  await act(async () => fireEvent.click(within(modeDialog()).getByRole("button", { name: "Turn on auto" })));
  expect(posts).toHaveLength(1);
  expect(posts[0]!.url).toBe("/api/v1/settings");
  expect((posts[0]!.init.headers as Record<string, string>)["x-csrf-token"]).toBe(TOKEN);
  return JSON.parse(String(posts[0]!.init.body)) as unknown;
}

/** Clicks "Turn auto back on" in `scope`, which opens the Dialog, and confirms it; returns the write it posted. */
async function turnAutoOn(scope: HTMLElement) {
  const button = await within(scope).findByRole("button", { name: "Turn auto back on" });
  await act(async () => fireEvent.click(button));
  return confirmAuto();
}

/** The local-time sentence of an auto-stop row. */
const sentence = (cause: string) => `Auto mode stopped at ${time}: ${cause}`;

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
    // The Dialog first; its Confirm writes mode auto once through the setting save path.
    expect(await turnAutoOn(section)).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });

  it("Cancel and Escape on Turn auto back on's Dialog write nothing", async () => {
    view = settingsView("manual", stop("red_main"));
    const section = await modeSection();
    const button = await within(section).findByRole("button", { name: "Turn auto back on" });
    fireEvent.click(button);
    fireEvent.click(within(modeDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.keyDown(modeDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(posts).toEqual([]);
  });

  it("its alarm's Needs-you row is the alarm's own target: one local-time sentence, no second line, and a menu of Turn auto back on then What failed", async () => {
    view = settingsView("manual", stop("red_main"));
    mount(checks([{ ...alarm(stop("red_main")), text: FULL }]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    expect(line.id).toBe("alarm-al_1");
    // The cause is said once: no stop line repeats it, and the row has no link, no inline button and no Failures control.
    expect(line.textContent!.split("tests failed on main")).toHaveLength(2);
    expect(line.textContent).not.toContain("Back to manual");
    expect(line.querySelector("[data-auto-stop]")).toBeNull();
    expect(within(line).queryByRole("link")).toBeNull();
    expect(line.textContent).not.toMatch(/See the alarm|Open on Failures|Failures/);
    expect(within(line).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["More commands"]);
    expect(line.querySelector("summary")!.textContent).toBe("Details");
    await vi.waitFor(() => expect(menuOf(line)).toEqual([["Turn auto back on", "auto_on"], ["What failed", "what_failed"]]));
  });

  it("Details is closed at first and shows the server's full text once opened", async () => {
    view = settingsView("manual", stop("red_main"));
    mount(checks([{ ...alarm(stop("red_main")), text: FULL }]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    const toggle = line.querySelector<HTMLElement>("[data-alarm-details] summary")!;
    expect(toggle.textContent).toBe("Details");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(line.textContent).not.toContain(FULL);
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(line).getByText(FULL)).not.toBeNull();
  });

  it("Turn auto back on in the row's menu opens the same Dialog; Confirm writes mode auto through the same settings write as the Settings note", async () => {
    view = settingsView("manual", stop("red_main"));
    mount(checks([alarm(stop("red_main"))]));
    const line = (await screen.findByText(sentence("tests failed on main after a merge"))).closest("li")!;
    fireEvent.click(within(line).getByRole("button", { name: "More commands" }));
    const item = within(line).getByRole("menuitem", { name: "Turn auto back on" });
    await vi.waitFor(() => expect(item.hasAttribute("disabled")).toBe(false));
    await act(async () => fireEvent.click(item));
    expect(await confirmAuto()).toEqual({ action: "set", key: "mode", value: '"auto"' });
  });
});

describe("auto stop: budget checkpoint", () => {
  it("the Mode toggle and the alarm's Needs-you row both show the checkpoint and the time", async () => {
    view = settingsView("manual", stop("budget_checkpoint"));
    const section = await modeSection();
    expect(await within(section).findByText(`Back to manual at ${time}: an item reached its budget checkpoint`)).not.toBeNull();
    cleanup();
    mount(checks([alarm(stop("budget_checkpoint"))]));
    const line = (await screen.findByText(sentence("an item reached its budget checkpoint"))).closest("li")!;
    expect(within(line).queryByRole("link")).toBeNull();
    expect(menuOf(line).map(([label]) => label)).toEqual(["Turn auto back on", "What failed"]);
    expect(document.querySelectorAll("li[data-check]")).toHaveLength(1);
  });
});

describe("auto stop: a burst of agent-run failures", () => {
  it("leaves the mode auto with no stop line; its repeated-error alarm's row shows the server's sentence and Show failures", async () => {
    view = settingsView("auto", null);
    const section = await modeSection();
    expect(section.textContent).toContain("auto");
    expect(section.querySelector("[data-auto-stop]")).toBeNull();
    expect(within(section).queryByRole("button", { name: "Turn auto back on" })).toBeNull();
    cleanup();
    mount(checks([{ ...alarm(), pattern: "repeated_error", error_code: "checks_failed" }]));
    const line = document.querySelector<HTMLElement>("li[data-check='alarm']")!;
    expect(line.querySelector("[data-alarm-summary]")!.textContent).toBe("Alarm: something");
    expect(menuOf(line)).toEqual([["Show failures", "show_failures"]]);
    expect(line.querySelector("details")).toBeNull();
  });
});

describe("the Settings Mode switch asks first", () => {
  it("flipping it opens the Dialog and sends nothing; Escape and Cancel write nothing; Confirm writes the mode once", async () => {
    view = settingsView("manual", null);
    const section = await modeSection();
    const toggle = await within(section).findByRole("switch", { name: "Auto mode" });
    fireEvent.click(toggle);
    fireEvent.keyDown(modeDialog(), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(within(modeDialog()).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    // The switch still shows the stored mode: nothing changed.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(await confirmAuto()).toEqual({ action: "set", key: "mode", value: '"auto"' });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("from auto it asks to switch to manual, and Confirm writes manual", async () => {
    view = settingsView("auto", null);
    const section = await modeSection();
    fireEvent.click(await within(section).findByRole("switch", { name: "Auto mode" }));
    const dialog = screen.getByRole("dialog", { name: "Switch to manual mode?" });
    expect(posts).toHaveLength(0);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Switch to manual" })));
    expect(posts.map((p) => JSON.parse(String(p.init.body)))).toEqual([{ action: "set", key: "mode", value: '"manual"' }]);
  });
});

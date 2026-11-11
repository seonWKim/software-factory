// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
// The dashboard Settings page's Notices section (design 09-notifications), the owner's side of the shell's notices:
// a switch per kind that writes notice_kinds and a quiet-hours field that writes quiet_hours, each through
// POST /api/v1/settings, a refusal shown next to the field it came from. It sits with the desktop tests because
// this change may touch only tests/desktop/ (tests/ui-settings-page.test.tsx holds the rest of the page).
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingRow, SettingsView } from "../../web/src/api.js";

// Built with createElement and loaded by a specifier the node typecheck skips, as tests/ui-settings-page.test.tsx.
const PAGE_MODULE = "../../web/src/views/settings.js";
const { SettingsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SettingsPage: FunctionComponent };

const TOKEN = "tok_n";
const row = (key: string, value: string): SettingRow => ({
  key, description: `about ${key}`, kind: "number", value, source: "default", file_value: null, default_value: value,
  applies_at: "the next notifications pass (each poll)", project_settable: false, projects: [],
});
let kinds = '["spec","merge","failure"]';
const view = (): SettingsView => ({
  as_of: "2026-11-12T00:00:00.000Z", csrf_token: TOKEN, repo: "o/r", project: null, project_keys: [],
  keys: [row("notice_kinds", kinds), row("quiet_hours", '"22:00-07:00"')], pr_only: [], ignored: [], history: [],
});

let posts: { action: string; key: string; value: string }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, lines: ["saved"] } };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posts = [];
  kinds = '["spec","merge","failure"]';
  answer = { status: 200, body: { ok: true, lines: ["saved"] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(url).toBe("/api/v1/settings");
      expect(new Headers(init.headers).get("x-csrf-token")).toBe(TOKEN);
      posts.push(JSON.parse(String(init.body)));
      return json(answer.body, answer.status);
    }
    if (url === "/api/v1/settings") return json(view());
    return json({}, 404);
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function notices() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(SettingsPage)));
  return screen.findByRole("region", { name: "Notices" });
}

describe("Settings page: Notices", () => {
  it("has a switch per kind showing notice_kinds, and a quiet-hours field showing quiet_hours", async () => {
    const s = await notices();
    const switches = within(s).getAllByRole("switch");
    expect(switches.map((x) => x.getAttribute("aria-label"))).toEqual(["Notice: spec", "Notice: merge", "Notice: failure", "Notice: other"]);
    expect(switches.map((x) => x.getAttribute("aria-checked"))).toEqual(["true", "true", "true", "false"]);
    expect((within(s).getByLabelText("Quiet hours") as HTMLInputElement).value).toBe("22:00-07:00");
  });

  it("a switch writes the whole notice_kinds list through POST /api/v1/settings", async () => {
    const s = await notices();
    fireEvent.click(within(s).getByRole("switch", { name: "Notice: other" }));
    await waitFor(() => expect(posts).toEqual([{ action: "set", key: "notice_kinds", value: '["spec","merge","failure","other"]' }]));
    fireEvent.click(within(s).getByRole("switch", { name: "Notice: merge" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: "set", key: "notice_kinds", value: '["spec","failure"]' }));
  });

  it("the quiet-hours field writes quiet_hours as a JSON string, and empty turns it off", async () => {
    const s = await notices();
    const field = within(s).getByLabelText("Quiet hours");
    fireEvent.change(field, { target: { value: " 23:00-06:30 " } });
    fireEvent.click(within(s).getByRole("button", { name: "Save Quiet hours" }));
    await waitFor(() => expect(posts).toEqual([{ action: "set", key: "quiet_hours", value: '"23:00-06:30"' }]));
    fireEvent.change(field, { target: { value: "" } });
    fireEvent.click(within(s).getByRole("button", { name: "Save Quiet hours" }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ action: "set", key: "quiet_hours", value: '""' }));
  });

  it("a refusal shows next to the field that caused it, not the other", async () => {
    answer = { status: 400, body: { ok: false, error: 'quiet_hours must be "HH:MM-HH:MM" (24-hour, local time), or "" for off' } };
    const s = await notices();
    fireEvent.change(within(s).getByLabelText("Quiet hours"), { target: { value: "late" } });
    fireEvent.click(within(s).getByRole("button", { name: "Save Quiet hours" }));
    const alert = await within(s).findByRole("alert");
    expect(alert.textContent).toContain("quiet_hours must be");
    expect(alert.parentElement!.contains(within(s).getByLabelText("Quiet hours"))).toBe(true);
    expect(alert.parentElement!.contains(within(s).getByRole("switch", { name: "Notice: spec" }))).toBe(false);

    answer = { status: 400, body: { ok: false, error: "notice_kinds must be a list of distinct kinds" } };
    fireEvent.click(within(s).getByRole("switch", { name: "Notice: spec" }));
    await waitFor(() => expect(within(s).getAllByRole("alert")).toHaveLength(2));
    const kindsAlert = within(s).getAllByRole("alert").find((a) => a.textContent?.includes("notice_kinds"))!;
    expect(kindsAlert.parentElement!.contains(within(s).getByRole("switch", { name: "Notice: spec" }))).toBe(true);
    expect(kindsAlert.parentElement!.contains(within(s).getByLabelText("Quiet hours"))).toBe(false);
  });

  it("the settable-keys table points the two keys to the Notices section instead of a field", async () => {
    await notices();
    const table = await screen.findByRole("table", { name: "Settable keys" });
    for (const key of ["notice_kinds", "quiet_hours"]) {
      const tr = table.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;
      expect(tr.textContent).toContain("edit under Notices");
      expect(within(tr).queryByLabelText(key)).toBeNull();
    }
  });
});

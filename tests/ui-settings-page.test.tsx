// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingRow, SettingsView } from "../web/src/api.js";
import { SettingsPage } from "../web/src/views/settings.js";

// The Settings page (issue #236, design §8 and §9): a row per settable key with value, source and "applies at",
// the PR-only keys read-only, the audit history, and writes as POST /api/v1/settings with the CSRF token, a
// refusal shown next to its field.

const AT = "2026-11-07T00:00:00.000Z";
const TOKEN = "tok_abc";
const row = (key: string, extra: Partial<SettingRow> = {}): SettingRow => ({
  key, kind: "number", value: "3", source: "file", file_value: "3", default_value: "3", applies_at: "the controller's next decision",
  project_settable: false, projects: [], ...extra,
});
const view: SettingsView = {
  as_of: AT,
  csrf_token: TOKEN,
  repo: "o/r",
  project: "github.com/o/r",
  project_keys: ["max_attempts", "max_diff_lines", "max_diff_files"],
  keys: [
    row("max_attempts", { project_settable: true, projects: [{ project: "github.com/o/r", value: "2", source: "override" }] }),
    row("max_loops", { value: "4", source: "override" }),
    row("tick_ms", { value: "2000", source: "default", file_value: null, default_value: "2000", applies_at: "the next tick" }),
    row("workers", { value: "5", max: 8, capped_at: null, applies_at: "the worker pool's next tick" }),
    row("models", { kind: "models", value: '{"cheap":"haiku","standard":"sonnet","strong":"opus"}', source: "default", file_value: null, applies_at: "the next run that starts" }),
    row("model_by", { kind: "model_by", value: '{"retry_up":true}', applies_at: "the next run that starts" }),
    row("phases_auto_approve", { kind: "boolean", value: "false", source: "default", file_value: null, applies_at: "the next phase spec triage writes" }),
  ],
  pr_only: [{ key: "plugins", note: "changes by PR only" }, { key: "secrets", note: "changes by PR only" }],
  ignored: [],
  history: [
    { seq: 2, at: AT, actor: "local:owner", key: "max_loops", project: null, old_value: null, new_value: "4" },
    { seq: 1, at: AT, actor: "local:owner", key: "max_attempts", project: "github.com/o/r", old_value: "3", new_value: null },
  ],
};

let posts: { url: string; init: RequestInit }[] = [];
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, lines: ["saved"] } };

beforeEach(() => {
  posts = [];
  answer = { status: 200, body: { ok: true, lines: ["max_loops = 5 (override; was 4, override)"] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/v1/settings") return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SettingsPage />
    </QueryClientProvider>,
  );
  return screen.findByRole("table", { name: "Settable keys" });
}

const rowOf = (table: HTMLElement, key: string) => table.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;

describe("Settings page", () => {
  it("shows a row per settable key with its value, source and applies-at", async () => {
    const table = await show();
    expect([...table.querySelectorAll("tbody > tr")].map((r) => r.getAttribute("data-key"))).toEqual(view.keys.map((k) => k.key));
    const loops = rowOf(table, "max_loops");
    expect((within(loops).getByLabelText("max_loops") as HTMLInputElement).value).toBe("4");
    expect(loops.textContent).toContain("override");
    expect(loops.textContent).toContain("the controller's next decision");
    const tick = rowOf(table, "tick_ms");
    expect(tick.textContent).toContain("default");
    expect(tick.textContent).toContain("not set (default 2000)");
    expect(tick.textContent).toContain("the next tick");
    // Reset only where an override exists.
    expect(within(loops).queryByRole("button", { name: "Reset max_loops" })).not.toBeNull();
    expect(within(tick).queryByRole("button", { name: /^Reset/ })).toBeNull();
    // workers names its max_workers limit; models has a text field per tier; model_by a JSON field; a switch for the boolean.
    expect(rowOf(table, "workers").textContent).toContain("1 to 8 (max_workers)");
    for (const t of ["cheap", "standard", "strong"]) expect(within(rowOf(table, "models")).getByLabelText(`models ${t}`)).not.toBeNull();
    expect((within(rowOf(table, "models")).getByLabelText("models strong") as HTMLInputElement).value).toBe("opus");
    expect(within(rowOf(table, "model_by")).getByLabelText("model_by").tagName).toBe("TEXTAREA");
    const sw = within(rowOf(table, "phases_auto_approve")).getByRole("switch", { name: "phases_auto_approve" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // The project value of a per-project key, with its own reset.
    const att = rowOf(table, "max_attempts");
    expect(att.textContent).toContain("for github.com/o/r: 2 (override)");
    expect(within(att).getByRole("button", { name: "Reset max_attempts for o/r" })).not.toBeNull();
  });

  it("lists the PR-only keys read-only, with no control", async () => {
    await show();
    const pr = screen.getByRole("table", { name: "Changes by PR only" });
    for (const key of ["plugins", "secrets"]) {
      const r = pr.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;
      expect(r.textContent).toContain("changes by PR only");
      expect(r.querySelectorAll("input, button, textarea, [role=switch]")).toHaveLength(0);
    }
  });

  it("lists the audit history", async () => {
    await show();
    const h = screen.getByRole("table", { name: "History" });
    const rows = h.querySelectorAll("tbody > tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("local:owner");
    expect(rows[0]!.textContent).toContain("(no override) → 4");
    expect(rows[1]!.textContent).toContain("max_attempts for github.com/o/r");
    expect(rows[1]!.textContent).toContain("reset (was 3)");
  });

  it("saves with POST /api/v1/settings, the CSRF token and JSON", async () => {
    const table = await show();
    const loops = rowOf(table, "max_loops");
    fireEvent.change(within(loops).getByLabelText("max_loops"), { target: { value: "5" } });
    await act(async () => fireEvent.click(within(loops).getByRole("button", { name: "Save max_loops" })));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/settings");
    const headers = posts[0]!.init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe(TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ action: "set", key: "max_loops", value: "5" });
    expect(within(loops).getByRole("status").textContent).toContain("max_loops = 5");

    await act(async () => fireEvent.click(within(rowOf(table, "phases_auto_approve")).getByRole("switch")));
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ action: "set", key: "phases_auto_approve", value: "true" });

    const models = rowOf(table, "models");
    fireEvent.change(within(models).getByLabelText("models cheap"), { target: { value: "small" } });
    await act(async () => fireEvent.click(within(models).getByRole("button", { name: "Save models" })));
    expect(JSON.parse(JSON.parse(posts[2]!.init.body as string).value)).toEqual({ cheap: "small", standard: "sonnet", strong: "opus" });

    const att = rowOf(table, "max_attempts");
    fireEvent.change(within(att).getByLabelText("max_attempts for o/r"), { target: { value: "1" } });
    await act(async () => fireEvent.click(within(att).getByRole("button", { name: "Save max_attempts for o/r" })));
    expect(JSON.parse(posts[3]!.init.body as string)).toEqual({ action: "set", key: "max_attempts", value: "1", project: "o/r" });

    await act(async () => fireEvent.click(within(loops).getByRole("button", { name: "Reset max_loops" })));
    expect(JSON.parse(posts[4]!.init.body as string)).toEqual({ action: "reset", key: "max_loops" });
  });

  it("shows a refusal next to the field it came from", async () => {
    const table = await show();
    answer = { status: 422, body: { error: "refused: workers 9 is above the config file's max_workers (8)" } };
    const workers = rowOf(table, "workers");
    fireEvent.change(within(workers).getByLabelText("workers"), { target: { value: "9" } });
    await act(async () => fireEvent.click(within(workers).getByRole("button", { name: "Save workers" })));
    expect(within(workers).getByRole("alert").textContent).toBe("refused: workers 9 is above the config file's max_workers (8)");
    expect(within(rowOf(table, "max_loops")).queryByRole("alert")).toBeNull();
  });
});

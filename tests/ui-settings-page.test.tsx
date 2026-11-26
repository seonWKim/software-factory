// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingRow, SettingsView } from "../web/src/api.js";
import { PR_ONLY_KEYS, SETTABLE_KEYS } from "../src/core/settings.js";
import { ADVANCED_GROUPS, GROUP_KEYS, appliesKey } from "../web/src/views/settings/advanced-groups.js";
import { modelSummary } from "../web/src/views/settings/values.js";
import { type MessageKey, en } from "../web/src/i18n/en.js";
import { keyHelp, keyLabel } from "../web/src/lib/key-label.js";

// tsconfig.test.json checks this file without JSX (only tests/ui-shell.test.tsx is checked with web/tsconfig.json),
// so the page is built with createElement and its .tsx module is loaded by a specifier the node check skips.
const PAGE_MODULE = "../web/src/views/settings.js";
const { SettingsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SettingsPage: FunctionComponent };

// The Settings page (issue #236, design §8 and §9): a row per settable key with value, source and "applies at",
// the PR-only keys read-only, the audit history, and writes as POST /api/v1/settings with the CSRF token, a
// refusal shown next to its field.

const AT = "2026-11-07T00:00:00.000Z";
const TOKEN = "tok_abc";
// Descriptions that exist only in this fixture: the page must show the API's text, not its own.
const DESC = (key: string) => `fixture-only description of ${key}`;
const MODEL_BY = '{"triage":"cheap","implement":{"1":"standard","4":"strong"},"review":"standard","retry_up":true}';
const row = (key: string, extra: Partial<SettingRow> = {}): SettingRow => ({
  key, description: DESC(key), kind: "number", value: "3", source: "file", file_value: "3", default_value: "3", applies_at: "the controller's next decision",
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
    row("model_by", { kind: "json", value: MODEL_BY, file_value: MODEL_BY, default_value: MODEL_BY, applies_at: "the next run that starts" }),
    row("hold_policy", { kind: "json", value: '{"mode":"hold"}', source: "override", file_value: null, default_value: '{"mode":"run_after_minutes","minutes":120}', applies_at: "the next claim" }),
    row("message_style", { kind: "text", value: '"Short."', file_value: '"Short."', default_value: '""' }),
    row("phases_auto_approve", { kind: "boolean", value: "false", source: "default", file_value: null, applies_at: "the next phase spec triage writes" }),
    row("auto_grant_test_paths", { kind: "boolean", value: "true", default_value: "true", file_value: null, source: "default" }),
    row("test_globs", { kind: "list", value: '["tests/**","**/*.test.*"]', default_value: '["tests/**"]', file_value: null, source: "default" }),
    row("intake_label", { kind: "text", value: '"factory"', file_value: '"factory"', default_value: "null" }),
    row("retry_max_ms", { value: "1800000", file_value: "1800000", default_value: "1800000", applies_at: "the next retry" }),
    row("run_timeout_ms", { value: "5400000", source: "override", file_value: "3600000", default_value: "3600000", applies_at: "the next run that starts" }),
  ],
  pr_only: [
    { key: "plugins", description: DESC("plugins") },
    { key: "secrets", description: DESC("secrets") },
    { key: "deny_paths", description: DESC("deny_paths") },
    { key: "auth", description: DESC("auth") },
  ],
  file_keys: {
    editable: [
      { key: "plugins", value: '{"secrets":"env-file","runner":"claude-code","source":["local","slack"]}' },
      { key: "models", value: '{"cheap":"haiku","standard":"sonnet","strong":"opus"}' },
      { key: "model_by", value: '{"triage":"cheap","implement":{"1":"standard"},"retry_up":true}' },
      { key: "slack", value: '{"channels":["C1"]}' },
      { key: "repo.install_command", value: '["npm","ci"]' },
      { key: "repo.test_command", value: '["sh","-c","npm test"]' },
      { key: "repo.check_commands", value: '[["npm","run","typecheck"],["npm","test"]]' },
      { key: "repo.path", value: '"."' },
      { key: "toolchain", value: '{"env":{"CI":"1"},"warm_command":["npm","ci"]}' },
      { key: "dials", value: '{"spec_gate_min_tier":1,"auto_merge_max_tier":0}' },
      { key: "floors", value: '[{"prefix":"prompts/","tier":3}]' },
      { key: "permissions", value: '{"grants":["static"],"static":{"roles":{}}}' },
      { key: "hotspot_paths", value: '["src/core/"]' },
      { key: "mechanical_paths", value: null },
      { key: "path_companions", value: '[{"when":"docs/design.md","also":["docs/design/"]}]' },
    ],
    read_only: [
      { key: "store", value: '{"type":"sqlite"}' }, { key: "env", value: '"local"' }, { key: "state_dir", value: '".factory"' }, { key: "worktrees_dir", value: '".worktrees"' },
      { key: "ui", value: '{"port":4310}' }, { key: "outbound.batching", value: null }, { key: "cli_user", value: '"local:owner"' },
    ],
    plugins: [
      { kind: "secrets", interface: "SecretStore", guard: true, names: ["env-file", "keychain"], selected: "env-file" },
      { kind: "runner", interface: "AgentRunner", guard: false, names: ["claude-code", "fake"], selected: "claude-code" },
      { kind: "source", interface: "SourceAdapter", guard: false, names: ["local", "slack", "github-issues"], selected: "local" },
      { kind: "capability", interface: "CapabilitySearch", guard: false, names: ["bm25", "none"], selected: "bm25" },
    ],
  },
  ignored: [],
  history: [
    { seq: 2, at: AT, actor: "local:owner", key: "max_loops", project: null, old_value: null, new_value: "4" },
    { seq: 1, at: AT, actor: "local:owner", key: "max_attempts", project: "github.com/o/r", old_value: "3", new_value: null },
  ],
};

let posts: { url: string; init: RequestInit }[] = [];
const ON = { as_of: "2026-11-08T00:00:00Z", csrf_token: "t", commands_enabled: true, actor: "local:me@example.com", actor_source: "environment" };
let session: Record<string, unknown> = ON;
let answer: { status: number; body: unknown } = { status: 200, body: { ok: true, lines: ["saved"] } };

beforeEach(() => {
  posts = [];
  session = ON;
  answer = { status: 200, body: { ok: true, lines: ["max_loops = 5 (override; was 4, override)"] } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
    }
    if (url === "/api/v1/settings") return new Response(JSON.stringify(view), { status: 200, headers: { "content-type": "application/json" } });
    if (url.startsWith("/api/v1/items/")) return new Response(JSON.stringify({ item: { merge: { enabled: true, reason: null } } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/calendar") return new Response(JSON.stringify({ plugins: [{ name: "google-calendar", connected: false, default_client: true, synced_at: null, error: null, attempt: null }] }), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/session") return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
});

let afterEachReset: () => void = () => undefined;
afterEach(() => {
  afterEachReset();
  afterEachReset = () => undefined;
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

/** The page open on a tab (the `tab` query parameter, as a reload or a link would have it). */
async function show(tab: string | null = "advanced") {
  // null: leave the URL as it is, as a reload does.
  if (tab !== null) history.replaceState(null, "", tab === "" ? "/app/settings" : `/app/settings?tab=${tab}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(SettingsPage)));
  return tab === "advanced" || tab === null ? screen.findByRole("table", { name: "Settable keys" }) : screen.findByRole("tablist");
}

const PR_ONLY = "Change only through a reviewed PR";
/** Opens a Select, reads its options (each option's `value` is its choice), and closes it with Esc. */
const optionsOf = (select: HTMLElement) => {
  fireEvent.click(select);
  const options = within(screen.getByRole("listbox")).getAllByRole<HTMLButtonElement>("option");
  fireEvent.keyDown(select, { key: "Escape" });
  return options;
};
/** Opens a Select and picks the option whose value is `value`. */
const pick = (select: HTMLElement, value: string) => {
  fireEvent.click(select);
  fireEvent.click(within(screen.getByRole("listbox")).getAllByRole<HTMLButtonElement>("option").find((o) => o.value === value)!);
};
// A key's row, whichever group holds it: For developers is a table of its own, beside the one `table` names.
const rowOf = (table: HTMLElement, key: string) => table.ownerDocument.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;
const selectedTab = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")!.textContent;
/** The names of the page's top-level sections, in page order. */
const regions = () => [...document.querySelectorAll<HTMLElement>("section[aria-label]")].map((e) => e.getAttribute("aria-label")!);
/** A key row's File value, shown behind its Details. */
const fileValue = (row: HTMLElement) => row.querySelectorAll("details[data-details] dd")[2]!;

describe("Settings page", () => {
  it("has a Commands from the page section (#page-commands): who commands act as, and and no how-to-act sentence", async () => {
    await show();
    const section = await screen.findByRole("region", { name: "Commands from the page" });
    expect(section.closest("#page-commands")).not.toBeNull();
    await waitFor(() => expect(section.textContent).toContain("Commands act as local:me@example.com (from environment)"));
    expect(section.textContent).not.toContain("ui.user_id");
    expect(section.textContent).not.toContain("another user");
  });

  it("says commands are off when the session has no actor", async () => {
    session = { ...session, commands_enabled: false, actor: null, actor_source: null };
    await show();
    const section = await screen.findByRole("region", { name: "Commands from the page" });
    await waitFor(() => expect(section.textContent).toContain("Item commands are off"));
  });

  it("shows a row per settable key with its value, source and applies-at", async () => {
    const table = await show();
    const rowKeys = [...table.querySelectorAll("tr[data-key]"), ...document.querySelectorAll("details[data-group] tr[data-key]")].map((r) => r.getAttribute("data-key"));
    expect([...rowKeys].sort()).toEqual(view.keys.map((k) => k.key).sort());
    const loops = rowOf(table, "max_loops");
    expect((within(loops).getByLabelText(`${keyLabel("max_loops")}`) as HTMLInputElement).value).toBe("4");
    expect(loops.textContent).toContain("override");
    expect(loops.textContent).toContain("within a minute");
    const tick = rowOf(table, "tick_ms");
    expect(tick.textContent).toContain("default");
    expect(tick.textContent).toContain("default: 2s");
    expect(tick.textContent).toContain("within a minute");
    // A long unbroken value may break anywhere, so the table fits its card at 1280 px and Reset keeps its 12 px.
    expect(within(tick).getByText("2s", { selector: "span" }).className.split(" ")).toContain("wrap-anywhere");
    // Reset only where an override exists.
    expect(within(loops).queryByRole("button", { name: `Reset ${keyLabel("max_loops")}` })).not.toBeNull();
    expect(within(tick).queryByRole("button", { name: /^Reset/ })).toBeNull();
    // workers names its max_workers limit; models has a text field per tier; model_by a JSON field; a switch for the boolean.
    expect(rowOf(table, "workers").textContent).toContain("1 to 8 (max_workers)");
    for (const t of ["cheap", "standard", "strong"]) expect(within(rowOf(table, "models")).getByLabelText(`${keyLabel("models")} ${t}`)).not.toBeNull();
    expect((within(rowOf(table, "models")).getByLabelText(`${keyLabel("models")} strong`) as HTMLInputElement).value).toBe("opus");
    expect(within(rowOf(table, "model_by")).getByLabelText(`${keyLabel("model_by")}`).tagName).toBe("TEXTAREA");
    const grant = within(rowOf(table, "auto_grant_test_paths")).getByRole("switch", { name: `${keyLabel("auto_grant_test_paths")}` });
    expect(grant.getAttribute("aria-checked")).toBe("true");
    const globs = rowOf(table, "test_globs");
    expect(within(globs).getByLabelText(`${keyLabel("test_globs")} 2`)).not.toBeNull();
    expect(globs.querySelectorAll("[data-list-item]").length).toBeGreaterThan(0);
    expect(within(globs).getByRole("button", { name: `Add to ${keyLabel("test_globs")}` })).not.toBeNull();
    expect(within(globs).getByRole("button", { name: `Remove ${keyLabel("test_globs")} 1` })).not.toBeNull();
    const label = within(rowOf(table, "intake_label")).getByLabelText(`${keyLabel("intake_label")}`) as HTMLInputElement;
    expect(label.tagName).toBe("INPUT");
    expect(label.type).toBe("text");
    expect(label.value).toBe("factory");
    expect(table.querySelectorAll('input[type="number"]').length).toBeGreaterThan(0);
    for (const k of ["auto_grant_test_paths", "test_globs", "intake_label"]) expect(rowOf(table, k).querySelector('input[type="number"]'), k).toBeNull();
    const sw = within(rowOf(table, "phases_auto_approve")).getByRole("switch", { name: `${keyLabel("phases_auto_approve")}` });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    // The project value of a per-project key, with its own reset.
    const att = rowOf(table, "max_attempts");
    expect(att.textContent).toContain("This project: 2 (override)");
    expect(within(att).getByRole("button", { name: `Reset ${keyLabel("max_attempts")} for o/r` })).not.toBeNull();
  });

  it("logs no console error or warning on render with a boolean and a list value (no 'cannot be parsed')", async () => {
    const error = vi.spyOn(console, "error");
    const warn = vi.spyOn(console, "warn");
    try {
      const table = await show();
      await waitFor(() => expect(within(rowOf(table, "auto_grant_test_paths")).getByRole("switch")).not.toBeNull());
      expect(rowOf(table, "test_globs").querySelectorAll("[data-list-item]").length).toBeGreaterThan(0);
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("the models form is a two-column grid (tier | 7rem field, 8 px by 12 px) with Save in its own button row 12 px below", async () => {
    const table = await show();
    const models = rowOf(table, "models");
    const grid = models.querySelector<HTMLElement>("[data-tiers]")!;
    expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid", "grid-cols-[max-content_7rem]", "gap-x-2", "gap-y-3"]));
    // Each tier is a label cell then its field cell, so the three fields share one column and start at one x.
    expect([...grid.children].map((c) => c.tagName)).toEqual(["LABEL", "INPUT", "LABEL", "INPUT", "LABEL", "INPUT"]);
    for (const t of ["cheap", "standard", "strong"]) expect(within(grid).getByLabelText(`${keyLabel("models")} ${t}`).className).toContain("w-full");
    const save = within(models).getByRole("button", { name: `Save ${keyLabel("models")}` });
    expect(grid.contains(save)).toBe(false);
    const row = save.parentElement!;
    expect(row.previousElementSibling).toBe(grid);
    expect(row.className.split(" ")).toEqual(expect.arrayContaining(["flex", "gap-2"]));
    expect(row.parentElement!.className.split(" ")).toContain("space-y-3");
  });

  it("lists the remaining PR-only keys read-only, with no control, and says the editable keys change through a local branch", async () => {
    await show();
    const section = screen.getByRole("region", { name: PR_ONLY });
    expect(section.textContent).toContain("The remaining keys change only through a reviewed pull request to factory.config.json");
    expect(section.textContent).toContain("change through a local branch you merge");
    const pr = screen.getByRole("table", { name: PR_ONLY });
    // deny_paths is built at load, never a file key: it stays here with its description, as auth does.
    for (const key of ["deny_paths", "auth"]) {
      const r = pr.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;
      expect(r.textContent).toContain(DESC(key));
      expect(r.querySelectorAll("input, button, textarea, select, [role=switch]")).toHaveLength(0);
    }
    // The keys the typed form edits (plugins and the guard secrets) leave the table.
    for (const key of ["plugins", "secrets"]) expect(pr.querySelector(`tr[data-key="${key}"]`), key).toBeNull();
  });

  it("shows each key's description from the catalog under its label; PR-only rows keep the API's text", async () => {
    const table = await show();
    for (const k of view.keys) {
      const cell = rowOf(table, k.key).querySelector("td")!;
      expect(cell.textContent).toContain(keyLabel(k.key));
      expect(cell.textContent).toContain(en[`key.${k.key}.help` as MessageKey]);
    }
    const pr = screen.getByRole("table", { name: PR_ONLY });
    for (const key of ["deny_paths", "auth"]) {
      const cell = pr.querySelector<HTMLElement>(`tr[data-key="${key}"] td`)!;
      expect(cell.textContent).toContain(DESC(key));
    }
    // Always in the page, not behind a hover or a breakpoint.
    const p = screen.getByText(keyHelp("max_loops", ""));
    expect(p.className).not.toMatch(/(^|\s)(hidden|sr-only|group-hover:|sm:|md:|lg:)/);
  });

  it("shows every millisecond key's value as a duration with its unit, and still its description", async () => {
    const table = await show();
    const duration = (key: string) => rowOf(table, key).querySelector("[data-duration]")?.textContent ?? null;
    expect(duration("run_timeout_ms")).toBe("1h 30m");
    expect(duration("retry_max_ms")).toBe("30m");
    expect(duration("tick_ms")).toBe("2s");
    for (const k of view.keys.filter((r) => r.key.endsWith("_ms"))) {
      expect(duration(k.key), k.key).not.toBeNull();
      expect(rowOf(table, k.key).querySelector("td")!.textContent).toContain(keyHelp(k.key, ""));
    }
    // Keys that are not milliseconds show no duration.
    for (const key of ["max_loops", "workers", "phases_auto_approve"]) expect(duration(key), key).toBeNull();
  });

  it("lists the audit history", async () => {
    await show();
    const h = screen.getByRole("table", { name: "History" });
    const rows = h.querySelectorAll("tbody > tr");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("local:owner");
    expect(rows[0]!.textContent).toContain("(no override) → 4");
    expect(rows[1]!.textContent).toContain(`${keyLabel("max_attempts")} for github.com/o/r`);
    expect(rows[1]!.textContent).toContain("reset (was 3)");
  });

  it("saves with POST /api/v1/settings, the CSRF token and JSON", async () => {
    const table = await show();
    const loops = rowOf(table, "max_loops");
    fireEvent.change(within(loops).getByLabelText(`${keyLabel("max_loops")}`), { target: { value: "5" } });
    await act(async () => fireEvent.click(within(loops).getByRole("button", { name: `Save ${keyLabel("max_loops")}` })));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/settings");
    const headers = posts[0]!.init.headers as Record<string, string>;
    expect(headers["x-csrf-token"]).toBe(TOKEN);
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ action: "set", key: "max_loops", value: "5" });
    expect(within(loops).getByRole("status").textContent).toBe("Review rounds saved: 5");

    await act(async () => fireEvent.click(within(rowOf(table, "phases_auto_approve")).getByRole("switch")));
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ action: "set", key: "phases_auto_approve", value: "true" });

    const models = rowOf(table, "models");
    fireEvent.change(within(models).getByLabelText(`${keyLabel("models")} cheap`), { target: { value: "small" } });
    await act(async () => fireEvent.click(within(models).getByRole("button", { name: `Save ${keyLabel("models")}` })));
    expect(JSON.parse(JSON.parse(posts[2]!.init.body as string).value)).toEqual({ cheap: "small", standard: "sonnet", strong: "opus" });

    const att = rowOf(table, "max_attempts");
    fireEvent.change(within(att).getByLabelText(`${keyLabel("max_attempts")} for o/r`), { target: { value: "1" } });
    await act(async () => fireEvent.click(within(att).getByRole("button", { name: `Save ${keyLabel("max_attempts")} for o/r` })));
    expect(JSON.parse(posts[3]!.init.body as string)).toEqual({ action: "set", key: "max_attempts", value: "1", project: "o/r" });

    await act(async () => fireEvent.click(within(loops).getByRole("button", { name: `Reset ${keyLabel("max_loops")}` })));
    expect(JSON.parse(posts[4]!.init.body as string)).toEqual({ action: "reset", key: "max_loops" });
  });

  it("confirms a reset in a status region that outlives the Reset button, global and per project", async () => {
    const table = await show();
    const keys = view.keys;
    const saved = keys.map((k) => ({ ...k }));
    afterEachReset = () => keys.forEach((k, i) => Object.assign(k, saved[i]));
    // A successful POST turns the row's source into default, as the server does.
    const original = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const r = await original(url, init);
      if (init?.method === "POST") {
        const body = JSON.parse(init.body as string) as { key: string; project?: string };
        const k = keys.find((x) => x.key === body.key)!;
        if (body.project === undefined) k.source = "default";
        else k.projects = k.projects.map((p) => ({ ...p, source: "file" as const }));
      }
      return r;
    }));
    for (const [key, name] of [["max_loops", keyLabel("max_loops")], ["max_attempts", `${keyLabel("max_attempts")} for o/r`]] as const) {
      const row = rowOf(table, key);
      await act(async () => fireEvent.click(within(row).getByRole("button", { name: `Reset ${name}` })));
      await waitFor(() => expect(within(rowOf(table, key)).queryByRole("button", { name: `Reset ${name}` })).toBeNull());
      const text = within(rowOf(table, key)).getByRole("status").textContent!;
      expect(text).toBe(`${keyLabel(key)} back to the default.`);
      expect(text).not.toMatch(/[a-z]+_[a-z]+/);
    }
  });

  it("shows a refusal next to the field it came from", async () => {
    const table = await show();
    answer = { status: 422, body: { error: "refused: workers 9 is above the config file's max_workers (8)" } };
    const workers = rowOf(table, "workers");
    fireEvent.change(within(workers).getByLabelText(`${keyLabel("workers")}`), { target: { value: "9" } });
    await act(async () => fireEvent.click(within(workers).getByRole("button", { name: `Save ${keyLabel("workers")}` })));
    expect(within(workers).getByRole("alert").textContent).toBe("refused: workers 9 is above the config file's max_workers (8)");
    expect(within(rowOf(table, "max_loops")).queryByRole("alert")).toBeNull();
  });

  it("shows an object value as one line per entry behind a summary, and edits it as pretty-printed JSON", async () => {
    const table = await show();
    const modelBy = rowOf(table, "model_by");
    // The file value: a summary of the keys, opening to `path → value` lines with nested objects flattened.
    const file = fileValue(modelBy);
    expect(file.querySelector("summary")!.textContent).toBe("4 keys: triage, implement, review, retry_up");
    const lines = [...file.querySelectorAll("[data-entries] dt")].map((dt) => `${dt.textContent} → ${dt.nextElementSibling!.textContent}`);
    expect(lines).toEqual(["triage → cheap", "implement.1 → standard", "implement.4 → strong", "review → standard", "retry_up → true"]);
    expect(file.textContent).not.toContain(MODEL_BY);
    // The edit field: one entry per line, behind its own summary.
    const field = within(modelBy).getByLabelText(`${keyLabel("model_by")}`) as HTMLTextAreaElement;
    expect(field.value).toBe(JSON.stringify(JSON.parse(MODEL_BY), null, 2));
    expect(field.closest("details")!.querySelector("summary")!.textContent).toContain("4 keys");
    // A short object is listed in full, with no summary; its default too.
    const hold = rowOf(table, "hold_policy");
    expect(hold.querySelectorAll("summary")).toHaveLength(1); // its Details only
    expect(fileValue(hold).textContent).toBe("default: moderun_after_minutesminutes120");
  });

  it("shows a millisecond key's File value like its Value (30m), and an empty File value or default as empty", async () => {
    const table = await show();
    expect(fileValue(rowOf(table, "retry_max_ms")).textContent).toBe("30m");
    expect(rowOf(table, "retry_max_ms").textContent).not.toContain("1800000 ");
    // message_style's file value is set; an empty default shows as one form: default: empty.
    const style = rowOf(table, "message_style");
    expect(fileValue(style).textContent).toBe('"Short."');
    view.keys.find((k) => k.key === "message_style")!.file_value = null;
    cleanup();
    const again = await show();
    expect(fileValue(rowOf(again, "message_style")).textContent).toBe("default: empty");
    view.keys.find((k) => k.key === "message_style")!.file_value = '"Short."';
  });

  it("shows the message_style example once: a paragraph, no placeholder", async () => {
    const table = await show();
    const field = within(rowOf(table, "message_style")).getByLabelText(`${keyLabel("message_style")}`) as HTMLTextAreaElement;
    expect(field.placeholder).toBe("");
    expect(document.body.textContent!.split("Short sentences. Plain words, no jargon. Lead with the decision.")).toHaveLength(2);
  });

  it("labels the per-project line: the global value when there is no override", async () => {
    const table = await show();
    const other = view.keys.find((k) => k.key === "max_diff_lines");
    expect(other).toBeUndefined();
    cleanup();
    view.keys.push(row("max_diff_lines", { project_settable: true }));
    const again = await show();
    expect(rowOf(again, "max_diff_lines").textContent).toContain("This project: uses the global value");
    view.keys.pop();
    expect(table).toBeTruthy();
  });

  it("hold_policy is a select (hold, start, wait) with the server mode's meaning in each label; wait adds minutes, starting at 120", async () => {
    const table = await show();
    const hold = rowOf(table, "hold_policy");
    const select = within(hold).getByRole("combobox", { name: `${keyLabel("hold_policy")}` });
    expect(optionsOf(select).map((o) => o.value)).toEqual(["hold", "start", "wait"]);
    expect(optionsOf(select).map((o) => o.textContent)).toEqual([
      "hold: keeps the run queued until /approve",
      "start: claims the run at once (mode run)",
      "wait: claims the run after its minutes (mode run_after_minutes)",
    ]);
    expect(hold.querySelector("textarea")).toBeNull();
    expect(within(hold).queryByLabelText(`${keyLabel("hold_policy")} minutes`)).toBeNull();
    // start writes {"mode":"run"}.
    pick(select, "start");
    fireEvent.click(within(hold).getByRole("button", { name: `Save ${keyLabel("hold_policy")}` }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ action: "set", key: "hold_policy", value: '{"mode":"run"}' });
    // wait shows minutes at 120 (the default hold limit) and writes run_after_minutes with them.
    pick(select, "wait");
    const minutes = within(hold).getByLabelText(`${keyLabel("hold_policy")} minutes`) as HTMLInputElement;
    expect(minutes.value).toBe("120");
    fireEvent.change(minutes, { target: { value: "5" } });
    fireEvent.click(within(hold).getByRole("button", { name: `Save ${keyLabel("hold_policy")}` }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ action: "set", key: "hold_policy", value: '{"mode":"run_after_minutes","minutes":5}' });
  });

  it("permission_mode is a segmented control in Limits, tightest first; a press writes the mode", async () => {
    expect(GROUP_KEYS.limits).toContain("permission_mode");
    view.keys.push(row("permission_mode", { kind: "text", value: '"ask_irreversible"', source: "default", file_value: null, default_value: '"ask_irreversible"' }));
    afterEachReset = () => void view.keys.pop();
    const table = await show();
    const mode = rowOf(table, "permission_mode");
    expect(mode.textContent).toContain("Permission mode");
    const group = within(mode).getByRole("radiogroup", { name: keyLabel("permission_mode") });
    const segments = within(group).getAllByRole("radio");
    expect(segments.map((s) => s.textContent)).toEqual(["Ask all", "Ask irreversible", "Full"]);
    expect(segments.map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
    fireEvent.click(segments[0]!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ action: "set", key: "permission_mode", value: '"ask_all"' });
  });

  it("hold_policy shows a server refusal next to the field", async () => {
    answer = { status: 400, body: { ok: false, error: "minutes must be a positive integer" } };
    const table = await show();
    const hold = rowOf(table, "hold_policy");
    pick(within(hold).getByRole("combobox", { name: `${keyLabel("hold_policy")}` }), "wait");
    fireEvent.change(within(hold).getByLabelText(`${keyLabel("hold_policy")} minutes`), { target: { value: "0" } });
    fireEvent.click(within(hold).getByRole("button", { name: `Save ${keyLabel("hold_policy")}` }));
    expect((await within(hold).findByRole("alert")).textContent).toContain("minutes must be a positive integer");
  });

  it("in the card layout Value sits under Key and every other cell has its label", async () => {
    const wide = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    afterEachReset = () => Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
    await show().catch(() => undefined);
    const card = (await screen.findByRole("list", { name: "Settable keys" })).querySelector<HTMLElement>('li[data-key="max_loops"]')!;
    const [title, under, rest] = [...card.children] as HTMLElement[];
    expect(title!.textContent).toContain(keyLabel("max_loops"));
    expect(within(under!).getByLabelText(`${keyLabel("max_loops")}`)).not.toBeNull();
    expect([...rest!.querySelectorAll("dt")].filter((d) => !d.closest("details")).map((d) => d.textContent)).toEqual(["Details", "Reset"]);
  });

  it("shows exactly three tabs, General selected by default, with Mode, Notices and Appearance and nothing from the other tabs", async () => {
    await show("");
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["General", "Integrations", "Advanced"]);
    expect(selectedTab()).toBe("General");
    expect(regions()).toEqual(["Mode", "Appearance"]);
    expect(screen.queryByRole("table", { name: "Settable keys" })).toBeNull();
  });

  it("each tab holds its sections: Integrations has Integrations and Calendar; Advanced has the keys, file keys, PR-only keys, History, Commands and the ignored overrides", async () => {
    view.ignored = [{ key: "max_loops", project: null, value: "9", reason: "above the config file's limit" }];
    await show("integrations");
    expect(selectedTab()).toBe("Integrations");
    await screen.findByRole("region", { name: "Calendar" });
    expect(regions()).toEqual(["Calendar"]);
    cleanup();
    await show("advanced");
    expect(selectedTab()).toBe("Advanced");
    expect(regions()).toEqual(["Settable keys", "Change on a local branch", PR_ONLY, "History", "Commands from the page", "Ignored overrides"]);
    view.ignored = [];
  });

  it("keeps Providers, Pending proposals and Standing approvals off every tab", async () => {
    for (const tab of ["general", "integrations", "advanced"]) {
      await show(tab);
      for (const gone of ["Providers", "Pending proposals", "Standing approvals", "Plugins page"]) expect(document.body.textContent, `${tab}: ${gone}`).not.toContain(gone);
      cleanup();
    }
  });

  it("choosing a tab shows its sections and writes it to the URL, and a reload on that URL opens it again", async () => {
    await show("");
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    await screen.findByRole("table", { name: "Settable keys" });
    expect(location.search).toBe("?tab=advanced");
    expect(selectedTab()).toBe("Advanced");
    fireEvent.click(screen.getByRole("tab", { name: "Integrations" }));
    expect(location.search).toBe("?tab=integrations");
    expect(screen.queryByRole("table", { name: "Settable keys" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(regions()).toEqual(["Mode", "Appearance"]);
    // A reload: a fresh page on the URL as it stands.
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    cleanup();
    await show(null);
    expect(selectedTab()).toBe("Advanced");
    expect(screen.getByRole("table", { name: "Settable keys" })).not.toBeNull();
  });

  it("a tab name the page does not know opens General", async () => {
    await show("nonsense");
    expect(selectedTab()).toBe("General");
  });

  it("the page names no CLI command in its intro or its PR-only text", async () => {
    await show();
    expect(document.body.textContent).not.toContain("factory settings");
    expect(screen.getByRole("region", { name: "Settable keys" }).textContent).toContain("the same checks as the command line run first");
  });

  it("every settable key has a human label and a description in the catalog", () => {
    for (const key of SETTABLE_KEYS) {
      expect(en[`key.${key}.label` as MessageKey], key).toBeTruthy();
      expect(en[`key.${key}.help` as MessageKey], key).toBeTruthy();
    }
  });

  it("no row shows a raw key name as its primary text: the label is, and the key sits behind Details with Source, File value and Applies at", async () => {
    const table = await show();
    for (const k of view.keys) {
      const r = rowOf(table, k.key);
      const first = r.querySelector("td")!;
      expect(first.querySelector("span")!.textContent, k.key).toBe(keyLabel(k.key));
      const details = r.querySelector("details[data-details]")!;
      expect(details.querySelector("summary")!.textContent).toBe("Details");
      expect([...details.querySelectorAll(":scope > div > dl > dt")].map((d) => d.textContent)).toEqual(["Key name", "Source", "File value", "Applies at"]);
      expect(details.querySelector("dd")!.textContent).toBe(k.key);
      // Outside Details the key name appears nowhere in the row.
      const bare = [...r.querySelectorAll("*")].filter((e) => !e.closest("details[data-details]") && e.children.length === 0 && e.textContent === k.key);
      expect(bare, k.key).toHaveLength(0);
    }
    // The three keys the owner named read as words, not as keys.
    for (const [key, label] of [["max_attempts", "Attempts per item"], ["standing_approvals.threshold", "Standing approval threshold"], ["repo.install_command", "Install command"]] as const) {
      expect(keyLabel(key)).toBe(label);
    }
  });

  it("the Save and Reset buttons name the human label, never the raw key", async () => {
    const table = await show();
    const loops = rowOf(table, "max_loops");
    expect(within(loops).getByRole("button", { name: "Save Review rounds" })).not.toBeNull();
    expect(within(loops).getByRole("button", { name: "Reset Review rounds" })).not.toBeNull();
    for (const b of document.querySelectorAll("button")) expect(b.getAttribute("aria-label") ?? "", b.outerHTML).not.toMatch(/(Save|Reset) [a-z]+[._][a-z_.]+/);
    const att = rowOf(table, "max_attempts");
    expect(within(att).getByRole("button", { name: "Reset Attempts per item for o/r" })).not.toBeNull();
  });
});

describe("Settings page: the typed form of the file-only keys (design 08-settings)", () => {
  const FILE_SECTION = "Change on a local branch";
  async function form() {
    await show();
    return screen.getByRole("region", { name: FILE_SECTION });
  }
  const keyOf = (section: HTMLElement, key: string) => section.querySelector<HTMLElement>(`tr[data-file-key="${key}"]`)!;
  const sent = (n: number) => JSON.parse(posts[n]!.init.body as string) as { action: string; key: string; value: string; confirm: boolean };
  /** Save opens the confirm Dialog; this presses its confirm. */
  const confirm = async () => {
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    expect(dialog).not.toBeNull();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Put on a branch" })));
  };
  const filedAnswer = () => {
    answer = { status: 200, body: { ok: true, lines: ["filed"], item: "wi_9", branch: "factory/wi_9" } };
  };

  it("use=runner:fake (the Plugins page's Models menu) opens the runner row's confirm with fake picked, writes plugins.runner only, and leaves the address", async () => {
    filedAnswer();
    history.replaceState(null, "", "/app/settings?tab=advanced&use=runner%3Afake");
    await show(null);
    const dialog = await waitFor(() => document.querySelector<HTMLElement>("dialog[data-dialog]")!);
    expect(dialog.querySelector("[data-new-value]")!.textContent).toContain('"runner": "fake"');
    expect(location.search).toBe("?tab=advanced");
    await confirm();
    expect(sent(0)).toMatchObject({ action: "edit-file", key: "plugins" });
    expect(JSON.parse(sent(0).value)).toEqual({ secrets: "env-file", runner: "fake", source: ["local", "slack"] });
  });

  it("use= naming a plugin the kind does not register opens nothing", async () => {
    history.replaceState(null, "", "/app/settings?tab=advanced&use=runner%3Anope");
    await show(null);
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
  });

  it("names each file key and read-only key by its label, with the key name behind Details, and Save names the label", async () => {
    const section = await form();
    for (const { key } of view.file_keys!.editable.filter((e) => e.key !== "plugins")) {
      const li = keyOf(section, key);
      expect(en[`key.${key}.label` as MessageKey], key).toBeTruthy();
      expect(li.querySelector("td span")!.textContent, key).toBe(keyLabel(key));
      expect(within(li).getByRole("button", { name: `Save ${keyLabel(key)}` })).not.toBeNull();
      expect(li.querySelector("details dd")!.textContent).toBe(key);
    }
    expect(within(keyOf(section, "repo.install_command")).getByRole("button", { name: "Save Install command" })).not.toBeNull();
    for (const { key } of view.file_keys!.read_only) {
      expect(en[`key.${key}.label` as MessageKey], key).toBeTruthy();
      expect(section.querySelector(`tr[data-read-only="${key}"] span`)!.textContent).toBe(keyLabel(key));
    }
    for (const key of PR_ONLY_KEYS) expect(en[`key.${key}.label` as MessageKey], key).toBeTruthy();
  });

  it("has a typed control for every file-only key the page edits", async () => {
    const section = await form();
    const rows = [...section.querySelectorAll<HTMLElement>("tr[data-file-key]")].map((r) => r.getAttribute("data-file-key"));
    // `plugins` is one row per plugin kind.
    expect(rows).toEqual(view.file_keys!.editable.flatMap((e) => (e.key === "plugins" ? view.file_keys!.plugins.map((p) => `plugins.${p.kind}`) : [e.key])));
    for (const li of section.querySelectorAll<HTMLElement>("tr[data-file-key]")) {
      expect(within(li).getAllByRole("button", { name: /^Save / }), li.getAttribute("data-file-key")!).toHaveLength(1);
    }
    // Text fields per model class; a class select per model_by role and tier, a switch for retry_up.
    expect((within(keyOf(section, "models")).getByLabelText(`${keyLabel("models")} strong`) as HTMLInputElement).value).toBe("opus");
    const triage = within(keyOf(section, "model_by")).getByRole("combobox", { name: `${keyLabel("model_by")} triage` });
    expect(optionsOf(triage).map((o) => o.value)).toEqual(["cheap", "standard", "strong"]);
    expect(within(keyOf(section, "model_by")).getByRole<HTMLButtonElement>("combobox", { name: `${keyLabel("model_by")} implement 1` }).value).toBe("standard");
    expect(within(keyOf(section, "model_by")).getByRole("switch", { name: `${keyLabel("model_by")} retry_up` }).getAttribute("aria-checked")).toBe("true");
    // slack: a list editor of channels and a text field per optional member.
    expect((within(keyOf(section, "slack")).getByLabelText(`${keyLabel("slack")} channels 1`) as HTMLInputElement).value).toBe("C1");
    expect((within(keyOf(section, "slack")).getByLabelText(`${keyLabel("slack")} dashboard_url`) as HTMLInputElement).value).toBe("");
    // The repo commands: one line of arguments each, a quoted argument where it holds a space; check_commands a list of them.
    expect((within(keyOf(section, "repo.install_command")).getByLabelText(`${keyLabel("repo.install_command")}`) as HTMLInputElement).value).toBe("npm ci");
    expect((within(keyOf(section, "repo.test_command")).getByLabelText(`${keyLabel("repo.test_command")}`) as HTMLInputElement).value).toBe('sh -c "npm test"');
    expect((within(keyOf(section, "repo.check_commands")).getByLabelText(`${keyLabel("repo.check_commands")} 1`) as HTMLInputElement).value).toBe("npm run typecheck");
    expect((within(keyOf(section, "repo.path")).getByLabelText(`${keyLabel("repo.path")}`) as HTMLInputElement).value).toBe(".");
    // toolchain: env as KEY=VALUE lines, warm_command as arguments.
    expect((within(keyOf(section, "toolchain")).getByLabelText(`${keyLabel("toolchain")} env 1`) as HTMLInputElement).value).toBe("CI=1");
    expect((within(keyOf(section, "toolchain")).getByLabelText(`${keyLabel("toolchain")} warm_command`) as HTMLInputElement).value).toBe("npm ci");
    // dials, floors and permissions: typed inputs per member.
    expect((within(keyOf(section, "dials")).getByLabelText(`${keyLabel("dials")} spec_gate_min_tier`) as HTMLInputElement).type).toBe("number");
    expect((within(keyOf(section, "floors")).getByLabelText(`${keyLabel("floors")} 1 prefix`) as HTMLInputElement).value).toBe("prompts/");
    expect((within(keyOf(section, "floors")).getByLabelText(`${keyLabel("floors")} 1 tier`) as HTMLInputElement).value).toBe("3");
    expect((within(keyOf(section, "permissions")).getByLabelText(`${keyLabel("permissions")} grants 1`) as HTMLInputElement).value).toBe("static");
    expect(within(keyOf(section, "permissions")).getByLabelText(`${keyLabel("permissions")} static`).tagName).toBe("TEXTAREA");
    // The path lists: list editors, nested for path_companions.
    expect((within(keyOf(section, "hotspot_paths")).getByLabelText(`${keyLabel("hotspot_paths")} 1`) as HTMLInputElement).value).toBe("src/core/");
    expect(within(keyOf(section, "mechanical_paths")).getByRole("button", { name: `Add to ${keyLabel("mechanical_paths")}` })).not.toBeNull();
    expect((within(keyOf(section, "path_companions")).getByLabelText(`${keyLabel("path_companions")} 1 also 1`) as HTMLInputElement).value).toBe("docs/design/");
  });

  const PLAIN: Record<string, string> = { secrets: "Secret store", runner: "Agent runner", source: "Sources", capability: "Capability search" };

  it("each plugin kind is its own row with a plain name; its select lists only its registered names and no option turns a guard off", async () => {
    const section = await form();
    for (const p of view.file_keys!.plugins.filter((x) => x.kind !== "source")) {
      const row = keyOf(section, `plugins.${p.kind}`);
      const select = within(row).getByRole<HTMLButtonElement>("combobox", { name: PLAIN[p.kind]! });
      expect(optionsOf(select).filter((o) => !o.disabled).map((o) => o.value), p.kind).toEqual(p.names);
      // The file's choice; an interface the file leaves out shows the plugin in force and writes nothing until picked.
      if (p.kind === "capability") {
        expect(select.value).toBe("");
        expect(select.textContent).toBe("default: bm25");
      } else expect(select.value, p.kind).toBe(p.selected);
    }
    const secrets = within(keyOf(section, "plugins.secrets")).getByRole("combobox", { name: "Secret store" });
    expect(optionsOf(secrets).map((o) => o.value)).not.toContain("none");
    // An interface the file lists several of is one Sources row: a select per source with its Remove, and Add below.
    const sources = keyOf(section, "plugins.source");
    expect(within(sources).getByRole<HTMLButtonElement>("combobox", { name: "Sources 2" }).value).toBe("slack");
    expect(within(sources).getByRole("button", { name: "Remove Sources 2" })).not.toBeNull();
    expect(within(sources).getByRole("button", { name: "Add to Sources" })).not.toBeNull();
  });

  it("every row of the section is the shared settings row; no code name shows outside Details", async () => {
    const section = await form();
    const rows = [...section.querySelectorAll<HTMLElement>("tr")].filter((r) => r.querySelector("td"));
    expect(rows.length).toBeGreaterThan(0);
    const named = [...section.querySelectorAll("tr[data-file-key], tr[data-read-only]")];
    expect(rows).toHaveLength(named.length);
    for (const row of rows) {
      expect(row.hasAttribute("data-setting-row")).toBe(true);
      // Details holds the key name; the row's name and description sit outside it.
      const key = (row.getAttribute("data-file-key") ?? row.getAttribute("data-read-only"))!;
      expect(row.querySelector("details dd")!.textContent).toBe(key);
      const outside = row.cloneNode(true) as HTMLElement;
      outside.querySelector("details")!.remove();
      expect(outside.textContent, key).not.toMatch(/\((broker|secrets|runner|source),? ?(guard)?\)|ToolBroker|SecretStore|AgentRunner|SourceAdapter/);
    }
    // A guard plugin's Details also says "guard"; another plugin's does not.
    expect(keyOf(section, "plugins.secrets").querySelector("details")!.textContent).toContain("guard");
    expect(keyOf(section, "plugins.runner").querySelector("details")!.textContent).not.toContain("guard");
    // The read-only keys' reason sits under the name as the description.
    expect(section.querySelector('tr[data-read-only="env"] p')!.textContent).toContain("locally or in the cloud");
    // The section title is the Card's h2; the sub-group under it is an h3 in the one sub-group style.
    expect(screen.getByRole("heading", { level: 2, name: "Change on a local branch" }).className).toContain("text-balance text-base font-semibold");
    expect(screen.getByRole("heading", { level: 3, name: "Read-only keys" }).className).toContain("text-xs font-medium text-text-2");
  });

  it("Save sends edit-file through the writer, then shows the branch and a Merge button that merges the item locally", async () => {
    filedAnswer();
    const section = await form();
    const hot = keyOf(section, "hotspot_paths");
    fireEvent.click(within(hot).getByRole("button", { name: `Add to ${keyLabel("hotspot_paths")}` }));
    fireEvent.change(within(hot).getByLabelText(`${keyLabel("hotspot_paths")} 2`), { target: { value: "src/ui/" } });
    await act(async () => fireEvent.click(within(hot).getByRole("button", { name: `Save ${keyLabel("hotspot_paths")}` })));
    expect(posts).toHaveLength(0);
    await confirm();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe("/api/v1/settings");
    expect(sent(0)).toEqual({ action: "edit-file", key: "hotspot_paths", value: '["src/core/","src/ui/"]', confirm: false });
    const filed = hot.querySelector<HTMLElement>('[data-filed="wi_9"]')!;
    expect(filed.textContent).toContain("factory/wi_9");
    const merge = await within(filed).findByRole("button", { name: "Merge" });
    await waitFor(() => expect((merge as HTMLButtonElement).disabled).toBe(false));
    await act(async () => fireEvent.click(merge));
    expect(posts[1]!.url).toBe("/api/v1/items/wi_9/commands");
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ command: "merge" });
    // A Remove takes an entry out; a command line goes back as its arguments; a text member left empty is left out.
    fireEvent.click(within(hot).getByRole("button", { name: `Remove ${keyLabel("hotspot_paths")} 1` }));
    await act(async () => fireEvent.click(within(hot).getByRole("button", { name: `Save ${keyLabel("hotspot_paths")}` })));
    await confirm();
    expect(sent(2).value).toBe("[]");
    const test = keyOf(section, "repo.test_command");
    fireEvent.change(within(test).getByLabelText(`${keyLabel("repo.test_command")}`), { target: { value: 'sh -c "npm run check"' } });
    await act(async () => fireEvent.click(within(test).getByRole("button", { name: `Save ${keyLabel("repo.test_command")}` })));
    await confirm();
    expect(JSON.parse(sent(3).value)).toEqual(["sh", "-c", "npm run check"]);
    const slack = keyOf(section, "slack");
    fireEvent.change(within(slack).getByLabelText(`${keyLabel("slack")} channels 1`), { target: { value: "C2" } });
    await act(async () => fireEvent.click(within(slack).getByRole("button", { name: `Save ${keyLabel("slack")}` })));
    await confirm();
    expect(JSON.parse(sent(4).value)).toEqual({ channels: ["C2"] });
    // A non-guard plugin change writes the whole plugins object, the file's other members kept, without the confirm flag.
    const runner = keyOf(section, "plugins.runner");
    pick(within(runner).getByRole("combobox", { name: "Agent runner" }), "fake");
    await act(async () => fireEvent.click(within(runner).getByRole("button", { name: "Save Agent runner" })));
    await confirm();
    expect(sent(5)).toMatchObject({ key: "plugins", confirm: false });
    expect(JSON.parse(sent(5).value)).toEqual({ secrets: "env-file", runner: "fake", source: ["local", "slack"] });
  });

  it("a guard, floor, permission or dial opens the danger Dialog: Cancel sends no write request, Confirm sends the confirm flag", async () => {
    filedAnswer();
    const section = await form();
    const change: [string, () => void][] = [
      ["plugins.secrets", () => pick(within(keyOf(section, "plugins.secrets")).getByRole("combobox", { name: "Secret store" }), "keychain")],
      ["floors", () => fireEvent.change(within(keyOf(section, "floors")).getByLabelText(`${keyLabel("floors")} 1 tier`), { target: { value: "2" } })],
      ["permissions", () => fireEvent.click(within(keyOf(section, "permissions")).getByRole("button", { name: `Remove ${keyLabel("permissions")} grants 1` }))],
      ["dials", () => fireEvent.change(within(keyOf(section, "dials")).getByLabelText(`${keyLabel("dials")} auto_merge_max_tier`), { target: { value: "2" } })],
    ];
    for (const [key, edit] of change) {
      const label = key === "plugins.secrets" ? "Secret store" : keyLabel(key);
      edit();
      await act(async () => fireEvent.click(within(keyOf(section, key)).getByRole("button", { name: `Save ${label}` })));
      const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
      expect(dialog, key).not.toBeNull();
      expect(dialog.textContent).toContain(`Change ${label}?`);
      await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
      expect(document.querySelector("dialog[data-dialog]"), key).toBeNull();
      expect(posts, key).toHaveLength(0);
    }
    // Confirm sends the write with the confirm flag.
    await act(async () => fireEvent.click(within(keyOf(section, "floors")).getByRole("button", { name: `Save ${keyLabel("floors")}` })));
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Put on a branch" })));
    expect(posts).toHaveLength(1);
    expect(sent(0)).toEqual({ action: "edit-file", key: "floors", value: '[{"prefix":"prompts/","tier":2}]', confirm: true });
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
  });

  it("each read-only key shows its value and its reason, with no control and no file path", async () => {
    const section = await form();
    for (const { key, value } of view.file_keys!.read_only) {
      const li = section.querySelector<HTMLElement>(`tr[data-read-only="${key}"]`)!;
      expect(li, key).not.toBeNull();
      expect(li.textContent).toContain(value ?? "not set");
      expect(li.textContent).not.toContain("factory.config.json");
      expect(li.querySelectorAll("input, button, textarea, select, [role=switch]"), key).toHaveLength(0);
      expect(section.querySelector(`tr[data-file-key="${key}"]`), key).toBeNull();
    }
  });

  it("shows no typed form when the server has no file writer", async () => {
    const saved = view.file_keys;
    view.file_keys = null;
    afterEachReset = () => (view.file_keys = saved ?? null);
    await show();
    expect(screen.queryByRole("region", { name: FILE_SECTION })).toBeNull();
    // Without the form every PR-only key stays in the table.
    expect(screen.getByRole("table", { name: PR_ONLY }).querySelector('tr[data-key="plugins"]')).not.toBeNull();
  });
});

describe("Settings page: Mode lines, grouped Advanced keys and plain timing (design 09-dashboard-settings)", () => {
  // Most important first (owner feedback 2026-11-20): Limits leads, and workers is its first key.
  it("each settable key is in exactly one group, and the groups run Limits, Models, Retries, Notices, For developers", () => {
    expect(ADVANCED_GROUPS.map((g) => en[g.title])).toEqual(["Limits", "Models", "Retries", "Notices", "For developers"]);
    expect(GROUP_KEYS.limits[0]).toBe("workers");
    for (const key of SETTABLE_KEYS) {
      const groups = ADVANCED_GROUPS.filter((g) => GROUP_KEYS[g.id].includes(key)).map((g) => g.id);
      expect(groups, key).toHaveLength(1);
    }
    for (const g of ADVANCED_GROUPS) for (const key of GROUP_KEYS[g.id]) expect(SETTABLE_KEYS as readonly string[], key).toContain(key);
    for (const key of ["lease_ms", "heartbeat_ms", "hotspot_weight", "mechanical_weight", "max_coordination_cost"]) expect(GROUP_KEYS.developers).toContain(key);
  });

  it("the Advanced tab draws a heading per group in order, and For developers collapsed after them", async () => {
    const table = await show();
    expect([...table.querySelectorAll("tr[data-group]")].map((r) => r.textContent)).toEqual(["Limits", "Models", "Retries"]); // the fixture has no Notices key
    const dev = document.querySelector<HTMLDetailsElement>("details[data-group=developers]")!;
    expect(dev.querySelector("summary")!.textContent).toBe("For developers");
    expect(dev.open).toBe(false);
    expect(dev.querySelector('tr[data-key="tick_ms"]')).not.toBeNull();
    expect(table.querySelector('tr[data-key="tick_ms"]')).toBeNull();
    // Each row sits after its own group's heading.
    const order = [...table.querySelectorAll("tbody > tr")].map((r) => r.getAttribute("data-group") ?? r.getAttribute("data-key"));
    expect(order.indexOf("max_attempts")).toBe(order.indexOf("retries") + 1);
    expect(order.indexOf("model_by")).toBeGreaterThan(order.indexOf("models"));
  });

  it("orders the keys in a group by GROUP_KEYS, not by the server's order", async () => {
    const table = await show();
    const keys = [...table.querySelectorAll("tbody > tr[data-key]")].map((r) => r.getAttribute("data-key")!);
    for (const g of ADVANCED_GROUPS) {
      const listed = GROUP_KEYS[g.id].filter((k) => keys.includes(k));
      expect(keys.filter((k) => GROUP_KEYS[g.id].includes(k)), g.id).toEqual(listed);
    }
  });

  it("search keeps the keys whose name, label or help text matches, For developers too, and says when none matches", async () => {
    const table = await show();
    const search = screen.getByRole("searchbox", { name: "Search settings" });
    // The search is a page filter: in the PageToolbar's second row, not inside the Settable keys card.
    expect(search.closest("[data-page-toolbar]")).not.toBeNull();
    expect(search.closest("section")).toBeNull();
    fireEvent.change(search, { target: { value: "TICK_MS" } });
    // The settable keys only: the file keys and PR-only tables below are not searched.
    const shownKeys = () => [...(screen.queryByRole("table", { name: "Settable keys" })?.querySelectorAll("tr[data-key]") ?? []), ...document.querySelectorAll("details[data-group] tr[data-key]")].map((r) => r.getAttribute("data-key"));
    // A developers key matched by its name shows in the table, and the collapsed For developers is gone.
    expect(shownKeys()).toEqual(["tick_ms"]);
    expect(document.querySelector("details[data-group=developers]")).toBeNull();
    // A key matched by its label.
    fireEvent.change(search, { target: { value: keyLabel("max_loops").toUpperCase() } });
    expect(shownKeys()).toContain("max_loops");
    fireEvent.change(search, { target: { value: "no such setting zz" } });
    expect(shownKeys()).toEqual([]);
    expect(document.querySelector("[data-no-match]")!.textContent).toBe("No setting matches \u201cno such setting zz\u201d.");
    // Clearing it brings every key back, For developers collapsed again.
    fireEvent.change(search, { target: { value: "" } });
    expect(shownKeys().sort()).toEqual(view.keys.map((k) => k.key).sort());
    expect(document.querySelector<HTMLDetailsElement>("details[data-group=developers]")!.open).toBe(false);
    void table;
  });

  it("Details says when a change applies in one of three phrases", async () => {
    await show();
    expect(appliesKey("the next run that starts")).toBe("settings.appliesTask");
    expect(appliesKey("the next claim or lease renewal")).toBe("settings.appliesTask");
    expect(appliesKey("the controller's next decision")).toBe("settings.appliesMinute");
    expect(appliesKey("the next load of the Tasks page")).toBe("settings.appliesNow");
    const phrases = ["Applies right away", "to the next task", "within a minute"];
    for (const k of view.keys) expect(phrases, k.key).toContain(rowOf(document.body, k.key).querySelector("details[data-details] dl")!.lastElementChild!.textContent);
  });

  it("the model row shows the planning and building classes, read from the value", async () => {
    // The default model_by: planning cheap, building standard, strong from the 3rd try.
    const byDefault = '{"triage":"cheap","implement":{"1":"standard","2":"standard","3":"strong","4":"strong","5":"strong"},"review":"standard","retry_up":true}';
    expect(modelSummary(byDefault)).toBe("Planning: cheap · Building: standard, strong from the 3rd try");
    expect(modelSummary('{"triage":"cheap","implement":{"1":"standard"}}')).toBe("Planning: cheap · Building: standard");
    expect(modelSummary("not json")).toBeNull();
    const table = await show();
    expect(rowOf(table, "model_by").querySelector("[data-model-summary]")!.textContent).toBe("Planning: cheap · Building: standard, strong from the 4th try");
  });

  it("General shows Mode as three lines and the tier control with each level explained", async () => {
    view.keys.push(row("auto_merge_max_tier", { value: "1" }));
    afterEachReset = () => view.keys.pop();
    await show("general");
    const lines = [...document.querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(expect.arrayContaining(["Manual: you approve specs and merge.", "Back to manual on a red main, a crash loop or a budget checkpoint."]));
    expect(lines.filter((l) => /^(Manual|Auto|Back to manual)/.test(l ?? ""))).toHaveLength(3);
    expect(document.body.textContent).toContain("Merge on its own up to risk level…");
    expect(screen.getByRole("spinbutton", { name: /risk level/i })).toBeTruthy();
    expect([...document.querySelectorAll("[data-tier-levels] li")].map((l) => l.textContent)).toEqual(["0: none", "1: docs and tests only", "2: a small local code change", "3: core logic, config, prompts or gates", "Risk level: high (4) and the gate list (changes to protected areas) always wait for a person."]);
  });

  it("the extra pages line reads More pages", async () => {
    await show();
    expect(document.body.textContent).toContain("More pages");
    expect(document.body.textContent).not.toContain("Pages not in the sidebar");
  });

  it("an integration on from the config file is a read-only switch in the on colour, with a lock and a description; one on from the dashboard is the same colour", async () => {
    view.keys.push(row("integrations", { kind: "json", value: '{"eval_source":"agents-home"}', source: "override" }));
    view.integrations = [
      { kind: "tacit", interface: "TacitLedger", plugin: "agents-home", source: "config", configured: "agents-home" },
      { kind: "eval_source", interface: "SkillEvalSource", plugin: "agents-home", source: "setting", configured: "none" },
    ];
    try {
      await show("integrations");
      const config = await screen.findByRole("switch", { name: "Integration: TacitLedger" });
      const dashboard = screen.getByRole("switch", { name: "Integration: SkillEvalSource" });
      const track = (el: HTMLElement) => (el.firstElementChild as HTMLElement).className;
      expect(track(config)).toContain("bg-text-1");
      expect(track(config)).toBe(track(dashboard));
      expect(config.className).not.toContain("opacity-50");
      expect(dashboard.className).toContain("disabled:opacity-50");
      expect(config.getAttribute("aria-readonly")).toBe("true");
      expect((config as HTMLButtonElement).disabled).toBe(false);
      const rowOf = (kind: string) => document.querySelector(`[data-integration="${kind}"]`) as HTMLElement;
      expect(within(rowOf("tacit")).getByTestId("integration-lock").getAttribute("aria-hidden")).toBe("true");
      expect(within(rowOf("eval_source")).queryByTestId("integration-lock")).toBeNull();
      expect(rowOf("tacit").textContent).toContain("Set in the config file; change it there");
      const described = document.getElementById(config.getAttribute("aria-describedby") ?? "");
      expect(described?.textContent).toContain("Set in the config file; change it there");
      expect(described?.textContent).toContain("plugins.tacit");
      expect(dashboard.getAttribute("aria-describedby")).toBeNull();
      fireEvent.focus(config);
      expect(screen.getByRole("tooltip").textContent).toContain("plugins.tacit");
      fireEvent.click(config);
      expect(posts).toEqual([]);
      expect(screen.queryByRole("dialog")).toBeNull();
    } finally {
      view.keys.pop();
      delete view.integrations;
    }
  });
});

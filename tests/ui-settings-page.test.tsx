// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitiesView, SettingRow, SettingsView } from "../web/src/api.js";

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
    row("hold_policy", { kind: "json", value: '{"mode":"hold"}', source: "default", file_value: null, default_value: '{"mode":"hold"}', applies_at: "the next claim" }),
    row("message_style", { kind: "text", value: '"Short."', file_value: '"Short."', default_value: '""' }),
    row("phases_auto_approve", { kind: "boolean", value: "false", source: "default", file_value: null, applies_at: "the next phase spec triage writes" }),
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

// The Capabilities section's read (design 08-settings, 2026-11-13): a skill, a granted tool, a tool that writes, a provider entry.
const capabilities: CapabilitiesView = {
  as_of: AT,
  roles: ["triage", "implement", "review", "update", "resolve", "manual"],
  capabilities: [
    { kind: "skill", id: "skill:deploy", name: "deploy", detail: "/home/me/.claude/skills", enabled: true, roles: [], last_used: null },
    { kind: "tool", id: "tool:forge.preflight", name: "forge.preflight", detail: "Read-only check.", enabled: true, roles: ["review", "triage"], last_used: AT, read_only: true },
    { kind: "tool", id: "tool:git.store_branch", name: "git.store_branch", detail: "Store a branch.", enabled: false, roles: [], last_used: null, read_only: false },
    {
      kind: "provider", id: "runner:claude-code", name: "runner:claude-code", detail: null, enabled: true, roles: ["triage", "implement", "review", "resolve"], last_used: AT,
      models: [{ class: "cheap", model: "haiku" }, { class: "standard", model: "sonnet" }, { class: "strong", model: "opus" }],
    },
  ],
};
let capabilitiesReads = 0;

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
    if (url === "/api/v1/settings/capabilities") return (capabilitiesReads++, new Response(JSON.stringify(capabilities), { status: 200, headers: { "content-type": "application/json" } }));
    if (url.startsWith("/api/v1/items/")) return new Response(JSON.stringify({ item: { merge: { enabled: true, reason: null } } }), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "/api/v1/session") return new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }));
});

let afterEachReset: () => void = () => undefined;
afterEach(() => {
  afterEachReset();
  afterEachReset = () => undefined;
  cleanup();
  vi.unstubAllGlobals();
});

async function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(SettingsPage)));
  return screen.findByRole("table", { name: "Settable keys" });
}

const PR_ONLY = "Change only in factory.config.json (by a reviewed PR)";
const rowOf = (table: HTMLElement, key: string) => table.querySelector<HTMLElement>(`tr[data-key="${key}"]`)!;

describe("Settings page", () => {
  it("has a Capabilities section: each skill, tool and provider entry with its state, roles and last use", async () => {
    capabilitiesReads = 0;
    await show();
    const table = await screen.findByRole("table", { name: "Capabilities" });
    const rows = [...table.querySelectorAll("tbody > tr")];
    expect(rows.map((r) => r.querySelector("td")!.textContent)).toEqual([
      "deploy/home/me/.claude/skills",
      "forge.preflightRead-only check.",
      "git.store_branchStore a branch.",
      "runner:claude-codecheap: haiku · standard: sonnet · strong: opus",
    ]);
    expect(rows[1]!.textContent).toContain("Enabled");
    expect(rows[1]!.textContent).toContain("review, triage");
    expect(rows[1]!.textContent).toContain("ago");
    expect(rows[2]!.textContent).toContain("Off");
    expect(rows[2]!.textContent).toContain("writes; never granted");
    expect(rows[0]!.textContent).toContain("No role");
    expect(rows[0]!.textContent).toContain("Not in recent runs");
    // Read once when the page opens, never polled: it reads stored transcripts.
    expect(capabilitiesReads).toBe(1);
  });

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
    expect([...table.querySelectorAll("tbody > tr")].map((r) => r.getAttribute("data-key"))).toEqual(view.keys.map((k) => k.key));
    const loops = rowOf(table, "max_loops");
    expect((within(loops).getByLabelText("max_loops") as HTMLInputElement).value).toBe("4");
    expect(loops.textContent).toContain("override");
    expect(loops.textContent).toContain("the controller's next decision");
    const tick = rowOf(table, "tick_ms");
    expect(tick.textContent).toContain("default");
    expect(tick.textContent).toContain("default: 2s");
    expect(tick.textContent).toContain("the next tick");
    // A long unbroken value may break anywhere, so the table fits its card at 1280 px and Reset keeps its 12 px.
    expect(within(tick).getByText("2s", { selector: "span.font-mono" }).className.split(" ")).toContain("wrap-anywhere");
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
    expect(att.textContent).toContain("This project: 2 (override)");
    expect(within(att).getByRole("button", { name: "Reset max_attempts for o/r" })).not.toBeNull();
  });

  it("the models form is a two-column grid (tier | 7rem field, 8 px by 12 px) with Save in its own button row 12 px below", async () => {
    const table = await show();
    const models = rowOf(table, "models");
    const grid = models.querySelector<HTMLElement>("[data-tiers]")!;
    expect(grid.className.split(" ")).toEqual(expect.arrayContaining(["grid", "grid-cols-[max-content_7rem]", "gap-x-2", "gap-y-3"]));
    // Each tier is a label cell then its field cell, so the three fields share one column and start at one x.
    expect([...grid.children].map((c) => c.tagName)).toEqual(["LABEL", "INPUT", "LABEL", "INPUT", "LABEL", "INPUT"]);
    for (const t of ["cheap", "standard", "strong"]) expect(within(grid).getByLabelText(`models ${t}`).className).toContain("w-full");
    const save = within(models).getByRole("button", { name: "Save models" });
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

  it("shows each key's description from the API under its name, editable and PR-only rows alike", async () => {
    const table = await show();
    for (const k of view.keys) {
      const cell = rowOf(table, k.key).querySelector("td")!;
      expect(cell.textContent).toContain(k.key);
      expect(cell.textContent).toContain(DESC(k.key));
    }
    const pr = screen.getByRole("table", { name: PR_ONLY });
    for (const key of ["deny_paths", "auth"]) {
      const cell = pr.querySelector<HTMLElement>(`tr[data-key="${key}"] td`)!;
      expect(cell.textContent).toContain(DESC(key));
    }
    // Always in the page, not behind a hover or a breakpoint.
    const p = screen.getByText(DESC("max_loops"));
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
      expect(rowOf(table, k.key).querySelector("td")!.textContent).toContain(DESC(k.key));
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

  it("shows an object value as one line per entry behind a summary, and edits it as pretty-printed JSON", async () => {
    const table = await show();
    const modelBy = rowOf(table, "model_by");
    // The file value: a summary of the keys, opening to `path → value` lines with nested objects flattened.
    const file = modelBy.querySelectorAll("td")[3]!;
    expect(file.querySelector("summary")!.textContent).toBe("4 keys: triage, implement, review, retry_up");
    const lines = [...file.querySelectorAll("[data-entries] dt")].map((dt) => `${dt.textContent} → ${dt.nextElementSibling!.textContent}`);
    expect(lines).toEqual(["triage → cheap", "implement.1 → standard", "implement.4 → strong", "review → standard", "retry_up → true"]);
    expect(file.textContent).not.toContain(MODEL_BY);
    // The edit field: one entry per line, behind its own summary.
    const field = within(modelBy).getByLabelText("model_by") as HTMLTextAreaElement;
    expect(field.value).toBe(JSON.stringify(JSON.parse(MODEL_BY), null, 2));
    expect(field.closest("details")!.querySelector("summary")!.textContent).toContain("4 keys");
    // A short object is listed in full, with no summary; its default too.
    const hold = rowOf(table, "hold_policy");
    expect(hold.querySelector("summary")).toBeNull();
    expect(hold.querySelectorAll("td")[3]!.textContent).toBe("default: modehold");
  });

  it("shows a millisecond key's File value like its Value (30m), and an empty File value or default as empty", async () => {
    const table = await show();
    expect(rowOf(table, "retry_max_ms").querySelectorAll("td")[3]!.textContent).toBe("30m");
    expect(rowOf(table, "retry_max_ms").textContent).not.toContain("1800000 ");
    // message_style's file value is set; an empty default shows as one form: default: empty.
    const style = rowOf(table, "message_style");
    expect(style.querySelectorAll("td")[3]!.textContent).toBe('"Short."');
    view.keys.find((k) => k.key === "message_style")!.file_value = null;
    cleanup();
    const again = await show();
    expect(rowOf(again, "message_style").querySelectorAll("td")[3]!.textContent).toBe("default: empty");
    view.keys.find((k) => k.key === "message_style")!.file_value = '"Short."';
  });

  it("shows the message_style example once: a paragraph, no placeholder", async () => {
    const table = await show();
    const field = within(rowOf(table, "message_style")).getByLabelText("message_style") as HTMLTextAreaElement;
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

  it("hold_policy is a select (hold, start, wait) with the server mode's meaning in each label; wait adds minutes, starting at 20", async () => {
    const table = await show();
    const hold = rowOf(table, "hold_policy");
    const select = within(hold).getByLabelText("hold_policy") as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["hold", "start", "wait"]);
    expect([...select.options].map((o) => o.textContent)).toEqual([
      "hold: keeps the run queued until /approve",
      "start: claims the run at once (mode run)",
      "wait: claims the run after its minutes (mode run_after_minutes)",
    ]);
    expect(hold.querySelector("textarea")).toBeNull();
    expect(within(hold).queryByLabelText("hold_policy minutes")).toBeNull();
    // start writes {"mode":"run"}.
    fireEvent.change(select, { target: { value: "start" } });
    fireEvent.click(within(hold).getByRole("button", { name: "Save hold_policy" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]!.init.body as string)).toEqual({ action: "set", key: "hold_policy", value: '{"mode":"run"}' });
    // wait shows minutes at 20 and writes run_after_minutes with them.
    fireEvent.change(select, { target: { value: "wait" } });
    const minutes = within(hold).getByLabelText("hold_policy minutes") as HTMLInputElement;
    expect(minutes.value).toBe("20");
    fireEvent.change(minutes, { target: { value: "5" } });
    fireEvent.click(within(hold).getByRole("button", { name: "Save hold_policy" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(JSON.parse(posts[1]!.init.body as string)).toEqual({ action: "set", key: "hold_policy", value: '{"mode":"run_after_minutes","minutes":5}' });
  });

  it("hold_policy shows a server refusal next to the field", async () => {
    answer = { status: 400, body: { ok: false, error: "minutes must be a positive integer" } };
    const table = await show();
    const hold = rowOf(table, "hold_policy");
    fireEvent.change(within(hold).getByLabelText("hold_policy"), { target: { value: "wait" } });
    fireEvent.change(within(hold).getByLabelText("hold_policy minutes"), { target: { value: "0" } });
    fireEvent.click(within(hold).getByRole("button", { name: "Save hold_policy" }));
    expect((await within(hold).findByRole("alert")).textContent).toContain("minutes must be a positive integer");
  });

  it("in the card layout Value sits under Key and every other cell has its label", async () => {
    const wide = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    afterEachReset = () => Object.defineProperty(window, "innerWidth", { configurable: true, value: wide });
    await show().catch(() => undefined);
    const card = (await screen.findByRole("list", { name: "Settable keys" })).querySelector<HTMLElement>('li[data-key="max_loops"]')!;
    const [title, under, rest] = [...card.children] as HTMLElement[];
    expect(title!.textContent).toContain("max_loops");
    expect(within(under!).getByLabelText("max_loops")).not.toBeNull();
    expect([...rest!.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(["Source", "File value", "Applies at", "Reset"]);
  });

  it("puts the pending proposals first on the page", async () => {
    await show();
    const first = document.querySelector("section");
    expect(first?.getAttribute("aria-label")).toBe("Pending proposals");
  });
});

describe("Settings page: the typed form of the file-only keys (design 08-settings)", () => {
  const FILE_SECTION = "Change on a local branch";
  async function form() {
    await show();
    return screen.getByRole("region", { name: FILE_SECTION });
  }
  const keyOf = (section: HTMLElement, key: string) => section.querySelector<HTMLElement>(`li[data-file-key="${key}"]`)!;
  const sent = (n: number) => JSON.parse(posts[n]!.init.body as string) as { action: string; key: string; value: string; confirm: boolean };
  const filedAnswer = () => {
    answer = { status: 200, body: { ok: true, lines: ["filed"], item: "wi_9", branch: "factory/wi_9" } };
  };

  it("has a typed control for every file-only key the page edits", async () => {
    const section = await form();
    expect([...section.querySelectorAll("li[data-file-key]")].map((li) => li.getAttribute("data-file-key"))).toEqual(view.file_keys!.editable.map((e) => e.key));
    for (const li of section.querySelectorAll<HTMLElement>("li[data-file-key]")) {
      const key = li.getAttribute("data-file-key")!;
      expect(within(li).getByRole("button", { name: `Save ${key}` }), key).not.toBeNull();
    }
    // Text fields per model class; a class select per model_by role and tier, a switch for retry_up.
    expect((within(keyOf(section, "models")).getByLabelText("models strong") as HTMLInputElement).value).toBe("opus");
    const triage = within(keyOf(section, "model_by")).getByLabelText("model_by triage") as HTMLSelectElement;
    expect([...triage.options].map((o) => o.value)).toEqual(["cheap", "standard", "strong"]);
    expect((within(keyOf(section, "model_by")).getByLabelText("model_by implement 1") as HTMLSelectElement).value).toBe("standard");
    expect(within(keyOf(section, "model_by")).getByRole("switch", { name: "model_by retry_up" }).getAttribute("aria-checked")).toBe("true");
    // slack: a list editor of channels and a text field per optional member.
    expect((within(keyOf(section, "slack")).getByLabelText("slack channels 1") as HTMLInputElement).value).toBe("C1");
    expect((within(keyOf(section, "slack")).getByLabelText("slack dashboard_url") as HTMLInputElement).value).toBe("");
    // The repo commands: one line of arguments each, a quoted argument where it holds a space; check_commands a list of them.
    expect((within(keyOf(section, "repo.install_command")).getByLabelText("repo.install_command") as HTMLInputElement).value).toBe("npm ci");
    expect((within(keyOf(section, "repo.test_command")).getByLabelText("repo.test_command") as HTMLInputElement).value).toBe('sh -c "npm test"');
    expect((within(keyOf(section, "repo.check_commands")).getByLabelText("repo.check_commands 1") as HTMLInputElement).value).toBe("npm run typecheck");
    expect((within(keyOf(section, "repo.path")).getByLabelText("repo.path") as HTMLInputElement).value).toBe(".");
    // toolchain: env as KEY=VALUE lines, warm_command as arguments.
    expect((within(keyOf(section, "toolchain")).getByLabelText("toolchain env 1") as HTMLInputElement).value).toBe("CI=1");
    expect((within(keyOf(section, "toolchain")).getByLabelText("toolchain warm_command") as HTMLInputElement).value).toBe("npm ci");
    // dials, floors and permissions: typed inputs per member.
    expect((within(keyOf(section, "dials")).getByLabelText("dials spec_gate_min_tier") as HTMLInputElement).type).toBe("number");
    expect((within(keyOf(section, "floors")).getByLabelText("floors 1 prefix") as HTMLInputElement).value).toBe("prompts/");
    expect((within(keyOf(section, "floors")).getByLabelText("floors 1 tier") as HTMLInputElement).value).toBe("3");
    expect((within(keyOf(section, "permissions")).getByLabelText("permissions grants 1") as HTMLInputElement).value).toBe("static");
    expect(within(keyOf(section, "permissions")).getByLabelText("permissions static").tagName).toBe("TEXTAREA");
    // The path lists: list editors, nested for path_companions.
    expect((within(keyOf(section, "hotspot_paths")).getByLabelText("hotspot_paths 1") as HTMLInputElement).value).toBe("src/core/");
    expect(within(keyOf(section, "mechanical_paths")).getByRole("button", { name: "Add to mechanical_paths" })).not.toBeNull();
    expect((within(keyOf(section, "path_companions")).getByLabelText("path_companions 1 also 1") as HTMLInputElement).value).toBe("docs/design/");
  });

  it("the plugin select of each interface lists only its registered names; no option turns a guard off", async () => {
    const plugins = keyOf(await form(), "plugins");
    for (const p of view.file_keys!.plugins.filter((x) => x.kind !== "source")) {
      const select = within(plugins).getByLabelText(new RegExp(`^plugins ${p.kind}$`)) as HTMLSelectElement;
      expect([...select.options].filter((o) => !o.disabled).map((o) => o.value), p.kind).toEqual(p.names);
      // The file's choice; an interface the file leaves out shows the plugin in force and writes nothing until picked.
      if (p.kind === "capability") {
        expect(select.value).toBe("");
        expect(select.selectedOptions[0]!.textContent).toBe("default: bm25");
      } else expect(select.value, p.kind).toBe(p.selected);
    }
    const secrets = within(plugins).getByLabelText("plugins secrets") as HTMLSelectElement;
    expect([...secrets.options].map((o) => o.value)).not.toContain("none");
    // An interface the file lists several of is a list of selects.
    expect((within(plugins).getByLabelText("plugins source 2") as HTMLSelectElement).value).toBe("slack");
  });

  it("Save sends edit-file through the writer, then shows the branch and a Merge button that merges the item locally", async () => {
    filedAnswer();
    const section = await form();
    const hot = keyOf(section, "hotspot_paths");
    fireEvent.click(within(hot).getByRole("button", { name: "Add to hotspot_paths" }));
    fireEvent.change(within(hot).getByLabelText("hotspot_paths 2"), { target: { value: "src/ui/" } });
    await act(async () => fireEvent.click(within(hot).getByRole("button", { name: "Save hotspot_paths" })));
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
    fireEvent.click(within(hot).getByRole("button", { name: "Remove hotspot_paths 1" }));
    await act(async () => fireEvent.click(within(hot).getByRole("button", { name: "Save hotspot_paths" })));
    expect(sent(2).value).toBe("[]");
    const test = keyOf(section, "repo.test_command");
    fireEvent.change(within(test).getByLabelText("repo.test_command"), { target: { value: 'sh -c "npm run check"' } });
    await act(async () => fireEvent.click(within(test).getByRole("button", { name: "Save repo.test_command" })));
    expect(JSON.parse(sent(3).value)).toEqual(["sh", "-c", "npm run check"]);
    const slack = keyOf(section, "slack");
    fireEvent.change(within(slack).getByLabelText("slack channels 1"), { target: { value: "C2" } });
    await act(async () => fireEvent.click(within(slack).getByRole("button", { name: "Save slack" })));
    expect(JSON.parse(sent(4).value)).toEqual({ channels: ["C2"] });
    // A non-guard plugin change writes the whole plugins object, the file's other members kept, with no Dialog.
    const plugins = keyOf(section, "plugins");
    fireEvent.change(within(plugins).getByLabelText("plugins runner"), { target: { value: "fake" } });
    await act(async () => fireEvent.click(within(plugins).getByRole("button", { name: "Save plugins" })));
    expect(document.querySelector("dialog")).toBeNull();
    expect(sent(5)).toMatchObject({ key: "plugins", confirm: false });
    expect(JSON.parse(sent(5).value)).toEqual({ secrets: "env-file", runner: "fake", source: ["local", "slack"] });
  });

  it("a guard, floor, permission or dial opens the danger Dialog: Cancel sends no write request, Confirm sends the confirm flag", async () => {
    filedAnswer();
    const section = await form();
    const change: [string, () => void][] = [
      ["plugins", () => fireEvent.change(within(keyOf(section, "plugins")).getByLabelText("plugins secrets"), { target: { value: "keychain" } })],
      ["floors", () => fireEvent.change(within(keyOf(section, "floors")).getByLabelText("floors 1 tier"), { target: { value: "2" } })],
      ["permissions", () => fireEvent.click(within(keyOf(section, "permissions")).getByRole("button", { name: "Remove permissions grants 1" }))],
      ["dials", () => fireEvent.change(within(keyOf(section, "dials")).getByLabelText("dials auto_merge_max_tier"), { target: { value: "2" } })],
    ];
    for (const [key, edit] of change) {
      edit();
      await act(async () => fireEvent.click(within(keyOf(section, key)).getByRole("button", { name: `Save ${key}` })));
      const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
      expect(dialog, key).not.toBeNull();
      expect(dialog.textContent).toContain(`Change ${key}?`);
      await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" })));
      expect(document.querySelector("dialog[data-dialog]"), key).toBeNull();
      expect(posts, key).toHaveLength(0);
    }
    // Confirm sends the write with the confirm flag.
    await act(async () => fireEvent.click(within(keyOf(section, "floors")).getByRole("button", { name: "Save floors" })));
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Put on a branch" })));
    expect(posts).toHaveLength(1);
    expect(sent(0)).toEqual({ action: "edit-file", key: "floors", value: '[{"prefix":"prompts/","tier":2}]', confirm: true });
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
  });

  it("each read-only key shows its value and the line to edit the file, with no control", async () => {
    const section = await form();
    for (const { key, value } of view.file_keys!.read_only) {
      const li = section.querySelector<HTMLElement>(`li[data-read-only="${key}"]`)!;
      expect(li, key).not.toBeNull();
      expect(li.textContent).toContain(value ?? "not set");
      expect(li.textContent).toContain("Edit factory.config.json to change this.");
      expect(li.querySelectorAll("input, button, textarea, select, [role=switch]"), key).toHaveLength(0);
      expect(section.querySelector(`li[data-file-key="${key}"]`), key).toBeNull();
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

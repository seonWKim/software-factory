// @vitest-environment jsdom
// Plain words: no dashboard page prints an internal name (a snake_case code) as text. Text inside a data-raw Details,
// inside code elements, and the Data page (a developer page) are skipped. No live model or remote call: fetch is a stub.
import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

// tsconfig.test.json checks this file without JSX, so the shell fixtures (a .tsx module) load by a specifier the node check skips.
const FIXTURES = "./ui-shell-fixtures.js";
const { AT, RESPONSES, detail, items, row, installShellFixtures, mount } = (await import(/* @vite-ignore */ FIXTURES)) as {
  AT: string;
  RESPONSES: Record<string, unknown>;
  detail: { item: Record<string, unknown>; runs: Record<string, unknown>[]; timeline: Record<string, unknown>[] };
  items: { items: unknown[] };
  row: (n: number, level: string, title: string, extra?: object) => unknown;
  installShellFixtures: () => void;
  mount: () => { container: HTMLElement };
};

installShellFixtures();

const { relativeTime, termLabel, runStatusLabel } = await import("../web/src/lib/format.js");

const INTERNAL = /\b[a-z]+_[a-z_]+\b/;
const LATER = "2026-11-07T00:30:00.000Z";

/** The rendered text of a page without its data-raw Details, code elements, scripts and styles. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("[data-raw], code, script, style").forEach((n) => n.remove());
  // Text nodes joined by a space, so two neighbours never run together into one word.
  const words: string[] = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) words.push(n.textContent ?? "");
  return words.join(" ");
}

// Fixture data that holds every internal name the pages could print: field names, reason and error codes, close reasons.
Object.assign(RESPONSES, {
  "/api/v1/items": {
    ...items,
    items: [
      ...items.items,
      row(4, "closed", "Dropped", { stage: "CLOSED", blocked_on: "none", close_reason: "wont_do" }),
      row(5, "needs_you", "Agent asked", { blocked_on: "human", blocked_reason: "agent_needs_human", reason_code: "agent_needs_human", why: { code: "human", reason_code: "agent_needs_human", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
    ],
  },
  "/api/v1/items/wi_1": {
    ...detail,
    item: { ...detail.item, close_reason: "wont_do", blocked_on: "human", blocked_reason: "rule_of_two", token_cost: 1200 },
    runs: [
      ...detail.runs,
      { id: "run_d", kind: "implement", status: "succeeded", attempt: 2, started_at: AT, finished_at: LATER, created_at: AT, tokens: 5, error: null },
      { id: "run_e", kind: "implement", status: "failed", attempt: 3, started_at: AT, finished_at: LATER, created_at: AT, tokens: 5, error: { code: "spec_conflict", detail: "needs a file outside the paths" } },
    ],
    timeline: [
      ...detail.timeline,
      { version: 2, at: AT, actor: { kind: "system", id: "system" }, reason: "agent_needs_human", changes: { blocked_on: { from: '"none"', to: '"human"' }, token_cost: { from: "0", to: "1200" }, allowed_paths: { from: "[]", to: '["web/"]' }, close_reason: { from: "null", to: '"wont_do"' } }, detail: null },
    ],
  },
  "/api/v1/pauses": { pauses: [{ name: "model_stall", ends_at: LATER, since: AT }, { name: "forge_auth", ends_at: LATER }], csrf_token: "tok" },
  "/api/v1/failures": {
    as_of: AT, window: "24h", cap: 100, total: 2, capped: false,
    groups: [
      { code: "checks_failed", count: 1, last_seen: AT, items: 1, runs: [{ id: "run_f", work_item_id: "wi_1", kind: "implement", attempt: 1, detail: "npm test", worker: "host:7:0", finished_at: AT }] },
      { code: "spec_conflict", count: 1, last_seen: AT, items: 1, runs: [] },
    ],
  },
  "/api/v1/standing": { as_of: AT, csrf_token: null, rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 5, enabled: true, set_by: "local:me", created_at: AT, updated_at: AT, last_used_at: AT }], proposals: [] },
  "/api/v1/rules": { enabled: false, applied: null, error: null, csrf_token: "tok", judge: null, home: null, turn_on: null, entries: [] },
  "/api/v1/spend": { as_of: AT, today: "2026-11-07", week_start: "2026-11-02", from: "2026-11-01", to: "2026-11-07", total: { cost_usd: 1, tokens: 10, runs: 1, unknown: 0 }, days: [], items: [], items_total: 0 },
  "/api/v1/workers": { as_of: AT, workers: [{ owner: "host:7:0", running: 1 }], processes: [{ process_id: "p1", pid: 7, host: "host", slots: 1, max_slots: 2, busy: 1, idle: 0, started_at: AT, reported_at: AT, runs: [{ id: "run_a", kind: "implement", work_item_id: "wi_2", worker_id: "host:7:0", started_at: AT }] }] },
  "/api/v1/calendar": { plugins: [{ name: "gcal", connected: true, default_client: true, synced_at: AT, error: null, attempt: null }] },
  "/api/v1/calendar/events": { from: "2026-11-01", to: "2026-11-30", days: [], calendar: [] },
  "/api/v1/plugins": { as_of: AT, csrf_token: "tok", mcp: [{ name: "docs", description: "Docs.", source: "pack", status: "approved" }], skills: [], tools: [{ name: "git.store_branch", description: "Stores a branch.", read_only: false, origin: "broker", roles: [], last_used: AT }] },
  "/api/v1/settings/capabilities": { as_of: AT, roles: [], capabilities: [] },
  "/api/v1/settings": {
    as_of: AT, csrf_token: "tok", repo: "o/r", project: "r", project_keys: [],
    keys: [
      ["mode", "mode", '"manual"', "manual"], ["auto_merge_max_tier", "number", "2", "2"], ["workers", "number", "3", "1"], ["max_attempts", "number", "3", "3"], ["notice_kinds", "json", "[]", "[]"], ["quiet_hours", "text", '""', '""'],
    ].map(([key, kind, value, def]) => ({ key, description: "What the setting controls.", kind, value, source: "default", file_value: null, default_value: def, applies_at: "next claim", project_settable: false, projects: [], max: 10, capped_at: null })),
    file_keys: {
      editable: [["repo", '"o/r"'], ["dials", '{"spec_gate_min_tier":2,"auto_merge_max_tier":2}'], ["floors", "{}"], ["deny_paths", "[]"]].map(([key, value]) => ({ key, value })),
      read_only: [["store", '"local"'], ["env", '"local"'], ["state_dir", '".factory"'], ["worktrees_dir", '".worktrees"'], ["ui", '{"port":4000}'], ["cli_user", '"me"']].map(([key, value]) => ({ key, value })),
      plugins: [{ kind: "issues", interface: "IssueSource", guard: false, names: ["local", "github"], selected: "local" }, { kind: "secrets", interface: "SecretStore", guard: true, names: ["env"], selected: "env" }],
    },
    pr_only: [{ key: "max_diff_lines", description: "Largest change." }], ignored: [],
    history: [{ seq: 1, at: AT, actor: "local:me", key: "workers", project: null, old_value: "1", new_value: "3" }],
    integrations: [{ kind: "issues", interface: "IssueSource", plugin: "local", source: "config", configured: "local" }],
  },
  "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
});

const PAGES_UNDER_TEST: { name: string; path: string; ready: string }[] = [
  { name: "Tasks", path: "/app/tasks", ready: "Tasks" },
  { name: "Calendar", path: "/app/calendar", ready: "Calendar" },
  { name: "Work", path: "/app/items", ready: "Agent asked" },
  { name: "Health", path: "/app/health", ready: "Health" },
  { name: "Health, claim pauses", path: "/app/health?tab=pauses", ready: "Resume now" },
  { name: "Health, failures", path: "/app/health?tab=failures", ready: "Health" },
  { name: "Rules", path: "/app/rules", ready: "Rules" },
  { name: "Plugins", path: "/app/plugins", ready: "Plugins" },
  { name: "Settings", path: "/app/settings", ready: "Settings" },
  { name: "Settings, integrations", path: "/app/settings?tab=integrations", ready: "Settings" },
  { name: "Settings, advanced", path: "/app/settings?tab=advanced", ready: "Settings" },
  { name: "Runners", path: "/app/runners", ready: "Worker processes" },
  { name: "An item", path: "/app/items/wi_1", ready: "Spec waiting" },
];

describe("rendered page text has no internal names", () => {
  for (const p of PAGES_UNDER_TEST) {
    it(`${p.name} shows no snake_case name outside Details and code`, async () => {
      history.replaceState(null, "", p.path);
      const { container } = mount();
      await screen.findAllByText(p.ready);
      await waitFor(() => expect(container.querySelector("[aria-busy='true']")).toBeNull());
      await new Promise((r) => setTimeout(r, 100));
      expect(INTERNAL.exec(visibleText(container))?.[0] ?? null).toBeNull();
    });
  }

  it("Tasks with a model_stall pause shows it once, by its plain name, with no claim pause wording or ISO time", async () => {
    const overview = RESPONSES["/api/v1/overview"] as Record<string, unknown>;
    const before = overview.system_actions;
    overview.system_actions = [{ code: "claim_pause", text: "Model not answering", command: "Resume now in Needs you on Tasks, or factory resume model_stall", until: LATER, pause: "model_stall" }];
    try {
      history.replaceState(null, "", "/app/tasks");
      const { container } = mount();
      const row = await waitFor(() => {
        const li = container.querySelector<HTMLElement>('li[data-check="claim_pause"]');
        if (li === null) throw new Error("no pause row yet");
        return li;
      });
      await within(row).findByRole("button", { name: "Resume now" });
      await new Promise((r) => setTimeout(r, 100));
      const text = visibleText(container);
      expect(text).not.toMatch(/model_stall|Claim pause|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text.split("Model not answering")).toHaveLength(2);
      // No CLI command under the row (decision 3), so nothing hides in a code element either.
      expect(row.querySelector("code")).toBeNull();
      expect(INTERNAL.exec(text)?.[0] ?? null).toBeNull();
    } finally {
      overview.system_actions = before;
    }
  });

  it("the Data page is a developer page: it renders, and is left out of the check", async () => {
    history.replaceState(null, "", "/app/data");
    mount();
    expect((await screen.findAllByText("Data")).length).toBeGreaterThan(0);
  });

  it("the check fails on an internal name and skips data-raw Details and code", () => {
    const host = document.createElement("div");
    host.innerHTML = "<p>Waiting on a person</p><details data-raw><p>blocked_on</p></details><code>token_cost</code>";
    expect(INTERNAL.test(visibleText(host))).toBe(false);
    host.innerHTML += "<p>agent_needs_human</p>";
    expect(INTERNAL.exec(visibleText(host))?.[0]).toBe("agent_needs_human");
  });
});

describe("one relative time", () => {
  const NOW = Date.parse("2026-11-07T12:00:00.000Z");
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  it("reads just now under a minute either way, a compact span with ago or in otherwise, a dash for none", () => {
    expect(relativeTime(at(-12_000), NOW)).toBe("just now");
    expect(relativeTime(at(30_000), NOW)).toBe("just now");
    expect(relativeTime(at(-4 * 60_000), NOW)).toBe("4m ago");
    expect(relativeTime(at(4 * 60_000 + 5_000), NOW)).toBe("in 4m");
    expect(relativeTime(at(-3 * 3_600_000), NOW)).toBe("3h ago");
    expect(relativeTime(at(2 * 86_400_000), NOW)).toBe("in 2d");
    expect(relativeTime(null, NOW)).toBe("–");
  });

  it("every relative time on the item page is a time element with the exact local time in its title", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    const { container } = mount();
    await screen.findAllByText("Spec waiting");
    await waitFor(() => expect(container.querySelectorAll("time[title]").length).toBeGreaterThan(0));
    for (const el of container.querySelectorAll("time")) expect(el.getAttribute("title")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe("plain labels", () => {
  it("each internal term has its catalog label, and blocked_on reads Waiting on", () => {
    expect(termLabel("blocked_on")).toBe("Waiting on");
    expect(termLabel("agent_needs_human")).toBe("Agent needs a person");
    expect(termLabel("approve_spec")).toBe("Approve plans");
    expect(termLabel("approve_merge")).toBe("Approve merges");
    expect(termLabel("token_cost")).toBe("Tokens");
    expect(termLabel("allowed_paths")).toBe("Allowed paths");
    expect(termLabel("checks_failed")).toBe("Project checks failed");
    expect(termLabel("spec_conflict")).toBe("Plan conflicts with the rules");
    expect(termLabel("rule_of_two")).toBe("Rule of Two");
    expect(termLabel("some_other_code")).toBe("some other code");
  });

  it("a run's status reads in one form each", () => {
    expect(["succeeded", "failed", "running"].map(runStatusLabel)).toEqual(["Succeeded", "Failed", "Running"]);
  });

  it("the item page shows the labels in its timeline and the raw fields only behind Details", async () => {
    history.replaceState(null, "", "/app/items/wi_1");
    const { container } = mount();
    await screen.findAllByText("Spec waiting");
    const timeline = await screen.findByRole("heading", { name: "Timeline" }).then((h) => h.closest("section, div")!.parentElement!);
    await waitFor(() => expect(timeline.textContent).toContain("blocked_on: none → human"));
    expect(visibleText(timeline as HTMLElement)).not.toContain("1200");
    const raw = [...container.querySelectorAll("[data-raw]")].filter((d) => d.textContent?.includes("blocked_on: none → human"));
    expect(raw.length).toBe(1);
    expect(within(raw[0] as HTMLElement).getByText("Details")).toBeTruthy();
  });
});

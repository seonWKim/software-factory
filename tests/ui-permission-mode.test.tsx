// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { threadRows } from "../src/ui/thread.js";
import { SettingsPage } from "../web/src/views/settings.js";
import { Thread } from "../web/src/views/thread.js";

// Phase 2 of the permission modes (design 08-permissions): the item timeline shows the mode each owner command ran
// under, and the Settings page has one Permission mode row with three segments that writes through the settings API.

const AT = "2026-11-28T00:00:00.000Z";

const command = (id: string, extra: Record<string, unknown> = {}) => ({
  seq: 1, id, origin: "cli", command: "note", actor: "local:me", args: { text: `text ${id}` }, created_at: AT, ...extra,
});
const store = (commands: unknown[]) => ({
  listItemMessages: async () => [], listVerdicts: async () => [], listItemCommands: async () => commands,
});
const rowsFor = async (commands: unknown[]) => threadRows(store(commands) as never, "wi_1" as never, "local", async (t) => t, []);

describe("thread rows carry the stored permission mode", () => {
  it("each owner command row has the mode it ran under; a row with none has no mode field", async () => {
    const rows = await rowsFor([
      command("a", { permission_mode: "ask_all" }),
      command("b", { permission_mode: "ask_irreversible" }),
      command("c", { permission_mode: "full" }),
      command("d"),
    ]);
    expect(rows.map((r) => r.permission_mode)).toEqual(["ask_all", "ask_irreversible", "full", undefined]);
    expect("permission_mode" in rows[3]!).toBe(false);
  });
});

describe("the timeline", () => {
  const entry = (seq: number, mode?: string) => ({
    seq, at: AT, kind: "note", author: "local:me", role: "owner", channel: "cli", anchor: `command-${seq}`, body: "b",
    ...(mode ? { permission_mode: mode } : {}),
  });
  afterEach(cleanup);

  it("shows the mode on a row that has one and nothing on a row without", () => {
    render(<Thread entries={[entry(1, "ask_all"), entry(2, "full"), entry(3)]} now={Date.parse(AT)} />);
    const marks = (anchor: string) => document.getElementById(anchor)!.querySelectorAll("[data-permission-mode]");
    expect(marks("command-1")[0]!.getAttribute("data-permission-mode")).toBe("ask_all");
    expect(marks("command-1")[0]!.textContent).toBe("Ask all");
    expect(marks("command-2")[0]!.textContent).toBe("Full");
    expect(marks("command-3")).toHaveLength(0);
  });
});

describe("the Settings row", () => {
  let stored: string;
  let posts: Record<string, unknown>[];
  let refuse: string | null;
  const view = () => ({
    as_of: AT, csrf_token: "tok", repo: "o/r", project: "github.com/o/r", project_keys: [], pr_only: [],
    keys: [{
      key: "permission_mode", description: "d", kind: "text", value: stored, source: "default", file_value: null, default_value: '"ask_irreversible"',
      applies_at: "the next write", project_settable: false, projects: [],
    }],
    file_keys: { editable: [], read_only: [], plugins: [] }, ignored: [], history: [],
  });
  beforeEach(() => {
    stored = '"ask_irreversible"';
    posts = [];
    refuse = null;
    history.replaceState(null, "", "/app/settings?tab=advanced");
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
      if (init?.method === "POST") {
        expect(url).toBe("/api/v1/settings");
        const body = JSON.parse(String(init.body));
        posts.push(body);
        if (refuse) return json({ ok: false, error: refuse }, 403);
        stored = body.value;
        return json({ ok: true, lines: ["saved"] });
      }
      if (url === "/api/v1/settings") return json(view());
      if (url === "/api/v1/session") return json({ as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" });
      return json({}, 404);
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  const open = async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><SettingsPage /></QueryClientProvider>);
    const table = await screen.findByRole("table", { name: "Settable keys" });
    return table.querySelector<HTMLElement>('tr[data-key="permission_mode"]')!;
  };

  it("is one row named Permission mode with three segments in order", async () => {
    const row = await open();
    expect(row.textContent).toContain("Permission mode");
    const segments = within(within(row).getByRole("radiogroup", { name: "Permission mode" })).getAllByRole("radio");
    expect(segments.map((s) => s.textContent)).toEqual(["Ask all", "Ask irreversible", "Full"]);
    expect(segments.map((s) => s.getAttribute("aria-checked"))).toEqual(["false", "true", "false"]);
  });

  it("a press sends a set through POST /api/v1/settings and the stored value shows after the save", async () => {
    const row = await open();
    fireEvent.click(within(row).getByRole("radio", { name: "Ask all" }));
    await waitFor(() => expect(posts).toEqual([{ action: "set", key: "permission_mode", value: '"ask_all"' }]));
    await waitFor(() => expect(within(row).getByRole("radio", { name: "Ask all" }).getAttribute("aria-checked")).toBe("true"));
    expect(stored).toBe('"ask_all"');
  });

  it("shows the server's refusal on the row and stores nothing", async () => {
    refuse = "Full needs approve_merge on the project.";
    const row = await open();
    fireEvent.click(within(row).getByRole("radio", { name: "Full" }));
    expect((await within(row).findByRole("alert")).textContent).toContain("Full needs approve_merge on the project.");
    expect(stored).toBe('"ask_irreversible"');
    expect(within(row).getByRole("radio", { name: "Ask irreversible" }).getAttribute("aria-checked")).toBe("true");
  });
});

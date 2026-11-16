// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsView } from "../web/src/api.js";
import { keyLabel } from "../web/src/lib/key-label.js";

// The Settings page's Save on a file-only key, its restart note, the read-only keys and the project label control
// (design 08-settings, 2026-11-16). The page is built with createElement and loaded by a specifier the node
// typecheck skips, as in tests/ui-settings-page.test.tsx.
const PAGE_MODULE = "../web/src/views/settings.js";
const { SettingsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SettingsPage: FunctionComponent };

const TOKEN = "tok_save";
const READ_ONLY = ["store", "env", "state_dir", "worktrees_dir", "ui", "outbound.batching", "cli_user"];

function viewOf(project: string | null): SettingsView {
  return {
    as_of: "2026-11-16T00:00:00.000Z",
    csrf_token: TOKEN,
    repo: "o/r",
    project,
    project_keys: ["max_attempts"],
    keys: [
      {
        key: "max_attempts", description: "attempts", kind: "number", value: "3", source: "file", file_value: "3", default_value: "3",
        applies_at: "the next claim", project_settable: true, projects: [],
      },
    ],
    pr_only: [{ key: "auth", description: "auth" }],
    file_keys: {
      editable: [
        { key: "hotspot_paths", value: '["src/core/"]' },
        { key: "repo.path", value: null },
        { key: "floors", value: '[{"prefix":"prompts/","tier":3}]' },
      ],
      read_only: READ_ONLY.map((key) => ({ key, value: key === "outbound.batching" ? null : '"x"' })),
      plugins: [],
    },
    ignored: [],
    history: [],
  };
}

let view: SettingsView;
let posts: unknown[] = [];
let answer: { status: number; body: unknown };

beforeEach(() => {
  view = viewOf("github.com/o/r");
  posts = [];
  answer = { status: 200, body: { ok: true, lines: ["filed"], item: "wi_1", branch: "factory/wi_1" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (init?.method === "POST") {
      posts.push(JSON.parse(init.body as string));
      return json(answer.body, answer.status);
    }
    if (url === "/api/v1/settings") return json(view);
    if (url.startsWith("/api/v1/items/")) return json({ item: { merge: { enabled: true, reason: null } } });
    if (url === "/api/v1/session") return json({ commands_enabled: true, actor: "local:me", actor_source: "environment" });
    if (url === "/api/v1/settings/capabilities") return json({ as_of: "", roles: [], capabilities: [] });
    return new Response("{}", { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

async function form(): Promise<HTMLElement> {
  history.replaceState(null, "", "/app/settings?tab=advanced");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(SettingsPage)));
  await screen.findByRole("table", { name: "Settable keys" });
  return screen.getByRole("region", { name: "Change on a local branch" });
}

const keyOf = (section: HTMLElement, key: string) => section.querySelector<HTMLElement>(`li[data-file-key="${key}"]`)!;
const dialog = () => document.querySelector<HTMLElement>("dialog[data-dialog]");

/** Adds src/ui/ to hotspot_paths and presses Save. */
async function editHotspots(section: HTMLElement) {
  const hot = keyOf(section, "hotspot_paths");
  fireEvent.click(within(hot).getByRole("button", { name: `Add to ${keyLabel("hotspot_paths")}` }));
  fireEvent.change(within(hot).getByLabelText(`${keyLabel("hotspot_paths")} 2`), { target: { value: "src/ui/" } });
  await act(async () => fireEvent.click(within(hot).getByRole("button", { name: `Save ${keyLabel("hotspot_paths")}` })));
}

describe("Save on a file-only key asks first", () => {
  it("opens the confirm Dialog with the key, its old and its new value; Cancel posts nothing", async () => {
    const section = await form();
    await editHotspots(section);
    const d = dialog()!;
    expect(d).not.toBeNull();
    expect(d.textContent).toContain("Change Hotspot paths?");
    expect(JSON.parse(d.querySelector("[data-old-value]")!.textContent!)).toEqual(["src/core/"]);
    expect(JSON.parse(d.querySelector("[data-new-value]")!.textContent!)).toEqual(["src/core/", "src/ui/"]);
    expect(posts).toEqual([]);
    await act(async () => fireEvent.click(within(d).getByRole("button", { name: "Cancel" })));
    expect(dialog()).toBeNull();
    expect(posts).toEqual([]);
  });

  it("a key the file leaves out shows its old value as not set", async () => {
    const section = await form();
    const path = keyOf(section, "repo.path");
    fireEvent.change(within(path).getByLabelText(`${keyLabel("repo.path")}`), { target: { value: "app" } });
    await act(async () => fireEvent.click(within(path).getByRole("button", { name: `Save ${keyLabel("repo.path")}` })));
    expect(dialog()!.querySelector("[data-old-value]")!.textContent).toBe("not set");
    expect(dialog()!.querySelector("[data-new-value]")!.textContent).toBe('"app"');
  });

  it("Put on a branch sends the edit without the confirm flag, then closes the Dialog", async () => {
    const section = await form();
    await editHotspots(section);
    await act(async () => fireEvent.click(within(dialog()!).getByRole("button", { name: "Put on a branch" })));
    expect(posts).toEqual([{ action: "edit-file", key: "hotspot_paths", value: '["src/core/","src/ui/"]', confirm: false }]);
    expect(dialog()).toBeNull();
  });

  it("a floor asks in the danger Dialog and sends confirm true only on Confirm", async () => {
    const section = await form();
    const floors = keyOf(section, "floors");
    fireEvent.change(within(floors).getByLabelText(`${keyLabel("floors")} 1 tier`), { target: { value: "2" } });
    await act(async () => fireEvent.click(within(floors).getByRole("button", { name: `Save ${keyLabel("floors")}` })));
    expect(dialog()!.textContent).toContain("sets a guard, floor, permission or dial");
    await act(async () => fireEvent.click(within(dialog()!).getByRole("button", { name: "Cancel" })));
    expect(posts).toEqual([]);
    await act(async () => fireEvent.click(within(floors).getByRole("button", { name: `Save ${keyLabel("floors")}` })));
    expect(JSON.parse(dialog()!.querySelector("[data-old-value]")!.textContent!)).toEqual([{ prefix: "prompts/", tier: 3 }]);
    await act(async () => fireEvent.click(within(dialog()!).getByRole("button", { name: "Put on a branch" })));
    expect(posts).toEqual([{ action: "edit-file", key: "floors", value: '[{"prefix":"prompts/","tier":2}]', confirm: true }]);
  });
});

describe("the restart note and the read-only keys", () => {
  it("each file-only key the page edits says it applies at the next start, after the merge, with no Restart now button", async () => {
    const section = await form();
    for (const { key } of view.file_keys!.editable) {
      const li = keyOf(section, key);
      expect(li.querySelector("[data-restart-note]")!.textContent, key).toBe("Applies at the next start, after the merge.");
      expect(within(li).queryByRole("button", { name: /restart/i }), key).toBeNull();
    }
  });

  it("each of the seven read-only keys shows its value and reason, and no file path or command", async () => {
    const section = await form();
    const items = [...section.querySelectorAll<HTMLElement>("li[data-read-only]")];
    expect(items.map((li) => li.getAttribute("data-read-only"))).toEqual(READ_ONLY);
    for (const li of items) {
      const key = li.getAttribute("data-read-only")!;
      expect(li.textContent, key).toContain(key === "outbound.batching" ? "not set" : '"x"');
      expect(li.querySelector("p")!.textContent!.length, key).toBeGreaterThan(0);
      expect(li.textContent, key).not.toContain("factory.config.json");
      expect(li.textContent, key).not.toContain("factory settings");
    }
    // The section intro names no file either.
    expect(section.querySelector("p")!.textContent).not.toContain("factory.config.json");
  });
});

describe("the project label control", () => {
  const input = () => screen.getByLabelText("Project label for o/r") as HTMLInputElement;
  const save = () => act(async () => fireEvent.click(screen.getByRole("button", { name: "Save Project label for o/r" })));

  it("shows the stored label and saves a new one through the project-label write", async () => {
    answer = { status: 200, body: { ok: true, lines: ["project label of o/r = ghe.example.com/o/r"] } };
    await form();
    expect(input().value).toBe("github.com/o/r");
    fireEvent.change(input(), { target: { value: "ghe.example.com/o/r" } });
    await save();
    expect(posts).toEqual([{ action: "project-label", value: "ghe.example.com/o/r" }]);
    expect(await screen.findByText("project label of o/r = ghe.example.com/o/r")).not.toBeNull();
  });

  it("shows the server's refusal under the field, and the no-label line names no command", async () => {
    view = viewOf(null);
    answer = { status: 422, body: { error: "refused: no project key is stored for o/r yet" } };
    await form();
    expect(input().value).toBe("");
    const row = screen.getByRole("table", { name: "Settable keys" }).querySelector<HTMLElement>('tr[data-key="max_attempts"]')!;
    expect(row.textContent).toContain("no project label stored yet");
    expect(row.textContent).not.toContain("factory settings");
    fireEvent.change(input(), { target: { value: "github.com/o/r" } });
    await save();
    const form_ = document.querySelector<HTMLElement>("form[data-project-label]")!;
    expect(within(form_).getByRole("alert").textContent).toBe("refused: no project key is stored for o/r yet");
  });
});

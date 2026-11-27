// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW, json } from "./ui-evals-fixtures.js";

const INTEGRATIONS_MODULE = "../web/src/views/settings/integrations.js";
const { IntegrationsTab } = (await import(/* @vite-ignore */ INTEGRATIONS_MODULE)) as { IntegrationsTab: FunctionComponent<{ view: unknown }> };

// Integrations: the eval source keeps its Switch; on opens its own Dialog naming agents-home, off resets the entry.
describe("Integrations: the eval source switch", () => {
  const settingsView = (entry: Record<string, string> | null) => ({
    csrf_token: "tok_s",
    keys: [{ key: "integrations", kind: "json", value: entry === null ? "{}" : JSON.stringify(entry), source: entry === null ? "default" : "override", file_value: null, default_value: "{}", applies_at: "", description: "", project_settable: false, projects: [] }],
    integrations: [
      { kind: "tacit", interface: "TacitLedger", plugin: entry?.tacit ?? "none", source: entry?.tacit ? "setting" : "config", configured: "none" },
      { kind: "eval_source", interface: "SkillEvalSource", plugin: entry?.eval_source ?? "none", source: entry?.eval_source ? "setting" : "config", configured: "none" },
    ],
  });
  let posts: unknown[] = [];
  beforeEach(() => {
    posts = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)));
        return json(200, { lines: ["ok"] });
      }
      return json(404, { error: "Not found." });
    }));
  });
  const showTab = (entry: Record<string, string> | null) =>
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(IntegrationsTab, { view: settingsView(entry) })));

  it("turning it on opens a Dialog naming agents-home, whose confirm sets eval_source in the entry", async () => {
    showTab({ tacit: "agents-home" });
    fireEvent.click(screen.getByRole("switch", { name: "Integration: SkillEvalSource" }));
    const d = await screen.findByRole("dialog", undefined, SLOW);
    expect(d.textContent).toContain("agents-home");
    expect(d.textContent).not.toMatch(/rule/i);
    fireEvent.click(within(d).getByRole("button", { name: "Turn on" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toMatchObject({ action: "set", key: "integrations" });
    expect(JSON.parse((posts[0] as { value: string }).value)).toEqual({ tacit: "agents-home", eval_source: "agents-home" });
  });

  it("turning it off resets the entry", async () => {
    showTab({ eval_source: "agents-home" });
    fireEvent.click(screen.getByRole("switch", { name: "Integration: SkillEvalSource" }));
    await vi.waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toMatchObject({ action: "reset", key: "integrations" });
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

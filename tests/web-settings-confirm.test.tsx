// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

type Body = { action: "set"; key: string; value: string } | { action: "reset"; key: string } | { action: "edit-file"; key: string; value: string; confirm: boolean } | { action: "project-label"; value: string };

// Loaded by a specifier the node typecheck skips, as in tests/ui-settings-page.test.tsx.
const MODULE = "../web/src/views/settings-file-keys.js";
const { Outcome, useWrite } = (await import(/* @vite-ignore */ MODULE)) as {
  Outcome: FunctionComponent<{ error: string | null; done: string | null }>;
  useWrite: (token: string) => { done: string | null; error: string | null; write: (body: Body) => Promise<boolean> };
};

// The confirmation after a Settings write is composed from the request (the key's label and the value sent), never
// the CLI line the API returns (design 09-dashboard-settings). A fetch stub answers; no live call.
const CLI_LINE = 'quiet_hours = "23:00-06:00" (override; was "", default)';
const SNAKE = /[a-z]+_[a-z]+/;

function Probe({ body }: { body: Body }) {
  const { done, error, write } = useWrite("tok");
  return createElement("div", null, createElement("button", { onClick: () => void write(body) }, "go"), createElement(Outcome, { error, done }));
}

async function confirm(body: Body): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true, lines: [CLI_LINE] }), { status: 200, headers: { "content-type": "application/json" } })));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(Probe, { body })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "go" })));
  return (await screen.findByRole("status")).textContent ?? "";
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Settings confirmations", () => {
  it("a set names the label and the value in plain words", async () => {
    const text = await confirm({ action: "set", key: "quiet_hours", value: JSON.stringify("23:00-06:00") });
    expect(text).toBe("Quiet hours saved: 23:00-06:00");
    expect(text).not.toMatch(SNAKE);
    expect(text).not.toMatch(/override|default\)|source|"/);
  });

  it("a reset says the setting is back to the default", async () => {
    const text = await confirm({ action: "reset", key: "quiet_hours" });
    expect(text).toBe("Quiet hours back to the default.");
    expect(text).not.toMatch(SNAKE);
  });

  it("a file-only key save says it applies once merged", async () => {
    const text = await confirm({ action: "edit-file", key: "hotspot_paths", value: '["src/"]', confirm: false });
    expect(text).toBe("Hotspot paths saved. It applies once you merge it.");
    expect(text).not.toMatch(SNAKE);
  });

  it("a project label save reads plainly", async () => {
    expect(await confirm({ action: "project-label", value: "github.com/o/r" })).toBe("Project label saved.");
  });
});

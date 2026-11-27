// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The chat panel is the Chat page (web/src/views/chat-page.tsx) and its transcript dialog (chat-card.tsx).
const PAGE_MODULE = "../web/src/views/chat-page.js";
const { ChatPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { ChatPage: FunctionComponent };

const REPLY = "Done.\n\n```ts\nconst a = 1;\n```";
const SLOW = { timeout: 5_000 };
const AT = "2026-11-27T10:00:00.000Z";
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let writes: string[];

beforeEach(() => {
  writes = [];
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => void writes.push(v) } });
  history.replaceState(null, "", "/app/chat");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    if (u.pathname === "/api/v1/session") return json(200, { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:owner", actor_source: "environment" });
    if (u.pathname === "/api/v1/chat/send" && init?.method === "POST") return json(200, { turn_id: "ct_1", session_id: "cs_1", outcome: "answered", reply: REPLY });
    if (u.pathname === "/api/v1/items") return json(200, { as_of: AT, total: 0, items: [], facets: {}, counts: {} });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "clipboard");
});

const ask = async (text: string) => {
  render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(ChatPage)));
  fireEvent.change((await screen.findByLabelText("Your message")) as HTMLTextAreaElement, { target: { value: text } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
  fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter" });
  await screen.findByRole("button", { name: "Copy reply" }, SLOW);
};

describe("Copy in the chat panel", () => {
  it("Copy reply writes the stored reply and Copy your message the typed text", async () => {
    await ask("Fix it");
    fireEvent.click(screen.getByRole("button", { name: "Copy your message" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() => expect(writes).toEqual(["Fix it", REPLY]), SLOW);
    await waitFor(() => expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain("Copied"));
  });

  it("every Copy is a ghost Button and Send is the one primary Button", async () => {
    await ask("Fix it");
    const copies = screen.getAllByRole("button", { name: /^Copy/ });
    expect(copies.length).toBeGreaterThanOrEqual(3);
    const send = screen.getByRole("button", { name: "Send" });
    for (const c of copies) expect(c.className).not.toBe(send.className);
    expect(within(document.body).getAllByRole("button", { name: "Send" })).toHaveLength(1);
  });

  it("adds no fetch of its own and reads and writes through the generated client", () => {
    for (const f of ["web/src/views/chat-page.tsx", "web/src/views/chat-card.tsx"]) {
      const source = readFileSync(f, "utf8");
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).toContain('from "../api/generated.js"');
    }
  });
});

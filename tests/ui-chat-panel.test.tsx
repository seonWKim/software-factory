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

// New chat and Recent: earlier sessions come from chat.turns (grouped by session_id) and Open loads chat.transcript.
describe("New chat and Recent", () => {
  let sends: { session_id?: string; text: string }[];
  let calls: string[];
  let turns: Record<string, unknown>[];
  let turnsStatus: number;
  const turn = (n: number, session: string, status: string, reason: string | null) => ({ turn_id: `ct_${n}`, session_id: session, status, reason, created_at: AT, finished_at: AT });

  beforeEach(() => {
    sends = [];
    calls = [];
    turnsStatus = 200;
    turns = [turn(3, "cs_a", "answered", null), turn(2, "cs_b", "refused", "withheld"), turn(1, "cs_a", "failed", "model_error")];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://127.0.0.1");
      calls.push(`${u.pathname}${u.search}`);
      if (u.pathname === "/api/v1/session") return json(200, { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:owner", actor_source: "environment" });
      if (u.pathname === "/api/v1/chat/turns") return turnsStatus === 200 ? json(200, { turns }) : json(500, { error: "boom" });
      if (u.pathname === "/api/v1/chat/transcript") {
        return json(200, { messages: [
          { seq: 0, role: "user", content: "About item: “X”, state Running, stage implement.\n\nWhat is this?" },
          { seq: 1, role: "tool", content: "{}" },
          { seq: 2, role: "assistant", content: "A build task." },
        ] });
      }
      if (u.pathname === "/api/v1/chat/send" && init?.method === "POST") {
        sends.push(JSON.parse(String(init.body)));
        return json(200, { turn_id: "ct_n", session_id: "cs_new", outcome: "answered", reply: "Fine." });
      }
      return json(404, { error: "Not found." });
    }));
  });

  const mount = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(ChatPage)));
  const openFirst = async () => {
    fireEvent.click((await screen.findAllByRole("button", { name: /^Actions for the chat/ }, SLOW))[0] as HTMLElement);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open" }));
    await screen.findByText("A build task.", {}, SLOW);
  };

  it("lists each session once with its latest outcome, one chatTurns read of 50, and no ID", async () => {
    mount();
    expect(await screen.findByRole("heading", { name: "Recent" }, SLOW)).toBeTruthy();
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(2), SLOW);
    const list = [...document.querySelectorAll("[data-list-row]")];
    expect(list[0]?.textContent).toContain("Answered");
    expect(list[1]?.textContent).toContain("Held back");
    expect(list[1]?.textContent).toContain("private");
    expect(document.body.textContent).not.toMatch(/cs_|ct_/);
    expect(calls.filter((c) => c.startsWith("/api/v1/chat/turns"))).toEqual(["/api/v1/chat/turns?limit=50"]);
  });

  it("Open loads the stored messages in order without the context line, and the next send carries its session_id", async () => {
    mount();
    await openFirst();
    const items = screen.getAllByRole("listitem").filter((li) => li.hasAttribute("data-from"));
    expect(items.map((li) => li.getAttribute("data-from"))).toEqual(["you", "chat"]);
    expect(items[0]?.textContent).toContain("What is this?");
    expect(items[0]?.textContent).not.toContain("About item");
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "More" } });
    fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter" });
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]?.session_id).toBe("cs_a");
  });

  it("New chat clears the messages, the typed text and the session", async () => {
    mount();
    await openFirst();
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "draft" } });
    // The page draws no title (only an sr-only h1): New chat sits in its own action row at the top.
    const actions = document.querySelector("[data-chat-actions]") as HTMLElement;
    const newChat = within(actions).getByRole("button", { name: "New chat" });
    expect(newChat.className).toContain("border-border-strong"); // the secondary variant
    // New chat is the row's one control: no PageHeader, no close Button.
    expect(within(actions).getAllByRole("button")).toEqual([newChat]);
    expect(actions.querySelector("header, h1, h2")).toBeNull();
    // The Recent search shows on the empty page only.
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /^close/i })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 }).className).toContain("sr-only");
    fireEvent.click(newChat);
    await screen.findByRole("heading", { name: "Recent" }, SLOW);
    expect((screen.getByRole("searchbox", { name: "Search recent chats" }) as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Your message") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("A build task.")).toBeNull();
    fireEvent.change(screen.getByLabelText("Your message"), { target: { value: "Hi" } });
    fireEvent.keyDown(screen.getByLabelText("Your message"), { key: "Enter" });
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]).toEqual({ text: "Hi" });
  });

  it("shows a Loading placeholder while the read is in flight", async () => {
    let release = () => {};
    const gate = new Promise<void>((r) => { release = r; });
    const inner = vi.mocked(fetch).getMockImplementation()!;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/api/v1/chat/turns")) await gate;
      return inner(url, init);
    }));
    mount();
    expect(await screen.findByRole("heading", { name: "Recent" }, SLOW)).toBeTruthy();
    expect(await screen.findByLabelText("Recent chats", { selector: "[aria-busy=true]" }, SLOW)).toBeTruthy();
    release();
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(2), SLOW);
    expect(document.querySelector("[aria-busy=true]")).toBeNull();
  });

  it("says so with no sessions and in plain words when the read fails", async () => {
    turns = [];
    mount();
    expect(await screen.findByText("No earlier chats yet", {}, SLOW)).toBeTruthy();
    cleanup();
    turnsStatus = 500;
    mount();
    expect(await screen.findByText(/recent chats/i, {}, SLOW)).toBeTruthy();
    expect(document.body.textContent).not.toContain("boom");
  });

  it("filters the loaded sessions by preview in the browser, at most 10, with no new chatTurns read", async () => {
    turns = [
      { ...turn(3, "cs_a", "answered", null), preview: "Why did the Deploy fail?" },
      { ...turn(2, "cs_b", "refused", "withheld"), preview: "What did it cost?" },
      { ...turn(1, "cs_a", "failed", "model_error"), preview: "Why did the Deploy fail?" },
      ...Array.from({ length: 12 }, (_, n) => ({ ...turn(10 + n, `cs_m${n}`, "answered", null), preview: `deploy note ${n}` })),
    ];
    mount();
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(10), SLOW);
    const search = screen.getByRole("searchbox", { name: "Search recent chats" }) as HTMLInputElement;
    expect(search.placeholder).toBe("Search by first question");
    // The field sits in the page's top action row beside New chat, never inside the Recent card (patterns.md).
    const row = document.querySelector("[data-chat-actions]")!;
    expect(row.contains(search)).toBe(true);
    expect(row.contains(screen.getByRole("button", { name: "New chat" }))).toBe(true);
    expect(screen.getByRole("heading", { name: "Recent" }).closest("section")?.contains(search)).toBe(false);
    fireEvent.change(search, { target: { value: "COST" } });
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(1));
    expect(document.querySelector("[data-list-row]")?.textContent).toContain("What did it cost?");
    fireEvent.change(search, { target: { value: "deploy" } });
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(10));
    expect(document.querySelector("[data-list-row]")?.textContent).toContain("Why did the Deploy fail?");
    expect(calls.filter((c) => c.startsWith("/api/v1/chat/turns"))).toEqual(["/api/v1/chat/turns?limit=50"]);
    expect(screen.queryByRole("button", { name: /show more/i })).toBeNull();
  });

  it("shows an EmptyState in the card when nothing matches, and the list again when cleared", async () => {
    turns = [{ ...turn(3, "cs_a", "answered", null), preview: "Why did it fail?" }, { ...turn(2, "cs_b", "answered", null), preview: null }];
    mount();
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(2), SLOW);
    const search = screen.getByRole("searchbox", { name: "Search recent chats" });
    fireEvent.change(search, { target: { value: "zebra" } });
    const empty = await screen.findByText("No chat matches “zebra”");
    expect(empty.closest("[data-empty]")).toBeTruthy();
    expect(document.querySelectorAll("[data-list-row]")).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Recent" }).closest("section")?.contains(empty)).toBe(true);
    fireEvent.change(search, { target: { value: "" } });
    await waitFor(() => expect(document.querySelectorAll("[data-list-row]")).toHaveLength(2));
  });

  it("keeps the context-line rule in one place: chat.turns and the page reuse withoutContext", () => {
    const rule = "(?:Open page|About item)";
    for (const f of ["src/api/capabilities/chat.ts", "web/src/views/chat-card.tsx", "web/src/views/chat-page.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toContain(rule);
    }
    expect(readFileSync("src/shared/chat-context.ts", "utf8")).toContain(rule);
    expect(readFileSync("src/api/capabilities/chat.ts", "utf8")).toContain("withoutContext(");
  });

  it("draws the search with Input and the rows with ListRow and EmptyState only", () => {
    const source = readFileSync("web/src/views/chat-page.tsx", "utf8");
    expect(source).toContain('from "../components/ui/input.js"');
    expect(source).toMatch(/<Input\b[^>]*type="search"/);
    expect(source).not.toMatch(/<input\b/);
  });

  it("uses its own query key and leaves the Chat Card's key and limit alone", () => {
    expect(readFileSync("web/src/views/chat-page.tsx", "utf8")).toContain('queryKey: ["chat", "recent"]');
    expect(readFileSync("web/src/views/chat-card.tsx", "utf8")).toContain('queryKey: ["chat", "turns"], queryFn: () => chatTurns({ limit: 10 })');
  });
});

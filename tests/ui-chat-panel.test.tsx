// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// tsconfig.test.json checks this file without JSX, so the components are built with createElement and their .tsx
// modules are loaded by specifiers the node check skips (as tests/ui-calendar-page.test.tsx does).
const APP_MODULE = "../web/src/App.js";
const PANEL_MODULE = "../web/src/views/chat-panel.js";
const PAGES_MODULE = "../web/src/views/pages.js";
const { App } = (await import(/* @vite-ignore */ APP_MODULE)) as { App: FunctionComponent };
const { ChatPanel } = (await import(/* @vite-ignore */ PANEL_MODULE)) as { ChatPanel: FunctionComponent<{ open: boolean; onClose: () => void; page: string; itemId: string | null }> };
const { RunnersTab } = (await import(/* @vite-ignore */ PAGES_MODULE)) as { RunnersTab: FunctionComponent };

// The chat side panel and the Runners tab's Chat Card (design 09-dashboard-chat) over a faked server that answers
// the generated client's routes: chat.send, chat.turns, chat.transcript and the items list.

const TOKEN = "tok_chat";
const SLOW = { timeout: 5_000 };
const AT = "2026-11-26T10:00:00.000Z";
const ITEM = "wi_item_abc123";
const REPLY = "This is a build task.\n\n```diff\n- old line\n+ new line\n```\n\n| Name | State |\n|---|---|\n| Alpha | Running |";

let sends: { token: string | null; body: { session_id?: string; text: string } }[];
let turns: Record<string, unknown>[];
let sendStatus: number;
let sendBody: Record<string, unknown>;
let fetched: string[];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const item = { id: ITEM, title: "Add a chat panel", state_label: "Running", stage: "implement" };

beforeEach(() => {
  sends = [];
  fetched = [];
  sendStatus = 200;
  sendBody = { turn_id: "ct_1", session_id: "cs_1", outcome: "answered", reply: REPLY };
  turns = [
    { turn_id: "ct_run", session_id: "cs_run", status: "running", reason: null, created_at: AT, finished_at: null },
    { turn_id: "ct_ok", session_id: "cs_ok", status: "answered", reason: null, created_at: AT, finished_at: AT },
    { turn_id: "ct_held", session_id: "cs_held", status: "refused", reason: "withheld", created_at: AT, finished_at: AT },
  ];
  history.replaceState(null, "", "/app/");
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    fetched.push(`${init?.method ?? "GET"} ${u.pathname}`);
    if (u.pathname === "/api/v1/session") return json(200, { as_of: AT, csrf_token: TOKEN, commands_enabled: true, actor: "local:owner", actor_source: "environment" });
    if (u.pathname === "/api/v1/chat/send" && init?.method === "POST") {
      sends.push({ token: new Headers(init.headers).get("x-csrf-token"), body: JSON.parse(String(init.body)) });
      return json(sendStatus, sendBody);
    }
    if (u.pathname === "/api/v1/chat/turns") return json(200, { turns });
    if (u.pathname === "/api/v1/chat/transcript") {
      return json(200, { messages: [
        { seq: 0, role: "user", content: `Open page: Work.\n\nWhat is this?` },
        { seq: 1, role: "assistant", content: "A build task." },
      ] });
    }
    if (u.pathname === "/api/v1/items") return json(200, { as_of: AT, total: 1, items: [item], facets: {}, counts: {} });
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const wrap = (child: ReturnType<typeof createElement>) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, child);
const panel = (itemId: string | null = ITEM) => render(wrap(createElement(ChatPanel, { open: true, onClose: () => {}, page: "Work", itemId })));
const ask = async (text: string) => {
  fireEvent.change(await screen.findByLabelText("Your message"), { target: { value: text } });
  await waitFor(() => expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("Chat button and side panel", () => {
  it("a Chat button in the top bar opens the panel beside the page, which stays visible", async () => {
    render(wrap(createElement(App)));
    expect(document.querySelector("[data-chat-panel]")).toBeNull();
    const header = document.querySelector("header") as HTMLElement;
    fireEvent.click(within(header).getByRole("button", { name: "Chat" }));
    const aside = (await screen.findByRole("complementary", { name: "Chat" })) as HTMLElement;
    // A side panel, not a modal: the page behind is still in the document and not inert.
    expect(document.querySelector("main")).not.toBeNull();
    expect(document.querySelector("dialog[open]")).toBeNull();
    expect(aside.parentElement).toBe((document.querySelector("main") as HTMLElement).parentElement?.parentElement);
    fireEvent.click(within(aside).getByRole("button", { name: "Close chat" }));
    expect(document.querySelector("[data-chat-panel]")).toBeNull();
  });

  it("lays out PageHeader, then a Card holding the conversation, the Textarea and the Button", async () => {
    panel();
    const aside = (await screen.findByRole("complementary", { name: "Chat" })) as HTMLElement;
    const header = aside.querySelector("header[data-page-width]") as HTMLElement;
    expect(within(header).getByRole("heading", { level: 1, name: "Chat" })).toBeTruthy();
    const card = within(aside).getByRole("region", { name: "Conversation" });
    expect(header.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const list = within(card).getByRole("list", { name: "Conversation" });
    const field = within(card).getByLabelText("Your message");
    const send = within(card).getByRole("button", { name: "Send" });
    expect(field.tagName).toBe("TEXTAREA");
    expect(list.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(field.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("sending a message", () => {
  it("carries the open page and item: title, state and stage, with the session's token", async () => {
    panel();
    await ask("What is this?");
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    const sent = sends[0]!;
    expect(sent.token).toBe(TOKEN);
    expect(sent.body.text).toContain("Open page: Work.");
    expect(sent.body.text).toContain("Add a chat panel");
    expect(sent.body.text).toContain("state Running");
    expect(sent.body.text).toContain("stage implement");
    expect(sent.body.text.endsWith("What is this?")).toBe(true);
    expect(sent.body.session_id).toBeUndefined();
    await screen.findByText("This is a build task.", {}, SLOW);
    // The next message continues the session.
    await ask("And now?");
    await waitFor(() => expect(sends).toHaveLength(2), SLOW);
    expect(sends[1]!.body.session_id).toBe("cs_1");
  });

  it("with no open item, the message carries the page only and reads no items", async () => {
    panel(null);
    await ask("Hello");
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]!.body.text).toContain("Open page: Work.");
    expect(sends[0]!.body.text).not.toContain("Open item");
    expect(fetched).not.toContain("GET /api/v1/items");
  });

  it("shows plain words as text and a code block or a table inside a Card", async () => {
    panel();
    await ask("Show me");
    await screen.findByText("This is a build task.", {}, SLOW);
    const code = screen.getByRole("region", { name: "Code in the reply" });
    expect(code.querySelector("pre")?.className).toContain("font-mono");
    expect(code.querySelector("pre")?.className).toContain("text-xs");
    expect(code.textContent).toContain("+ new line");
    expect(code.textContent).not.toContain("```");
    const table = screen.getByRole("region", { name: "Table in the reply" });
    expect(within(table).getByText("Alpha")).toBeTruthy();
    expect(table.textContent).not.toContain("|");
    // The plain sentence is not in a Card of its own.
    expect(screen.getByText("This is a build task.").closest("section")?.getAttribute("aria-label")).toBe("Conversation");
  });

  it("says so when no model is set up, and when the chat holds an answer back", async () => {
    sendStatus = 503;
    sendBody = { error: "Chat is off: no model is configured (plugins.llm)." };
    panel();
    await ask("Hi");
    await screen.findByText(/Chat is off: no model is set up yet/, {}, SLOW);
    cleanup();
    sendStatus = 200;
    sendBody = { turn_id: "ct_2", session_id: "cs_2", outcome: "refused", reason: "withheld" };
    panel();
    await ask("Hi");
    await screen.findByText(/held something private/, {}, SLOW);
  });
});

describe("the Runners tab's Chat Card", () => {
  it("shows the activity, recent turns with outcome and reason, and no raw ID", async () => {
    render(wrap(createElement(RunnersTab)));
    const card = await screen.findByRole("region", { name: "Chat" }, SLOW);
    await within(card).findByText("Answering 1 question now.", {}, SLOW);
    const table = within(card).getByRole("table", { name: "Recent chat turns" });
    expect(within(table).getByText("Answered")).toBeTruthy();
    expect(within(table).getByText("Held back")).toBeTruthy();
    expect(within(table).getByText(/held something private/)).toBeTruthy();
    expect(within(table).getAllByRole("button", { name: "Transcript" })).toHaveLength(3);
    for (const id of ["ct_run", "cs_ok", "ct_held", ITEM]) expect(document.body.textContent).not.toContain(id);
  });

  it("opens a turn's Transcript in a Dialog, without IDs", async () => {
    render(wrap(createElement(RunnersTab)));
    const card = await screen.findByRole("region", { name: "Chat" }, SLOW);
    const buttons = await within(card).findAllByRole("button", { name: "Transcript" }, SLOW);
    fireEvent.click(buttons[1]!);
    const dialog = await screen.findByRole("dialog", {}, SLOW);
    expect(within(dialog).getByRole("heading", { name: "Chat transcript" })).toBeTruthy();
    await within(dialog).findByText("What is this?", {}, SLOW);
    expect(within(dialog).getByText("A build task.")).toBeTruthy();
    // The context line each message starts with is not shown back.
    expect(dialog.textContent).not.toContain("Open page");
    expect(dialog.textContent).not.toContain("cs_ok");
  });

  it("says in plain words when the turns cannot load, without the address it asked", async () => {
    const base = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) =>
      String(url).includes("/api/v1/chat/turns") ? new Response(JSON.stringify({ error: "Not found." }), { status: 404 }) : base(url, init)));
    render(wrap(createElement(RunnersTab)));
    const card = await screen.findByRole("region", { name: "Chat" }, SLOW);
    const alert = await within(card).findByRole("alert", {}, SLOW);
    expect(alert.textContent).toBe("Could not load: recent chat turns");
    expect(card.textContent).not.toMatch(/\/api\/|HTTP|limit/);
  });

  it("is part of Health's Runners tab", () => {
    expect(readFileSync("web/src/views/pages.tsx", "utf8")).toMatch(/<ChatCard \/>/);
  });
});

describe("the typed client only", () => {
  const source = readFileSync("web/src/views/chat-panel.tsx", "utf8");
  it("calls no fetch of its own and reads and writes through the generated client", () => {
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/XMLHttpRequest|postJson|getJson/);
    for (const name of ["chatSend", "chatTurns", "chatTranscript"]) expect(source).toContain(name);
    expect(source).toContain('from "../api/generated.js"');
  });

  it("names no ID field in its texts", () => {
    expect(readFileSync("web/src/i18n/en/chat.ts", "utf8")).not.toMatch(/turn_id|session_id|item_id/);
  });
});

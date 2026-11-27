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
const PAGE_MODULE = "../web/src/views/chat-page.js";
const PAGES_MODULE = "../web/src/views/pages.js";
const { App } = (await import(/* @vite-ignore */ APP_MODULE)) as { App: FunctionComponent };
const { ChatPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { ChatPage: FunctionComponent };
const { RunnersTab } = (await import(/* @vite-ignore */ PAGES_MODULE)) as { RunnersTab: FunctionComponent };

// The Chat page and the Runners tab's Chat Card (design 09-dashboard-chat) over a faked server that answers the
// generated client's routes: chat.send, chat.turns, chat.transcript and the items list.

const TOKEN = "tok_chat";
const SLOW = { timeout: 5_000 };
const AT = "2026-11-26T10:00:00.000Z";
const ITEM = "wi_item_abc123";
const REPLY = "This is a build task.\n\n```diff\n- old line\n+ new line\n```\n\n| Name | State |\n|---|---|\n| Alpha | Running |";

let sends: { token: string | null; body: { session_id?: string; text: string; images?: { name: string; data: string }[] } }[];
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
        { seq: 0, role: "user", content: `About item: “Add a chat panel”, state Running, stage implement.\n\nWhat is this?` },
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

const wrap = (child: ReturnType<typeof createElement>, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) =>
  createElement(QueryClientProvider, { client }, child);
/** The Chat page alone, at /app/chat (with `?item=` when `item` is given). */
const page = (item?: string) => {
  history.replaceState(null, "", item === undefined ? "/app/chat" : `/app/chat?item=${encodeURIComponent(item)}`);
  return render(wrap(createElement(ChatPage)));
};
const field = async () => (await screen.findByLabelText("Your message")) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
/** Types `text` and presses Enter, once the session's token is in. */
const ask = async (text: string) => {
  fireEvent.change(await field(), { target: { value: text } });
  await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
  fireEvent.keyDown(await field(), { key: "Enter" });
};

describe("Chat is a page of its own", () => {
  it("the sidebar's Tasks block has a Chat entry that opens the Chat page", async () => {
    render(wrap(createElement(App)));
    const tasks = screen.getByRole("navigation", { name: "Tasks" });
    const link = within(tasks).getByRole("link", { name: "Chat" });
    expect(link.getAttribute("href")).toBe("/app/chat");
    fireEvent.click(link);
    expect(location.pathname).toBe("/app/chat");
    expect(await screen.findByRole("heading", { level: 1, name: "Chat" })).toBeTruthy();
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(screen.getByLabelText("Your message").tagName).toBe("TEXTAREA");
  });

  it("the top bar has no chat toggle and there is no chat side panel", async () => {
    history.replaceState(null, "", "/app/tasks");
    render(wrap(createElement(App)));
    const header = document.querySelector("header") as HTMLElement;
    expect(within(header).queryByRole("button", { name: "Chat" })).toBeNull();
    expect(document.querySelector("[data-chat-panel]")).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Chat" })).toBeNull();
    expect(readFileSync("web/src/App.tsx", "utf8")).not.toMatch(/ChatPanel|chatOpen/);
  });

  it("keeps the conversation when the owner goes to another page and comes back", async () => {
    history.replaceState(null, "", "/app/chat");
    render(wrap(createElement(App)));
    await ask("What is this?");
    await screen.findByText("This is a build task.", {}, SLOW);
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tasks" })).getByRole("link", { name: "Tasks" }));
    await waitFor(() => expect(screen.queryByText("This is a build task.")).toBeNull());
    fireEvent.click(within(screen.getByRole("navigation", { name: "Tasks" })).getByRole("link", { name: "Chat" }));
    expect(await screen.findByText("This is a build task.")).toBeTruthy();
    expect(screen.getByText("What is this?")).toBeTruthy();
  });
});

describe("the composer", () => {
  it("Enter sends; Shift+Enter and an IME's Enter do not", async () => {
    page();
    const box = await field();
    fireEvent.change(box, { target: { value: "First line" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    expect(fireEvent.keyDown(box, { key: "Enter", shiftKey: true })).toBe(true);
    // Composing Korean: Enter ends the composition only.
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(sends).toHaveLength(0);
    expect(box.value).toBe("First line");
    // Enter's default (a new line) is held back when it sends.
    expect(fireEvent.keyDown(box, { key: "Enter" })).toBe(false);
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]!.body.text).toBe("First line");
    expect(box.value).toBe("");
  });

  it("the send button sits inside the composer and is disabled while empty and while an answer is on its way", async () => {
    let answer: (r: Response) => void = () => {};
    const base = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      String(url).includes("/api/v1/chat/send") ? new Promise<Response>((r) => { answer = r; }) : base(url, init)));
    page();
    const box = await field();
    expect(box.parentElement!.contains(sendButton())).toBe(true);
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "   " } });
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Hi" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    fireEvent.click(sendButton());
    // While it waits: the answering mark in the reply's place, and the button stays off even with new text typed.
    expect((await screen.findByRole("status")).textContent).toContain("Thinking…");
    fireEvent.change(box, { target: { value: "Next" } });
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    answer(json(200, sendBody));
    await screen.findByText("This is a build task.", {}, SLOW);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText("Thinking…")).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });
});

describe("Stop and the elapsed line", () => {
  /** A chat.send that never answers on its own; `signals` holds the AbortSignal of each. */
  const hang = () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const base = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (!String(url).includes("/api/v1/chat/send")) return base(url, init);
      signals.push(init?.signal);
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }));
    return signals;
  };

  it("Stop aborts the request, ends the wait, says so in the conversation and brings Send back", async () => {
    const signals = hang();
    page();
    const box = await field();
    fireEvent.change(box, { target: { value: "Hi" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await screen.findByText("Stopped. The chat may still finish its answer; it is not shown here.", {}, SLOW);
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(sendButton()).toBeTruthy();
    expect(screen.queryByText("Chat may not show")).toBeNull();
  });

  it("Stop before the request starts sends nothing", async () => {
    history.replaceState(null, "", `/app/chat?item=${ITEM}`);
    let release: (r: Response) => void = () => {};
    const base = fetch;
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) =>
      new URL(url, "http://127.0.0.1").pathname === "/api/v1/items" ? new Promise<Response>((r) => { release = r; }) : base(url, init)));
    render(wrap(createElement(ChatPage)));
    const box = await field();
    fireEvent.change(box, { target: { value: "Hi" } });
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    fireEvent.click(sendButton());
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    release(json(200, { as_of: AT, total: 1, items: [item], facets: {}, counts: {} }));
    await screen.findByText(/^Stopped\./, {}, SLOW);
    await new Promise((r) => setTimeout(r, 50));
    expect(sends).toEqual([]);
  });

  it("counts the seconds beside Stop from 5 s on, without a live role", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    try {
      hang();
      page();
      const box = await field();
      fireEvent.change(box, { target: { value: "Hi" } });
      fireEvent.click(sendButton());
      const stopBtn = screen.getByRole("button", { name: "Stop" });
      const line = stopBtn.parentElement!.querySelector("p")!;
      expect(line.textContent).toBe("Answering…");
      expect(line.closest("[role]")).toBeNull();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(line.textContent).toBe("Answering…");
      await vi.advanceTimersByTimeAsync(8_000);
      expect(line.textContent).toBe("Answering… 12 s");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the empty page", () => {
  it("greets and offers example questions; a click puts the question in the composer and sends nothing", async () => {
    page();
    expect(screen.getByText("What do you want to know?")).toBeTruthy();
    const examples = screen.getByRole("list", { name: "Example questions" });
    const chips = within(examples).getAllByRole("button");
    expect(chips.map((b) => b.textContent)).toEqual(["What needs me today?", "What is the factory working on?", "What failed recently, and why?", "How much has the factory spent this week?"]);
    fireEvent.click(within(examples).getByRole("button", { name: "What needs me today?" }));
    const box = await field();
    expect(box.value).toBe("What needs me today?");
    expect(document.activeElement).toBe(box);
    expect(sends).toHaveLength(0);
    // Once something is asked, the greeting and the examples go.
    await ask("Hello");
    await screen.findByText("This is a build task.", {}, SLOW);
    expect(screen.queryByRole("list", { name: "Example questions" })).toBeNull();
  });
});

describe("sending a message", () => {
  it("with ?item=, carries the item's title, state and stage, with the session's token; the next message continues the session", async () => {
    page(ITEM);
    await ask("What is this?");
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    const sent = sends[0]!;
    expect(sent.token).toBe(TOKEN);
    expect(sent.body.text).toBe("About item: “Add a chat panel”, state Running, stage implement.\n\nWhat is this?");
    expect(sent.body.session_id).toBeUndefined();
    await screen.findByText("This is a build task.", {}, SLOW);
    await ask("And now?");
    await waitFor(() => expect(sends).toHaveLength(2), SLOW);
    expect(sends[1]!.body.session_id).toBe("cs_1");
  });

  it("with no item, sends the message alone and reads no items", async () => {
    page();
    await ask("Hello");
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]!.body.text).toBe("Hello");
    expect(fetched).not.toContain("GET /api/v1/items");
  });

  it("shows your message as a bubble and the reply as plain markdown: a code block in the code style, a table without pipes", async () => {
    page();
    await ask("Show me");
    await screen.findByText("This is a build task.", {}, SLOW);
    const mine = document.querySelector('li[data-from="you"]') as HTMLElement;
    expect(mine.className).toContain("items-end");
    expect(within(mine).getByText("Show me").className).toContain("rounded-card");
    const reply = document.querySelector('li[data-from="chat"]') as HTMLElement;
    expect(reply.querySelector("[data-markdown]")).not.toBeNull();
    const pre = reply.querySelector("pre") as HTMLElement;
    expect(pre.className).toContain("font-mono");
    expect(pre.className).toContain("bg-surface-2");
    expect(pre.textContent).toContain("+ new line");
    expect(reply.textContent).not.toContain("```");
    expect(within(reply).getByText("Alpha")).toBeTruthy();
    expect(reply.textContent).not.toContain("|");
    // A reply is plain text on the page, not a bubble or a Card.
    expect(reply.querySelector("section")).toBeNull();
  });

  it("shows a failed send in the chat's place, after your message, in plain words, and Try again sends it once more without a second copy", async () => {
    sendStatus = 503;
    sendBody = { error: "Chat is off: no model is configured (plugins.llm)." };
    page();
    await ask("Hi");
    const alert = await screen.findByRole("alert", {}, SLOW);
    expect(alert.textContent).toBe("Chat is off: no model is set up yet. Add one in Plugins, then try again.");
    // Owner 2026-11-27: the error read as yours, right-aligned under your bubble. It is the chat's turn: a row of its own
    // where the answer would be, holding Try again, right after your message.
    const row = alert.closest("li")!;
    expect(row.getAttribute("data-from")).toBe("chat");
    expect(row.previousElementSibling?.getAttribute("data-from")).toBe("you");
    expect(within(row).getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(row.className).not.toMatch(/items-end|justify-end|text-right/);
    expect(alert.className).not.toMatch(/text-right/);
    sendStatus = 200;
    sendBody = { turn_id: "ct_1", session_id: "cs_1", outcome: "answered", reply: "Now it works." };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByText("Now it works.", {}, SLOW);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("Hi")).toHaveLength(1);
    expect(sends.map((x) => x.body.text)).toEqual(["Hi", "Hi"]);
  });

  it("says why when the chat holds an answer back", async () => {
    sendBody = { turn_id: "ct_2", session_id: "cs_2", outcome: "refused", reason: "withheld" };
    page();
    await ask("Hi");
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toMatch(/held something private/);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("says what the model did: its own words on a failed call, or that it refused", async () => {
    sendBody = { turn_id: "ct_3", session_id: "cs_3", outcome: "failed", reason: "model_error", detail: "claude-cli: Not logged in · Please run /login" };
    page();
    await ask("Hi");
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toBe("No answer came back. The model call failed: claude-cli: Not logged in · Please run /login");
    cleanup();
    sendBody = { turn_id: "ct_4", session_id: "cs_4", outcome: "failed", reason: "model_refused" };
    page();
    await ask("Hi");
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toBe("No answer came back. The model refused to answer.");
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
    expect(dialog.textContent).not.toContain("About item");
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

describe("images in the composer", () => {
  const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
  const png = (name: string, size?: number) => new File([size === undefined ? new Uint8Array(PNG) : new Uint8Array(size)], name, { type: "image/png" });
  const b64 = btoa(String.fromCharCode(...PNG));
  let urls: number;
  beforeEach(() => {
    urls = 0;
    // jsdom has no object URLs; each picture gets its own.
    URL.createObjectURL = vi.fn(() => `blob:pic-${urls++}`);
    URL.revokeObjectURL = vi.fn();
  });
  const tray = () => screen.queryByRole("list", { name: "Images to send" });
  const thumbs = () => [...(tray()?.querySelectorAll("img") ?? [])].map((i) => i.getAttribute("alt"));
  const form = async () => (await field()).closest("form")!;
  const picker = async () => (await form()).querySelector<HTMLInputElement>("[data-file-picker]")!;

  it("paste, drop and the attach button each add a thumbnail; Remove takes one away", async () => {
    page();
    const box = await field();
    fireEvent.paste(box, { clipboardData: { files: [png("pasted.png")] } });
    await waitFor(() => expect(thumbs()).toEqual(["pasted.png"]), SLOW);
    const dropped = { types: ["Files"], files: [png("dropped.png")] };
    fireEvent.dragOver(await form(), { dataTransfer: dropped });
    expect((await form()).querySelector("[data-dropping]")).not.toBeNull();
    fireEvent.drop(await form(), { dataTransfer: dropped });
    expect((await form()).querySelector("[data-dropping]")).toBeNull();
    await waitFor(() => expect(thumbs()).toEqual(["pasted.png", "dropped.png"]), SLOW);
    expect(screen.getByRole("button", { name: "Add images" })).toBeTruthy();
    expect((await picker()).accept).toBe("image/png,image/jpeg,image/gif,image/webp");
    fireEvent.change(await picker(), { target: { files: [png("picked.png")] } });
    await waitFor(() => expect(thumbs()).toEqual(["pasted.png", "dropped.png", "picked.png"]), SLOW);
    fireEvent.click(screen.getByRole("button", { name: "Remove dropped.png" }));
    expect(thumbs()).toEqual(["pasted.png", "picked.png"]);
    // A paste of text only is the text's: no thumbnail.
    fireEvent.paste(box, { clipboardData: { files: [] } });
    expect(thumbs()).toHaveLength(2);
  });

  it("with only an image, Send is on and sends its name and bytes; the message shows it, and a click opens it larger", async () => {
    page();
    await field();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send" })).not.toBeNull(), SLOW);
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(await picker(), { target: { files: [png("chart.png")] } });
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    fireEvent.click(sendButton());
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]!.body).toEqual({ text: "", images: [{ name: "chart.png", data: b64 }] });
    expect(tray()).toBeNull();
    const mine = await screen.findByRole("list", { name: "Your images" });
    const open = within(mine).getByRole("button", { name: "Open chart.png" });
    expect(within(open).getByRole("img", { name: "chart.png" }).getAttribute("src")).toMatch(/^blob:/);
    fireEvent.click(open);
    const dialog = await screen.findByRole("dialog", {}, SLOW);
    expect(within(dialog).getByRole("heading", { name: "chart.png" })).toBeTruthy();
    expect(within(dialog).getByRole("img", { name: "chart.png" })).toBeTruthy();
  });

  it("names a file of another type, one over 5 MB and a sixth image, and sends none of them", async () => {
    page();
    await field();
    const pdf = new File(["%PDF"], "notes.pdf", { type: "application/pdf" });
    const files = [...["a", "b", "c", "d", "e"].map((n) => png(`${n}.png`)), png("f.png"), png("big.png", 5 * 1024 * 1024 + 1), pdf];
    fireEvent.change(await picker(), { target: { files } });
    const alerts = await screen.findAllByRole("alert", {}, SLOW);
    expect(alerts.map((a) => a.textContent)).toEqual([
      "“f.png” can’t be sent: a message takes at most 5 images. Remove it to go on.",
      "“big.png” can’t be sent: it is larger than 5 MB. Remove it to go on.",
      "“notes.pdf” can’t be sent: only png, jpeg, gif and webp images can. Remove it to go on.",
    ]);
    await waitFor(() => expect(sendButton().disabled).toBe(false), SLOW);
    fireEvent.click(sendButton());
    await waitFor(() => expect(sends).toHaveLength(1), SLOW);
    expect(sends[0]!.body.images!.map((i: { name: string }) => i.name)).toEqual(["a.png", "b.png", "c.png", "d.png", "e.png"]);
  });

  it("says in plain words which image the chat did not send, above the reply", async () => {
    sendBody = { ...sendBody, reply: "One image read.", images_withheld: ["key.png"] };
    page();
    await field();
    fireEvent.change(await picker(), { target: { files: [png("key.png"), png("ok.png")] } });
    await ask("What are these?");
    await screen.findByText("One image read.", {}, SLOW);
    expect(screen.getByText("Not sent to the chat: “key.png”. It looked like it held a password or key, so it stayed here.")).toBeTruthy();
  });

  it("the Runners transcript shows a stored message's images, read through chat.image", async () => {
    const base = fetch;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const u = new URL(url, "http://127.0.0.1");
      if (u.pathname === "/api/v1/chat/transcript") {
        return json(200, { messages: [{ seq: 0, role: "user", content: "", images: [{ id: "at_1", name: "chart.png", media_type: "image/png", size_bytes: 11 }] }, { seq: 1, role: "assistant", content: "A chart." }] });
      }
      if (u.pathname === "/api/v1/chat/image") return json(200, { id: u.searchParams.get("id"), name: "chart.png", media_type: "image/png", size_bytes: 11, data: b64 });
      return base(url, init);
    }));
    render(wrap(createElement(RunnersTab)));
    const card = await screen.findByRole("region", { name: "Chat" }, SLOW);
    fireEvent.click((await within(card).findAllByRole("button", { name: "Transcript" }, SLOW))[1]!);
    const dialog = await screen.findByRole("dialog", {}, SLOW);
    await within(dialog).findByRole("img", { name: "chart.png" }, SLOW);
    expect(within(dialog).getByText("A chart.")).toBeTruthy();
  });
});

describe("Copy on the page", () => {
  it("each reply and your own message has a Copy button that writes its stored text, without the context line", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (v: string) => void writes.push(v) } });
    page(ITEM);
    await ask("What is this?");
    await screen.findByText("This is a build task.", {}, SLOW);
    fireEvent.click(screen.getByRole("button", { name: "Copy your message" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy reply" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes).toEqual(["What is this?", REPLY]);
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writes.at(-1)).toBe("- old line\n+ new line"));
    Reflect.deleteProperty(navigator, "clipboard");
  });
});

describe("the typed client only", () => {
  const sources = ["web/src/views/chat-page.tsx", "web/src/views/chat-card.tsx"].map((f) => readFileSync(f, "utf8"));
  it("calls no fetch of its own and reads and writes through the generated client", () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\bfetch\(/);
      expect(source).not.toMatch(/XMLHttpRequest|postJson|getJson/);
      expect(source).toContain('from "../api/generated.js"');
    }
    for (const name of ["chatSend", "chatTurns", "chatTranscript"]) expect(sources.join("\n")).toContain(name);
  });

  it("names no ID field in its texts", () => {
    expect(readFileSync("web/src/i18n/en/chat.ts", "utf8")).not.toMatch(/turn_id|session_id|item_id/);
  });
});

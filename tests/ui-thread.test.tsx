// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The item page's thread (design §9, issue #286): the full thread oldest first with author and channel on each
// entry, a command reply in the thread once the item is read again, and Needs-you rows linking to the anchor of
// the factory's newest entry. All against a fake API.

const AT = "2026-11-08T00:00:00.000Z";
const t = (s: number) => new Date(Date.parse(AT) + s * 1000).toISOString();
const SRC = { type: "local", id: "local:1", link: "local:1" };
const entry = (seq: number, at: string, author: string, body: string, kind = author === "factory" ? "spec" : "message") =>
  ({ seq, at, kind, author, role: author === "factory" ? "factory" : "owner", channel: "local", anchor: `msg-${seq}`, body });

const ITEM = {
  id: "wi_1", source: SRC, title: "Thread item", stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2,
  loop_count: 0, restart_count: 0, token_cost: 0, change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [],
  version: 3, created_at: AT, updated_at: AT,
};

// Given out of order: the page sorts newest first by time (seq 9 is the oldest, seq 4 and 5 tie, the higher seq first).
const THREAD = [
  entry(5, t(20), "unknown", "a comment"),
  entry(9, t(0), "factory", "## Spec\n\nthe **spec**"),
  entry(4, t(20), "factory", "an earlier entry at the same time", "suggest"),
  entry(7, t(40), "factory", "the latest why", "needs-human"),
];

let detail: Record<string, unknown>;
let posts: { url: string; body: unknown }[];
let afterPost: (() => void) | null;

const ROW = {
  id: "wi_1", source: SRC, title: "Thread item", level: "needs_you", badges: [], stage: "READY", tier: 2, kind: null, blocked_on: "human",
  blocked_reason: "agent_needs_human", close_reason: null, run_status: null, change_ref: null, change_url: null, since: AT, updated_at: AT, version: 3,
  dependents: 0, conflicts: { automatic: 0, person: 0 }, need: { reason: "the agent asks a question", anchor: "msg-7" },
};

beforeEach(() => {
  detail = { as_of: AT, item: ITEM, timeline: [], runs: [], thread: THREAD, commands: [], replies: [] };
  posts = [];
  afterPost = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = url.split("?")[0]!;
    if (init?.method === "POST") {
      posts.push({ url: path, body: JSON.parse(String(init.body)) });
      afterPost?.();
      return new Response(JSON.stringify({ request_id: "app:x", seq: 3, command: "approve", work_item_id: "wi_1" }), { status: 202, headers: { "content-type": "application/json" } });
    }
    const bodies: Record<string, unknown> = {
      "/api/v1/items/wi_1": detail,
      "/api/v1/items": { as_of: AT, total: 1, items: [ROW], facets: { state: {}, allStates: 1 } },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 1, system_actions: [], running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
    };
    const body = bodies[path];
    if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(path: string) {
  history.replaceState(null, "", path);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

const entries = (thread: HTMLElement) => within(thread).getAllByRole("listitem");

describe("item page: thread", () => {
  it("shows the thread newest first by time, with author, channel and anchor on each entry; the owner's entries say You", async () => {
    mount("/app/items/wi_1");
    const thread = await screen.findByRole("list", { name: "Thread" });
    const rows = entries(thread);
    expect(rows.map((r) => r.getAttribute("data-seq"))).toEqual(["7", "5", "4", "9"]);
    expect(rows.map((r) => r.id)).toEqual(["msg-7", "msg-5", "msg-4", "msg-9"]);
    expect(rows.map((r) => r.querySelector("[data-author]")!.textContent)).toEqual(["factory", "You", "factory", "factory"]);
    expect(rows[1]!.querySelector("[data-author-id]")!.textContent).toBe("unknown");
    expect(rows.map((r) => r.getAttribute("data-role"))).toEqual(["factory", "owner", "factory", "factory"]);
    for (const r of rows) expect(r.querySelector("[data-channel]")!.textContent).toBe("on local");
    // The newest and a spec are expanded: the body renders as markdown, not as raw text.
    expect(within(rows[3]!).getByRole("heading", { name: "Spec" })).toBeTruthy();
    expect(rows[3]!.querySelector("strong")!.textContent).toBe("spec");
    expect(rows[0]!.textContent).toContain("the latest why");
  });

  it("owner entries show the command, its text and the channel in words", async () => {
    detail = { ...detail, thread: [
      { ...entry(0, t(5), "local:me", "split it", "revise"), anchor: "command-a", channel: "cli" },
      { ...entry(0, t(1), "local:me", "looks good", "approve"), anchor: "command-b", channel: "app" },
    ] };
    mount("/app/items/wi_1");
    const rows = entries(await screen.findByRole("list", { name: "Thread" }));
    expect(rows.map((r) => r.querySelector("[data-channel]")!.textContent)).toEqual(["on local CLI", "on dashboard"]);
    expect(rows[0]!.textContent).toContain("revise");
    expect(rows[0]!.textContent).toContain("split it");
    expect(rows[1]!.textContent).toContain("looks good");
    expect(rows[1]!.querySelector("[data-author-id]")!.textContent).toBe("local:me");
  });

  it("older long factory messages show as one line behind Show more; the newest, specs and the URL's anchor start open", async () => {
    const long = (n: string) => `## Review ${n}\n\nthe body of ${n}\n\nmore of ${n}`;
    detail = { ...detail, thread: [
      entry(1, t(0), "factory", long("old"), "review"),
      entry(2, t(10), "factory", long("anchored"), "merge"),
      entry(3, t(20), "factory", "## Spec\n\nthe spec body", "spec"),
      entry(4, t(30), "factory", "## Held\n\nheld body", "coordination-hold"),
      entry(5, t(40), "factory", long("newest"), "review"),
      entry(6, t(50), "factory", "A short one.", "review"),
    ] };
    mount("/app/items/wi_1#msg-2");
    const rows = entries(await screen.findByRole("list", { name: "Thread" }));
    expect(rows.map((r) => r.getAttribute("data-seq"))).toEqual(["6", "5", "4", "3", "2", "1"]);
    // Open: 6 (newest), 4 and 3 (asks), 2 (the URL's anchor); folded: 5 and 1.
    expect(rows[0]!.textContent).toContain("A short one.");
    expect(rows[0]!.querySelector("button")).toBeNull();
    expect(within(rows[2]!).getByText("held body")).toBeTruthy();
    expect(within(rows[3]!).getByText("the spec body")).toBeTruthy();
    expect(within(rows[4]!).getByText("the body of anchored")).toBeTruthy();
    // Folded: one line (the first heading), full body not rendered, Show more beside it.
    for (const i of [1, 5]) {
      expect(rows[i]!.querySelector("[data-summary]")!.textContent).toMatch(/^Review (newest|old)$/);
      expect(within(rows[i]!).queryByText(/the body of/)).toBeNull();
    }
    fireEvent.click(within(rows[5]!).getByRole("button", { name: "Show more" }));
    expect(within(rows[5]!).getByText("the body of old")).toBeTruthy();
    expect(within(rows[5]!).getByRole("button", { name: "Show less" })).toBeTruthy();
  });

  it("without an anchor the newest message is open, and a long factory message that is newest shows in full", async () => {
    detail = { ...detail, thread: [entry(1, t(0), "factory", "Old text one. Old text two.", "review"), entry(2, t(9), "factory", "New text one. New text two.", "review")] };
    mount("/app/items/wi_1");
    const rows = entries(await screen.findByRole("list", { name: "Thread" }));
    expect(rows[0]!.textContent).toContain("New text two.");
    expect(rows[1]!.querySelector("[data-summary]")!.textContent).toBe("Old text one.");
  });

  it("an item with no entries says so", async () => {
    detail = { ...detail, thread: [] };
    mount("/app/items/wi_1");
    const region = await screen.findByRole("region", { name: "Thread" });
    expect(region.textContent).toContain("No message yet.");
  });
});

describe("item page: command reply in the thread", () => {
  it("a command from the command box gets 202, and its reply shows in the thread once the item is read again", async () => {
    detail = { ...detail, commands: [{ name: "approve", usage: "/approve", description: "approve the spec", allowed: true, reason: null }] };
    // The controller writes its reply after the request: the next read of the item has it.
    afterPost = () => {
      detail = {
        ...detail,
        thread: [...THREAD, entry(12, t(60), "factory", "`/approve` was not applied: you need the approver role.", "refused")],
        replies: [{ seq: 3, command: "approve", created_at: t(50), handled_at: t(60), refusal: "you need the approver role" }],
      };
    };
    mount("/app/items/wi_1");
    const thread = await screen.findByRole("list", { name: "Thread" });
    expect(thread.textContent).not.toContain("was not applied");
    const button = await screen.findByRole("button", { name: "Approve" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    // The approve dialog comes first: it names what is approved and what happens next, and nothing is sent yet.
    const confirm = await screen.findByRole("dialog");
    expect(confirm.textContent).toContain("You approve the spec waiting for approval.");
    expect(confirm.textContent).toContain("Next: The factory starts the implement run on this spec.");
    expect(posts).toEqual([]);
    fireEvent.click(within(confirm).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posts).toEqual([{ url: "/api/v1/items/wi_1/commands", body: { command: "approve" } }]));
    await waitFor(() => expect(entries(screen.getByRole("list", { name: "Thread" }))[0]!.id).toBe("msg-12"));
    const last = entries(screen.getByRole("list", { name: "Thread" }))[0]!;
    expect(last.textContent).toContain("was not applied: you need the approver role.");
    expect(last.querySelector("[data-author]")!.textContent).toBe("factory");
  });
});

describe("Needs you: link to the factory's latest why", () => {
  it("a Needs a human row links to /app/items/<id>#<anchor>, and the anchor is on the item page", async () => {
    mount("/app/");
    const table = await screen.findByRole("table", { name: "Needs you" });
    const link = within(table).getByRole("link", { name: "the agent asks a question" });
    expect(link.getAttribute("href")).toBe("/app/items/wi_1#msg-7");
    fireEvent.click(link);
    expect(location.pathname).toBe("/app/items/wi_1");
    expect(location.hash).toBe("#msg-7");
    await screen.findByRole("list", { name: "Thread" });
    const target = document.getElementById("msg-7")!;
    expect(target).toBeTruthy();
    expect(target.textContent).toContain("the latest why");
  });

  it("a row whose item has no factory entry shows the reason without a link", async () => {
    ROW.need.anchor = null;
    try {
      mount("/app/");
      const table = await screen.findByRole("table", { name: "Needs you" });
      const need = table.querySelector("[data-need]")!;
      expect(need.textContent).toContain("the agent asks a question");
      expect(need.querySelector("a")).toBeNull();
    } finally {
      ROW.need.anchor = "msg-7";
    }
  });
});

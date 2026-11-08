// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsersView } from "../web/src/api.js";
import { routeFor } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-standing-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/users.js";
const { UsersPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { UsersPage: FunctionComponent };

// The Users page (issue #445, design 08-permissions and 09-dashboard-app): the viewer's identity and role, then every
// local and static grant user with its links; a table at sm and up, one card per user at 390 px. The owner gets
// Add, a role select and Remove on every local row but its own; anyone else sees the list read-only with the reason.

const TOKEN = "tok_users";
const AT = "2026-11-08T00:00:00.000Z";
const OWNER = "local:owner@example.com";
const REASON = `only the local owner (${OWNER}) can change roles; you are local:alice`;
const WIDE = window.innerWidth;
const SLOW = { timeout: 5_000 };

const view = (over: Partial<UsersView> = {}): UsersView => ({
  as_of: AT,
  csrf_token: TOKEN,
  viewer: { user_id: OWNER, source: "git user.email", role: "owner" },
  can_change: true,
  read_only_reason: null,
  users: [
    { user_id: OWNER, role: "owner", source: "local", added_by: OWNER, added_at: AT, projects: [], links: [] },
    { user_id: "local:alice", role: "requester", source: "local", added_by: OWNER, added_at: AT, projects: [], links: [{ provider: "github", subject: "12345" }] },
    { user_id: "github:9", role: "approver", source: "static", added_by: null, added_at: null, projects: [{ project: "*", roles: ["approver"] }], links: [] },
  ],
  ...over,
});
const nonOwner = () => view({ viewer: { user_id: "local:alice", source: "OS user", role: "requester" }, can_change: false, read_only_reason: REASON });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function width(px: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: px });
  window.dispatchEvent(new Event("resize"));
}

let current: UsersView;
let posts: { url: string; init: RequestInit }[];
let answer: { status: number; body: unknown };

beforeEach(() => {
  current = view();
  posts = [];
  answer = { status: 200, body: { done: "ok" } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, init });
      return json(answer.status, answer.body);
    }
    if (url === "/api/v1/users") return json(200, current);
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  width(WIDE);
});

async function show(px: number) {
  width(px);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(UsersPage)));
  await screen.findByTestId("viewer", {}, SLOW);
}

const row = (user: string) => document.querySelector<HTMLElement>(`[data-user="${user}"]`)!;

describe("Users page", () => {
  it("is the page at /app/users", () => {
    expect(routeFor("/app/users").page.label).toBe("Users");
  });

  it("at desktop width: a table of every user with role, source, added by, added at and links", async () => {
    await show(1280);
    const table = screen.getByRole("table", { name: "Users" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["User", "Role", "Source", "Added by", "Added at", "Links", "Change"]);
    expect(row("local:alice").textContent).toContain("github:12345");
    expect(row("local:alice").getAttribute("data-source")).toBe("local");
    expect(row("github:9").textContent).toContain("static (*: approver)");
    expect(screen.getByTestId("viewer").textContent).toBe(`${OWNER} (from git user.email) · role owner`);
  });

  it("at 390 px: one card per user, no table", async () => {
    await show(390);
    expect(document.querySelector("table")).toBeNull();
    const list = screen.getByRole("list", { name: "Users" });
    expect([...list.querySelectorAll("li[data-user]")].map((li) => li.getAttribute("data-user"))).toEqual([OWNER, "local:alice", "github:9"]);
    expect(row("local:alice").querySelector("dl")!.textContent).toContain("Links");
  });

  it("the owner's row and static rows have no controls; another local row has a role select and Remove", async () => {
    await show(1280);
    for (const u of [OWNER, "github:9"]) {
      expect(within(row(u)).queryByRole("button")).toBeNull();
      expect(within(row(u)).queryByRole("combobox")).toBeNull();
    }
    expect(within(row("local:alice")).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(within(row("local:alice")).getByRole("combobox", { name: "Role of local:alice" })).toBeTruthy();
  });

  it("Add, change and Remove post with the CSRF token", async () => {
    await show(1280);
    const form = screen.getByRole("form", { name: "Add a user" });
    fireEvent.change(within(form).getByRole("textbox", { name: "User ID" }), { target: { value: " local:bob " } });
    fireEvent.change(within(form).getByRole("combobox", { name: "Role" }), { target: { value: "approver" } });
    fireEvent.click(within(form).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.change(within(row("local:alice")).getByRole("combobox"), { target: { value: "approver" } });
    await waitFor(() => expect(posts).toHaveLength(2));
    fireEvent.click(within(row("local:alice")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts.every((p) => p.url === "/api/v1/users" && new Headers(p.init.headers).get("x-csrf-token") === TOKEN)).toBe(true);
    expect(posts.map((p) => JSON.parse(String(p.init.body)))).toEqual([
      { action: "add", user_id: "local:bob", role: "approver" },
      { action: "change", user_id: "local:alice", role: "approver" },
      { action: "remove", user_id: "local:alice" },
    ]);
  });

  it("a refusal shows beside the row it came from", async () => {
    answer = { status: 409, body: { error: "the owner cannot be removed" } };
    await show(1280);
    fireEvent.click(within(row("local:alice")).getByRole("button", { name: "Remove" }));
    expect((await within(row("local:alice")).findByRole("alert", {}, SLOW)).textContent).toBe("the owner cannot be removed");
  });

  it("a non-owner sees the list read-only with the reason, and no controls", async () => {
    current = nonOwner();
    await show(1280);
    expect(screen.getByRole("note").textContent).toContain(REASON);
    expect(screen.queryByRole("form", { name: "Add a user" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: "Remove" })).toEqual([]);
    expect(screen.queryByRole("columnheader", { name: "Change" })).toBeNull();
    expect(screen.getByTestId("viewer").textContent).toBe("local:alice (from OS user) · role requester");
  });

  it("a non-owner at 390 px sees cards and the same reason", async () => {
    current = nonOwner();
    await show(390);
    expect(screen.getByRole("list", { name: "Users" })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain(REASON);
    expect(screen.queryAllByRole("button")).toEqual([]);
  });
});

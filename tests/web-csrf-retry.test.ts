// @vitest-environment jsdom
/// <reference lib="dom" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { API, type Session, postCommand, postTaskAction, useApi } from "../web/src/api.js";

// postJson's one stale-token retry (design 09-dashboard-app): a write refused with 403 code "stale_csrf" (the UI
// process restarted, so the page's token is dead) fetches GET /api/v1/session once, retries the same write once with
// its csrf_token and puts that token in the cached session query. A second stale 403, or any other 403, is returned.

const OLD = "tok_old";
const NEW = "tok_new";
const STALE = { error: "Missing or stale x-csrf-token; reload the page.", code: "stale_csrf" };
const session = (token: string): Session => ({ as_of: "t", csrf_token: token, commands_enabled: true, actor: "local:me", actor_source: "environment" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let posts: { url: string; token: string | null }[];
let sessionReads: number;
/** The answers of the POSTs in order; the last repeats. */
let answers: { status: number; body: unknown }[];

beforeEach(() => {
  posts = [];
  sessionReads = 0;
  answers = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ url, token: new Headers(init.headers).get("x-csrf-token") });
      const a = answers[Math.min(posts.length, answers.length) - 1]!;
      return json(a.status, a.body);
    }
    if (url === API.session) {
      sessionReads++;
      return json(200, session(sessionReads === 1 ? OLD : NEW));
    }
    return json(404, { error: "Not found." });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The app's session query, as the pages read it, with the page's first token loaded. */
async function cachedSession() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  const hook = renderHook(() => useApi<Session>(API.session, false), { wrapper });
  await waitFor(() => expect(hook.result.current.data?.csrf_token).toBe(OLD));
  return { client, hook };
}

describe("postJson: one retry after a stale token", () => {
  it("a stale-token 403 fetches the session once, retries with the new token, succeeds, and caches the token", async () => {
    const { client, hook } = await cachedSession();
    answers = [{ status: 403, body: STALE }, { status: 202, body: { seq: 7 } }];
    expect(await postCommand(OLD, "wi_1", "merge", "")).toEqual({ ok: true, seq: 7 });
    expect(sessionReads).toBe(2);
    expect(posts).toEqual([{ url: API.itemCommands("wi_1"), token: OLD }, { url: API.itemCommands("wi_1"), token: NEW }]);
    expect(client.getQueryData<Session>([API.session])?.csrf_token).toBe(NEW);
    await waitFor(() => expect(hook.result.current.data?.csrf_token).toBe(NEW));
  });

  it("every write helper gets it: a task action retries the same way", async () => {
    await cachedSession();
    answers = [{ status: 403, body: STALE }, { status: 200, body: {} }];
    expect(await postTaskAction(OLD, "done", { id: "tk_1" })).toEqual({ ok: true });
    expect(posts.map((p) => p.token)).toEqual([OLD, NEW]);
  });

  it("a retry that gets the stale 403 again returns its error and sends nothing more", async () => {
    await cachedSession();
    answers = [{ status: 403, body: STALE }];
    expect(await postCommand(OLD, "wi_1", "merge", "")).toEqual({ ok: false, error: STALE.error });
    expect(posts.map((p) => p.token)).toEqual([OLD, NEW]);
    expect(sessionReads).toBe(2);
  });

  it("a 403 without code stale_csrf (the origin refusal) is not retried", async () => {
    await cachedSession();
    answers = [{ status: 403, body: { error: "Origin must be this page's own origin." } }];
    expect(await postCommand(OLD, "wi_1", "merge", "")).toEqual({ ok: false, error: "Origin must be this page's own origin." });
    expect(posts).toHaveLength(1);
    expect(sessionReads).toBe(1);
  });
});

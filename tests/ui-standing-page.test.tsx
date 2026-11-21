// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RulesView, StandingView } from "../web/src/api.js";
import { localDateTime } from "../web/src/lib/format.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-settings-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/rules.js";
const { RulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RulesPage: FunctionComponent };

// Auto-approve specs on the Rules page's Waiting tab (issue #300, design 05-standing-approvals and §9; moved from
// Settings 2026-11-16, renamed from Approvals 2026-11-21): under one "Auto-approve specs" heading, an on or off switch per standing rule and Accept and Decline per pending proposal, each a
// POST /api/v1/standing with the CSRF token; a refusal shows beside its item. Each part is hidden when it has no items,
// and the heading when both are empty. Who set a rule reads "you" or "a person", never the user ID, and the dates are local.

const TOKEN = "tok_standing";
const AT = "2026-11-07T00:00:00.000Z";
const rules: RulesView = { enabled: true, applied: null, error: null, csrf_token: TOKEN, judge: null, home: null, turn_on: null, entries: [] };
const standing = (): StandingView => ({
  as_of: AT,
  csrf_token: TOKEN,
  rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 10, enabled: false, set_by: "github:1", created_at: AT, updated_at: AT, last_used_at: null }],
  proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 10, threshold: 10, created_at: AT }],
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A write, then a refetch: on a loaded CI runner this takes longer than the 1 s default wait. Each test gets three
// times this, so a slow wait fails on its own message, not on the test timeout.
const SLOW = { timeout: 5_000 };
const TEST_MS = 15_000;

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
  return screen.findByRole("list", { name: "Standing rules" }, SLOW);
}

const ruleItem = (list: HTMLElement, rule: string) => list.querySelector<HTMLElement>(`li[data-rule="${rule}"]`)!;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Standing approvals section (stubbed API)", { timeout: TEST_MS }, () => {
  let view: StandingView;
  let posts: { url: string; init: RequestInit }[];
  let answer: { status: number; body: unknown };
  // Set by a test that must see the write in flight: each POST then waits until the test calls the release it left.
  let hold: boolean;
  let release: (() => void)[];
  // The session's actor: the viewer the set-by words compare with.
  let viewer: string;

  beforeEach(() => {
    viewer = "github:2";
    posts = [];
    view = standing();
    answer = { status: 200, body: { changed: true } };
    hold = false;
    release = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push({ url, init });
        // A held write answers only when the test releases it, never on a timer a loaded runner could pass first.
        if (hold) await new Promise<void>((r) => release.push(r));
        return json(answer.status, answer.body);
      }
      if (url === "/api/v1/rules") return json(200, rules);
      if (url === "/api/v1/standing") return json(200, view);
      if (url === "/api/v1/session") return json(200, { actor: viewer });
      return json(404, { error: "Not found." });
    }));
  });

  it("shows a switch per rule with its gate, tier, threshold, who set it in words, the local created date and last used", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    expect(within(li).getByRole("switch", { name: "spec-t1" }).getAttribute("aria-checked")).toBe("false");
    for (const text of ["gate spec", "tier 1", "threshold 10", `created ${localDateTime(AT)}`, "last used not recorded", "set by a person"]) expect(li.textContent).toContain(text);
    // No user ID and no ISO time.
    expect(li.textContent).not.toContain("github:");
    expect(li.textContent).not.toContain(AT);
    const approvals = screen.getByRole("region", { name: "Auto-approve specs" });
    expect(within(approvals).getByRole("heading", { level: 2 }).textContent).toBe("Auto-approve specs");
    // No config key path next to the threshold.
    expect(li.textContent).not.toContain("standing_approvals.threshold");
  });

  it("a rule the viewer set reads \"set by you\"", async () => {
    viewer = "github:1";
    const list = await show();
    await waitFor(() => expect(ruleItem(list, "spec-t1").textContent).toContain("set by you"), SLOW);
    expect(ruleItem(list, "spec-t1").textContent).not.toContain("github:1");
  });

  it("puts the pending proposals before the standing rules, both under the Auto-approve specs heading", async () => {
    await show();
    const approvals = screen.getByRole("region", { name: "Auto-approve specs" });
    const lists = [...approvals.querySelectorAll("ul")].map((u) => u.getAttribute("aria-label"));
    expect(lists).toEqual(["Pending proposals", "Standing rules"]);
  });

  it("hides the pending proposals when there are none, and the standing rules when there are none", async () => {
    view = { ...view, proposals: [] };
    await show();
    expect(screen.queryByRole("list", { name: "Pending proposals" })).toBeNull();
    expect(screen.queryByText("No proposal is waiting.")).toBeNull();
    cleanup();
    view = { ...standing(), rules: [] };
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RulesPage)));
    await screen.findByRole("list", { name: "Pending proposals" }, SLOW);
    expect(screen.queryByRole("list", { name: "Standing rules" })).toBeNull();
  });

  it("hides the whole Auto-approve specs heading when there is nothing in either part", async () => {
    view = { ...view, proposals: [], rules: [] };
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RulesPage)));
    await screen.findByRole("heading", { name: "Rules" }, SLOW);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/standing", expect.anything()), SLOW);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Auto-approve specs" })).toBeNull();
    expect(screen.queryByText("Auto-approve specs")).toBeNull();
  });

  it("the switch posts the rule and its new state with the CSRF token", async () => {
    const list = await show();
    fireEvent.click(within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "spec-t1" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/standing");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ rule: "spec-t1", enabled: true });
  });

  it("Accept and Decline post the proposal's answer", async () => {
    hold = true;
    await show();
    const proposals = screen.getByRole("list", { name: "Pending proposals" });
    const li = proposals.querySelector<HTMLElement>('li[data-proposal="sp_1"]')!;
    const decline = within(li).getByRole("button", { name: "Decline" }) as HTMLButtonElement;
    fireEvent.click(within(li).getByRole("button", { name: "Accept" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // The buttons are disabled while the Accept write is in flight; Decline is clicked once it answers.
    expect(decline.disabled).toBe(true);
    release.shift()!();
    await waitFor(() => expect(decline.disabled).toBe(false));
    fireEvent.click(decline);
    await waitFor(() => expect(posts).toHaveLength(2));
    release.shift()!();
    expect(posts.map((p) => JSON.parse(String(p.init.body)))).toEqual([
      { rule: "spec-t1", enabled: true, proposal: "sp_1" },
      { rule: "spec-t1", enabled: false, proposal: "sp_1" },
    ]);
  });

  it("a refusal shows beside the item it came from", async () => {
    answer = { status: 403, body: { error: "Changing a standing rule needs approve_spec: no_role." } };
    const list = await show();
    const proposal = screen.getByRole("list", { name: "Pending proposals" }).querySelector<HTMLElement>('li[data-proposal="sp_1"]')!;
    fireEvent.click(within(proposal).getByRole("button", { name: "Decline" }));
    expect((await within(proposal).findByRole("alert")).textContent).toContain("approve_spec");
    expect(within(ruleItem(list, "spec-t1")).queryByRole("alert")).toBeNull();
  });

  it("disables every control when the server has no write route", async () => {
    view = { ...view, csrf_token: null };
    const list = await show();
    expect((within(ruleItem(list, "spec-t1")).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Accept" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("Standing approvals section against a server that keeps the rule", () => {
  it("turn the rule off, then on, reload the page: the state shown matches the last write", async () => {
    // A server that stores what each POST writes and answers every GET from it, as the real routes do
    // (tests/ui-standing.test.ts checks the routes on the real store). This file runs under jsdom, so it loads no
    // server module: the routes' import tree (store, plugins, processes) is not the browser's.
    let enabled = true;
    const writes: boolean[] = [];
    const current = (): StandingView => ({ ...standing(), rules: [{ ...standing().rules[0]!, enabled }] });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/rules") return json(200, rules);
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { enabled: boolean };
        const changed = body.enabled !== enabled;
        enabled = body.enabled;
        writes.push(body.enabled);
        return json(200, { changed, ...current() });
      }
      return json(200, current());
    }));
    const switchOf = (list: HTMLElement) => within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "spec-t1" });

    let list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(switchOf(list));
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("false"), SLOW);
    await waitFor(() => expect((switchOf(list) as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(switchOf(list));
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("true"), SLOW);
    expect(writes).toEqual([false, true]);

    // Reload: a fresh page and query cache read the server again.
    cleanup();
    list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
  }, TEST_MS);
});

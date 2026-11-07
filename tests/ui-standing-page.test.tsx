// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { type ApiDeps, api } from "../src/ui/api.js";
import { writeStanding } from "../src/ui/standing-api.js";
import type { SettingsView, StandingView } from "../web/src/api.js";
import { newStore } from "./helpers/store.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-settings-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/settings.js";
const { SettingsPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SettingsPage: FunctionComponent };

// Standing approvals on the Settings page (issue #300, design 05-standing-approvals and §9): an on or off switch per
// rule and Accept and Decline per pending proposal, each a POST /api/v1/standing with the CSRF token; a refusal
// shows beside its item.

const TOKEN = "tok_standing";
const AT = "2026-11-07T00:00:00.000Z";
const settings: SettingsView = {
  as_of: AT, csrf_token: TOKEN, repo: "o/r", project: null, project_keys: [], keys: [], pr_only: [], ignored: [], history: [],
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A write through the real store, then a refetch: on a loaded CI runner this takes longer than the 1 s default wait.
const SLOW = { timeout: 5_000 };

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(SettingsPage)));
  return screen.findByRole("list", { name: "Standing rules" }, SLOW);
}

const ruleItem = (list: HTMLElement, rule: string) => list.querySelector<HTMLElement>(`li[data-rule="${rule}"]`)!;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Standing approvals section (stubbed API)", () => {
  let view: StandingView;
  let posts: { url: string; init: RequestInit }[];
  let answer: { status: number; body: unknown };
  // Set by a test that must see the write in flight: each POST then waits until the test calls the release it left.
  let hold: boolean;
  let release: (() => void)[];

  beforeEach(() => {
    posts = [];
    view = {
      as_of: AT,
      csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 10, enabled: false, set_by: "github:1", created_at: AT, updated_at: AT, last_used_at: null }],
      proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 10, threshold: 10, created_at: AT }],
    };
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
      if (url === "/api/v1/settings") return json(200, settings);
      if (url === "/api/v1/standing") return json(200, view);
      return json(404, { error: "Not found." });
    }));
  });

  it("shows a switch per rule with its gate, tier, threshold, created and last used", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    expect(within(li).getByRole("switch", { name: "spec-t1" }).getAttribute("aria-checked")).toBe("false");
    for (const text of ["gate spec", "tier 1", "threshold 10", `created ${AT}`, "last used not recorded", "github:1"]) expect(li.textContent).toContain(text);
    expect(screen.getByRole("region", { name: "Standing approvals" })).toBeTruthy();
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

describe("Standing approvals section against the real routes", () => {
  it("turn the rule off, then on, reload the page: the state shown matches the last write", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    await store.putStandingRule({ gate: "spec", tier: 1, enabled: true, set_by: "github:1" as UserId });
    const d: ApiDeps = {
      store,
      scanner: new PatternEgressScanner(async () => []),
      clock,
      lease_ms: 300_000,
      prUrl: (label, n) => `https://${label}/pull/${n}`,
      health: new HealthMonitor(async () => [], clock),
      pauses: {
        principal: async () => "github:1" as UserId,
        authorize: async () => ({ allow: true }),
        csrfToken: TOKEN,
        log: { info: () => {}, warn: () => {}, error: () => {} },
      },
    };
    // The route functions behind server.ts (whose guards tests/ui-standing.test.ts covers; server.ts itself does not
    // load under jsdom, which has no file: module URL for the app's directory).
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/v1/settings") return json(200, settings);
      const r = init?.method === "POST"
        ? await writeStanding(d, d.pauses!, JSON.parse(String(init.body)))
        : await api(d, new URL(url, "http://127.0.0.1"));
      return json(r.status, r.value);
    }));
    const switchOf = (list: HTMLElement) => within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "spec-t1" });

    let list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(switchOf(list));
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("false"), SLOW);
    clock.advance(1000);
    await waitFor(() => expect((switchOf(list) as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(switchOf(list));
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("true"), SLOW);

    // Reload: a fresh page and query cache read the store again.
    cleanup();
    list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
    expect((await store.listStandingRules()).find((r) => r.tier === 1)?.enabled).toBe(true);
  }, 30_000);
});

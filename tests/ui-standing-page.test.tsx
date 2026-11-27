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

// Standing approvals on the Rules page (issue #300, design 05-standing-approvals and §9; two sections since 2026-11-22):
// a rule that is on is a row of In effect, one that is off a row under the page's Details, each with its switch; a
// pending proposal is a row of Waiting for you with Accept visible and Decline in its ⋯ menu. A rule is turned on,
// paused, edited or removed in a Dialog (its switch or its ⋯ menu), which lists the waiting items the change would
// approve now. Each write is a POST /api/v1/standing with the CSRF token; a refusal shows in the dialog or beside its item. Who set a rule reads "you" or "a person",
// never the user ID, and the dates are local.

const TOKEN = "tok_standing";
const AT = "2026-11-07T00:00:00.000Z";
const rules: RulesView = { enabled: true, applied: null, error: null, csrf_token: TOKEN, judge: null, home: null, turn_on: null, entries: [] };
const standing = (): StandingView => ({
  as_of: AT,
  csrf_token: TOKEN,
  rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 10, enabled: false, set_by: "github:1", created_at: AT, updated_at: AT, last_fired_at: null, recent: [] }],
  proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 10, threshold: 10, created_at: AT }],
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// A write, then a refetch: on a loaded CI runner this takes longer than the 1 s default wait. Each test gets three
// times this, so a slow wait fails on its own message, not on the test timeout.
const SLOW = { timeout: 5_000 };
const TEST_MS = 15_000;

/** Renders the Rules page and waits for the standing rows; returns the page body that holds them. */
async function show(): Promise<HTMLElement> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(createElement(QueryClientProvider, { client }, createElement(RulesPage)));
  await waitFor(() => {
    if (!document.querySelector("li[data-rule], li[data-proposal]")) throw new Error("no standing row yet");
  }, SLOW);
  return document.body;
}
const proposalRow = () => document.querySelector<HTMLElement>('li[data-proposal="sp_1"]')!;

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

  it("shows a switch per rule with its plain sentence; gate, tier, threshold, who set it in words, the local created date and last used are behind Details", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    expect(within(li).getByRole("switch", { name: "Approves risk level 1 plans for you" }).getAttribute("aria-checked")).toBe("false");
    // The row reads one plain sentence; the ID, gate, tier, threshold, who set it and the dates sit behind Details.
    expect(li.querySelector("[data-rule-sentence]")!.textContent).toBe("Approves risk level 1 plans for you");
    // The sentence wraps whole: a one-line cut read "Approves risk level 1 pl…" at 390px (2026-11-27).
    expect(li.querySelector("[data-rule-sentence]")!.className).not.toMatch(/\btruncate\b/);
    const raw = li.querySelector<HTMLElement>("[data-raw]")!;
    for (const text of ["Rule ID: spec-t1", "gate spec", "risk level 1", "threshold 10", `created ${localDateTime(AT)}`, "set by a person"]) expect(raw.textContent).toContain(text);
    // The row says when it last fired and how many items it approved in the last 7 days.
    expect(li.querySelector("[data-fired]")!.textContent).toBe("never fired");
    expect(li.querySelector("[data-recent]")!.textContent).toBe("0 items in the last 7 days");
    expect(li.textContent).not.toContain("last used");
    // No user ID and no ISO time.
    expect(li.textContent).not.toContain("github:");
    expect(li.textContent).not.toContain(AT);
    // A rule that is off is a ListRow under the page's Details, not in In effect.
    expect(li.matches("[data-list-row]")).toBe(true);
    expect(li.closest("[data-standing-off]")!.closest("details[data-page-details]")).not.toBeNull();
    expect(screen.getByRole("region", { name: "In effect" }).querySelector('[data-rule="spec-t1"]')).toBeNull();
    // No config key path next to the threshold.
    expect(li.textContent).not.toContain("standing_approvals.threshold");
  });

  it("a rule the viewer set reads \"set by you\"", async () => {
    viewer = "github:1";
    const list = await show();
    await waitFor(() => expect(ruleItem(list, "spec-t1").textContent).toContain("set by you"), SLOW);
    expect(ruleItem(list, "spec-t1").textContent).not.toContain("github:1");
  });

  it("a pending proposal is a row of Waiting for you; a rule that is on is a row of In effect", async () => {
    view = { ...view, rules: [{ ...view.rules[0]!, enabled: true }] };
    await show();
    const waiting = screen.getByRole("region", { name: "Waiting for you" });
    expect(waiting.querySelector('li[data-proposal="sp_1"]')!.matches("[data-list-row]")).toBe(true);
    await waitFor(() => expect(screen.getByRole("region", { name: "In effect" }).querySelector('li[data-rule="spec-t1"]')).not.toBeNull(), SLOW);
    expect(document.querySelector("[data-standing-off]")).toBeNull();
  });

  it("shows no proposal row when none waits, and no rule row when there is no rule", async () => {
    view = { ...view, proposals: [] };
    await show();
    expect(document.querySelector("li[data-proposal]")).toBeNull();
    expect(screen.queryByText("No proposal is waiting.")).toBeNull();
    cleanup();
    view = { ...standing(), rules: [] };
    await show();
    expect(proposalRow()).not.toBeNull();
    expect(document.querySelector("li[data-rule]")).toBeNull();
  });

  it("with nothing in either part, In effect says no rule is in effect and Waiting for you shows its empty state", async () => {
    view = { ...view, proposals: [], rules: [] };
    render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RulesPage)));
    await screen.findByRole("heading", { name: "Rules" }, SLOW);
    await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/v1/standing", expect.anything()), SLOW);
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByRole("region", { name: "In effect" }).textContent).toContain("No rule is in effect yet.");
    expect(screen.getByRole("region", { name: "Waiting for you" }).textContent).toContain("Nothing waits for a verdict");
    expect(screen.queryByText("Auto-approve specs")).toBeNull();
  });

  it("the switch opens the Turn on dialog, not an inline form; its confirm posts the rule and its new state with the CSRF token", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    fireEvent.click(within(li).getByRole("switch", { name: "Approves risk level 1 plans for you" }));
    const dialog = await screen.findByRole("dialog");
    // The dialog sits outside the row, so the row's height does not change; nothing is posted before the confirm.
    expect(li.contains(dialog)).toBe(false);
    expect(posts).toEqual([]);
    expect(within(dialog).getByRole("switch", { name: "Approves risk level 1 plans for you" }).getAttribute("aria-checked")).toBe("true");
    // Cancel (secondary) comes before the confirm (primary, last).
    const buttons = within(dialog).getAllByRole("button").filter((b) => b.getAttribute("role") !== "switch");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Turn on"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.url).toBe("/api/v1/standing");
    expect(new Headers(posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ rule: "spec-t1", enabled: true });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("the Turn on dialog lists the waiting items the rule would approve now, and says none when there are none", async () => {
    view = { ...view, waiting: [{ id: "wi_1", title: "Fix the login" }, { id: "wi_2", title: "Ship docs" }] };
    const list = await show();
    fireEvent.click(within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "Approves risk level 1 plans for you" }));
    const preview = (await screen.findByRole("dialog")).querySelector<HTMLElement>("[data-preview]")!;
    expect(preview.textContent).toContain("Waiting items this rule covers");
    expect([...preview.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Fix the login", "Ship docs"]);
    expect(preview.textContent).not.toContain("wi_1");
    // Turned to off in the dialog, the change approves nothing.
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("switch"));
    expect(preview.querySelector("[data-preview-none]")!.textContent).toBe("none");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);
    cleanup();
    view = { ...standing(), waiting: [] };
    const again = await show();
    fireEvent.click(within(ruleItem(again, "spec-t1")).getByRole("switch", { name: "Approves risk level 1 plans for you" }));
    expect((await screen.findByRole("dialog")).querySelector("[data-preview-none]")!.textContent).toBe("none");
  });

  it("Pause, from the ⋯ menu of a rule that is on, posts it off", async () => {
    view = { ...view, rules: [{ ...view.rules[0]!, enabled: true }] };
    const list = await show();
    await waitFor(() => expect(ruleItem(list, "spec-t1")).not.toBeNull(), SLOW);
    const li = ruleItem(list, "spec-t1");
    fireEvent.click(within(li).getByRole("button", { name: /^More:/ }));
    fireEvent.click(within(li).getByRole("menuitem", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ rule: "spec-t1", enabled: false });
  });

  it("Edit opens a dialog with the threshold field and posts the new threshold", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    fireEvent.click(within(li).getByRole("button", { name: /^More:/ }));
    fireEvent.click(within(li).getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Approvals in a row before the factory suggests a rule") as HTMLInputElement;
    expect(field.value).toBe("10");
    const save = within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    fireEvent.change(field, { target: { value: "0" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field, { target: { value: "6" } });
    expect(save.disabled).toBe(false);
    expect(dialog.querySelector("[data-preview-none]")!.textContent).toBe("none");
    fireEvent.click(save);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ rule: "spec-t1", action: "edit", threshold: 6 });
  });

  it("Remove opens a dialog whose danger confirm, last, posts the remove; it is off for a rule with no stored row", async () => {
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    fireEvent.click(within(li).getByRole("button", { name: /^More:/ }));
    fireEvent.click(within(li).getByRole("menuitem", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    const buttons = within(dialog).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(["Cancel", "Remove"]);
    fireEvent.click(buttons[1]!);
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(String(posts[0]!.init.body))).toEqual({ rule: "spec-t1", action: "remove" });
    cleanup();
    view = { ...standing(), rules: [{ ...standing().rules[0]!, created_at: null, set_by: null }] };
    const fresh = await show();
    const row = ruleItem(fresh, "spec-t1");
    fireEvent.click(within(row).getByRole("button", { name: /^More:/ }));
    expect((within(row).getByRole("menuitem", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("a refused change keeps its dialog open and says which permission is missing", async () => {
    answer = { status: 403, body: { error: "Changing a standing rule needs the approve_spec permission: no_role." } };
    const list = await show();
    fireEvent.click(within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "Approves risk level 1 plans for you" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Turn on" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("approve_spec permission");
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("Accept (visible) and Decline (in the ⋯ menu) post the proposal's answer", async () => {
    hold = true;
    await show();
    const li = proposalRow();
    // Accept is the row's one visible action; Decline is an item of its ⋯ menu.
    expect(within(li).queryByRole("button", { name: "Decline" })).toBeNull();
    const accept = within(li).getByRole("button", { name: "Accept" }) as HTMLButtonElement;
    fireEvent.click(accept);
    await waitFor(() => expect(posts).toHaveLength(1));
    // The actions are disabled while the Accept write is in flight; Decline is chosen once it answers.
    expect(accept.disabled).toBe(true);
    release.shift()!();
    await waitFor(() => expect(accept.disabled).toBe(false));
    fireEvent.click(within(li).getByRole("button", { name: /^More:/ }));
    fireEvent.click(within(li).getByRole("menuitem", { name: "Decline" }));
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
    const proposal = proposalRow();
    fireEvent.click(within(proposal).getByRole("button", { name: /^More:/ }));
    fireEvent.click(within(proposal).getByRole("menuitem", { name: "Decline" }));
    expect((await within(proposal).findByRole("alert")).textContent).toContain("approve_spec");
    expect(within(ruleItem(list, "spec-t1")).queryByRole("alert")).toBeNull();
  });

  it("a rule that fired shows when, relative, and links each item of the last 7 days by its title, with no item ID", async () => {
    const fired = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    view = { ...view, rules: [{ ...view.rules[0]!, enabled: true, last_fired_at: fired, recent: [{ id: "wi_abc", title: "Fix the login" }, { id: "wi_def", title: "Ship docs" }] }] };
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    expect(li.querySelector("[data-fired]")!.textContent).toBe("last fired 5m ago");
    expect(li.querySelector("[data-recent]")!.textContent).toBe("2 items in the last 7 days: Fix the login, Ship docs");
    const links = within(li.querySelector<HTMLElement>("[data-recent]")!).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([["Fix the login", "/app/items/wi_abc"], ["Ship docs", "/app/items/wi_def"]]);
    // No ID, actor or ISO time outside Details.
    const copy = li.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    for (const raw of ["wi_abc", "spec-t1", "standing:", fired]) expect(copy.textContent).not.toContain(raw);
    expect(li.matches("[data-list-row]")).toBe(true);
  });

  it("names at most two approved items, then \"+N more\" that opens Details, which lists them all; no \"on\" text beside the switch", async () => {
    const recent = ["A", "B", "C", "D"].map((title) => ({ id: `wi_${title}`, title }));
    view = { ...view, rules: [{ ...view.rules[0]!, enabled: true, last_fired_at: new Date(Date.now() - 20 * 3600 * 1000).toISOString(), recent }] };
    const list = await show();
    const li = ruleItem(list, "spec-t1");
    const line = li.querySelector<HTMLElement>("[data-recent]")!;
    expect(line.textContent).toBe("4 items in the last 7 days: A, B, +2 more");
    expect(within(line).getAllByRole("link").map((a) => a.textContent)).toEqual(["A", "B"]);
    // Each comma sits in its title's box, so a wrap never leaves it alone on a line; the full title shows on hover.
    expect([...line.querySelectorAll("[data-recent-item]")].map((n) => n.textContent)).toEqual(["A, ", "B, "]);
    expect(within(line).getAllByRole("link").map((a) => a.getAttribute("title"))).toEqual(["A", "B"]);
    expect(li.querySelector("[data-fired]")!.textContent).toBe("last fired 20h ago");
    expect(li.querySelector("[data-details]")!.textContent).not.toMatch(/(^|\s)on(\s|$)/);
    const summary = li.querySelector<HTMLElement>("details[data-raw] > summary")!;
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(within(line).getByRole("button", { name: "+2 more" }));
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect([...li.querySelectorAll("[data-recent-all] a")].map((a) => a.textContent)).toEqual(["A", "B", "C", "D"]);
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
    const switchOf = (list: HTMLElement) => within(ruleItem(list, "spec-t1")).getByRole("switch", { name: "Approves risk level 1 plans for you" });

    /** The row's switch opens the dialog; its confirm (`label`) sends the change. */
    const toggle = async (list: HTMLElement, label: string) => {
      fireEvent.click(switchOf(list));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: label }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    };

    let list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
    await toggle(list, "Pause");
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("false"), SLOW);
    await toggle(list, "Turn on");
    await waitFor(() => expect(switchOf(list).getAttribute("aria-checked")).toBe("true"), SLOW);
    expect(writes).toEqual([false, true]);

    // Reload: a fresh page and query cache read the server again.
    cleanup();
    list = await show();
    expect(switchOf(list).getAttribute("aria-checked")).toBe("true");
  }, TEST_MS);
});

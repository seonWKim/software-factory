// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRow, ScheduleRunRow } from "../web/src/api.js";
import { PAGES } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-calendar-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/schedules.js";
const { SchedulesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SchedulesPage: FunctionComponent };

// The Schedules page over a faked server (design 09-dashboard-schedules): a table of schedules with a Switch and a
// "⋯" menu per row, the selected schedule's runs, and New schedule and Edit in one Dialog. The routes themselves are
// tested over the real store in the phase 1 tests.

const SLOW = { timeout: 5_000 };
const TOKEN = "tok_schedules";
const schedule = (id: string, title: string, over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id, title, cadence: { kind: "daily", spec: "09:00" }, zone: "Europe/Paris", next_due_at: "2026-11-25T08:00:00.000Z", running_since: null,
  skip_when_busy: false, action: { kind: "build", settings: { body: "Check the docs." } }, token_cap: null, ...over,
});

let schedules: ScheduleRow[];
let runs: Record<string, ScheduleRunRow[]>;
let posts: { path: string; body: Record<string, unknown>; token: string | null }[];
/** What the next write answers, when it is not a success. */
let refusal: string | null;

beforeEach(() => {
  schedules = [schedule("sch_aaaa1111", "Nightly docs check"), schedule("sch_bbbb2222", "Weekly review", { next_due_at: null, cadence: { kind: "weekly", spec: "mon 09:00" } })];
  runs = {
    sch_aaaa1111: [
      { schedule_id: "sch_aaaa1111", occurrence_at: "2026-11-23T08:00:00.000Z", outcome: "fired", recorded_at: "2026-11-23T08:00:05.000Z", output: "Found two stale pages.", cost_usd: 0.0123 },
      { schedule_id: "sch_aaaa1111", occurrence_at: "2026-11-24T08:00:00.000Z", outcome: "skipped", recorded_at: "2026-11-24T08:00:05.000Z" },
    ],
    sch_bbbb2222: [],
  };
  posts = [];
  refusal = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: TOKEN, actor: "local:owner", commands_enabled: true });
    if (u.pathname === "/api/v1/schedules" && !init?.method) return json(200, { schedules });
    if (u.pathname === "/api/v1/schedules/runs") return json(200, { runs: runs[u.searchParams.get("schedule")!] ?? [] });
    if (init?.method === "POST" && u.pathname.startsWith("/api/v1/schedules/")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path: u.pathname.slice("/api/v1/schedules/".length), body, token: new Headers(init.headers).get("x-csrf-token") });
      if (refusal !== null) return json(409, { error: refusal });
      return json(200, { schedule: schedules[0] });
    }
    return json(404, { error: "Not found." });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SchedulesPage)));
/** The row of a schedule by its title. */
const row = async (title: string) => (await screen.findByText(title, undefined, SLOW)).closest("tr")!;
const ready = async () => {
  await row("Nightly docs check");
  await waitFor(() => expect((screen.getByRole("button", { name: "New schedule" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
};

describe("Schedules page", () => {
  it("lists the schedules in a table inside a Card, a Switch on for a scheduled one and off for a paused one", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Schedules" }, SLOW);
    expect(table.closest("section")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Schedules" })).toBeTruthy();
    const on = within(await row("Nightly docs check")).getByRole("switch");
    const off = within(await row("Weekly review")).getByRole("switch");
    expect([on.getAttribute("aria-checked"), off.getAttribute("aria-checked")]).toEqual(["true", "false"]);
    expect(within(await row("Weekly review")).getByText("Paused")).toBeTruthy();
    expect(within(await row("Nightly docs check")).getByText("Every day at 09:00")).toBeTruthy();
  });

  it("shows no raw ID", async () => {
    show();
    await ready();
    expect(document.body.textContent).not.toMatch(/sch_[a-z0-9]+/);
  });

  it("New schedule is the page's one primary action, in the header", async () => {
    show();
    await ready();
    const header = screen.getByRole("heading", { level: 1 }).closest("header")!;
    expect(within(header).getByRole("button", { name: "New schedule" })).toBeTruthy();
    expect(document.querySelectorAll("button.bg-accent")).toHaveLength(1);
  });

  it("the Switch posts pause for a scheduled row and resume for a paused one, with the CSRF token", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("switch"));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "pause", body: { id: "sch_aaaa1111" }, token: TOKEN });
    await waitFor(() => expect((within(screen.getByRole("table", { name: "Schedules" })).getAllByRole("switch")[0] as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(within(await row("Weekly review")).getByRole("switch"));
    await waitFor(() => expect(posts).toHaveLength(2), SLOW);
    expect(posts[1]).toEqual({ path: "resume", body: { id: "sch_bbbb2222" }, token: TOKEN });
  });

  it("the row menu holds Run now and Edit; Run now posts run, and is off while the schedule is paused", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Weekly review")).getByRole("button", { name: "More for Weekly review" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Run now", "Edit"]);
    expect((screen.getByRole("menuitem", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(posts).toEqual([{ path: "run", body: { id: "sch_aaaa1111" }, token: TOKEN }]), SLOW);
  });

  it("shows the server's refusal of a write in a Notice", async () => {
    refusal = "changed by another worker, try again";
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("switch"));
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toContain("changed by another worker, try again");
  });

  it("selecting a row shows its runs in a second Card: started, result, cost and output, newest first", async () => {
    show();
    await ready();
    expect(screen.getByText("Select a schedule to see its runs.")).toBeTruthy();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show runs of Nightly docs check" }));
    const table = await screen.findByRole("table", { name: "Runs" }, SLOW);
    expect(table.closest("section")).not.toBe(screen.getByRole("table", { name: "Schedules" }).closest("section"));
    expect([...table.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Started", "Result", "Cost", "Output"]);
    const body = [...table.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
    expect(body[0]?.[1]).toBe("Skipped: factory busy");
    expect(body[1]?.slice(1)).toEqual(["Ran", "$0.0123", "Found two stale pages."]);
  });

  it("New schedule opens a Dialog with the CLI's fields and posts them with a title-made ID that is not shown", async () => {
    // An ID the title would make is taken, so the new one gets a number after it.
    schedules[0] = { ...schedules[0]!, id: "nightly-docs-check" };
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    for (const label of ["Title", "Repeats", "When", "Time zone", "Does", "Text", "Skip while the factory is busy", "Token limit"]) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Nightly docs check" } });
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Look for stale pages." } });
    fireEvent.click(within(dialog).getByLabelText("Skip while the factory is busy"));
    fireEvent.change(within(dialog).getByLabelText("Token limit"), { target: { value: "5000" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.path).toBe("add");
    expect(posts[0]!.body).toMatchObject({ id: "nightly-docs-check-2", title: "Nightly docs check", cadence: "daily", spec: "09:00", action: "build", body: "Look for stale pages.", skip_when_busy: true, token_cap: 5000 });
    expect(typeof posts[0]!.body.zone).toBe("string");
  });

  it("a blank token limit is left out of an add", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Plain" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect("token_cap" in posts[0]!.body).toBe(false);
  });

  it("Edit opens the same Dialog filled in and sends only the fields that changed", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Nightly docs check");
    expect((within(dialog).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("Check the docs.");
    fireEvent.change(within(dialog).getByLabelText("When"), { target: { value: "10:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "edit", body: { id: "sch_aaaa1111", cadence: "daily", spec: "10:30" }, token: TOKEN });
  });

  it("a refused save stays in the Dialog with the reason", async () => {
    refusal = "a daily cadence is HH:MM, not \"late\"";
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Late" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(within(dialog).getByText(/a daily cadence is HH:MM/)).toBeTruthy(), SLOW);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("the sidebar lists Schedules after Calendar in the Tasks block, and the page is routed at /app/schedules", () => {
    const tasks = PAGES.filter((p) => p.group === "tasks").map((p) => p.path);
    expect(tasks.indexOf("schedules")).toBe(tasks.indexOf("calendar") + 1);
    expect(PAGES.find((p) => p.path === "schedules")?.label).toBe("Schedules");
  });
});

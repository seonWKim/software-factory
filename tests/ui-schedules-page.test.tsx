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
const BADGE_MODULE = "../web/src/components/ui/badge.js";

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
/** The row of a schedule by its title (the selected one's detail Card shows the title too). */
const row = async (title: string) => (await screen.findAllByText(title, undefined, SLOW)).map((e) => e.closest("tr")).find((r) => r !== null)!;
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
    expect(within(await row("Weekly review")).getAllByText("Paused")).toHaveLength(2);
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
    expect(screen.getByText("Select a schedule to see what it does and its runs.")).toBeTruthy();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    const table = await screen.findByRole("table", { name: "Runs" }, SLOW);
    expect(table.closest("section")).not.toBe(screen.getByRole("table", { name: "Schedules" }).closest("section"));
    expect([...table.querySelectorAll("th")].map((h) => h.textContent)).toEqual(["Started", "Result", "Cost", "Output"]);
    const body = [...table.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
    expect(body[0]?.[1]).toBe("Skipped: factory busy");
    expect(body[1]?.slice(1)).toEqual(["Ran", "$0.0123", "Found two stale pages."]);
  });

  it("each title has one muted line under it saying what the schedule does: its text's first sentence, else what its action does (owner #84)", async () => {
    schedules.push(
      schedule("sch_persona", "Daily design check", { action: { kind: "feedback", settings: { prompt: "Once a day, an agent playing a designer files tasks. It reads the code.\nYou are the gongbang-designer persona." } } }),
      schedule("sch_blank", "Empty build", { action: { kind: "build", settings: {} } }),
    );
    show();
    const summary = async (title: string) => (await row(title)).querySelector<HTMLElement>("[data-summary]")!;
    expect((await summary("Daily design check")).textContent).toBe("Once a day, an agent playing a designer files tasks.");
    // Cut to one line with the whole sentence in its tooltip, so every row keeps one height.
    expect((await summary("Daily design check")).title).toBe("Once a day, an agent playing a designer files tasks.");
    expect((await summary("Daily design check")).className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "text-text-2"]));
    expect((await summary("Empty build")).textContent).toBe("Files a task with this text, and the factory builds it like any other task");
    // The line sits inside the title cell; the row's other cells are unchanged.
    expect((await row("Daily design check")).querySelectorAll("td")[0]!.contains(await summary("Daily design check"))).toBe(true);
    // Does says what a persona schedule does, not "Reviews feedback".
    expect((await row("Daily design check")).textContent).toContain("Gives feedback as tasks");
  });

  it("selecting a schedule shows what it does above its runs: its whole text behind Show more, the action, repeats, zone, busy rule, token limit, last and next run", async () => {
    schedules[0] = schedule("sch_aaaa1111", "Nightly docs check", { token_cap: 50_000, skip_when_busy: true, action: { kind: "feedback", settings: { prompt: "Once a day, check the docs.\nYou are the docs persona." } } });
    show();
    await ready();
    expect(document.querySelector("[data-schedule-detail]")).toBeNull();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    const detail = await screen.findByRole("region", { name: "About Nightly docs check" }, SLOW);
    const runsCard = (await screen.findByRole("table", { name: "Runs" }, SLOW)).closest("section")!;
    // The detail Card comes before the Runs Card.
    expect(detail.compareDocumentPosition(runsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const dl = detail.querySelector("dl")!;
    expect(dl.className).toContain("grid-cols-[max-content_minmax(0,1fr)]");
    const pairs = Object.fromEntries([...dl.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));
    expect(pairs["What it does"]).toContain("Once a day, check the docs.\nYou are the docs persona.");
    expect(pairs["Does"]).toBe("Gives feedback as tasks. An agent takes the role this text describes, reads the code and files up to 3 tasks, each with evidence");
    expect(pairs["Repeats"]).toBe("Every day at 09:00");
    expect(pairs["Time zone"]).toBe("Europe/Paris");
    expect(pairs["While the factory is busy"]).toBe("Skips the run");
    expect(pairs["Token limit"]).toBe("50,000");
    await waitFor(() => expect(Object.fromEntries([...dl.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))["Last run"]).not.toBe(""), SLOW);
    expect([...dl.querySelectorAll("dd")].every((dd) => dd.className.includes("min-w-0") && dd.className.includes("wrap-anywhere"))).toBe(true);
    // The text is clamped to two lines (the shared Clamp), not cut by the page.
    expect(dl.querySelector("dd p")!.className).toContain("line-clamp-2");
  });

  it("a schedule with no token limit shows the default, and one that has not run says so", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Weekly review")).getByRole("button", { name: "Show what Weekly review does and its runs" }));
    const detail = await screen.findByRole("region", { name: "About Weekly review" }, SLOW);
    await waitFor(() => expect(detail.textContent).toContain("Not run yet"), SLOW);
    expect(detail.textContent).toContain("Default (200,000)");
    expect(detail.textContent).toContain("Runs anyway");
  });

  it("the selected schedule's row is marked current, not its title drawn as a pressed pill", async () => {
    show();
    await ready();
    const title = within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" });
    fireEvent.click(title);
    await waitFor(() => expect((title.closest("tr") as HTMLElement).getAttribute("aria-current")).toBe("true"), SLOW);
    expect(title.getAttribute("aria-pressed")).toBe("true");
    expect((await row("Weekly review")).getAttribute("aria-current")).toBeNull();
    expect(title.className).not.toMatch(/aria-pressed:bg-surface-2/);
  });

  it("Repeats reads in the Routines page's plain words: capitalised day names and the time after at", async () => {
    show();
    const repeats = async (title: string) => (await row(title)).querySelectorAll("td")[1]!.textContent;
    expect(await repeats("Nightly docs check")).toBe("Every day at 09:00");
    expect(await repeats("Weekly review")).toBe("Weekly on Mon at 09:00");
  });

  it("a paused schedule's Next run says Paused, not an empty cell", async () => {
    show();
    expect((await row("Weekly review")).querySelectorAll("td")[2]!.textContent).toBe("Paused");
  });

  it("every State is the shared Badge pill, and a neutral one in the selected row keeps a fill of its own", async () => {
    const { NEUTRAL_IN_CURRENT } = (await import(/* @vite-ignore */ BADGE_MODULE)) as { NEUTRAL_IN_CURRENT: string };
    schedules.push(schedule("sch_cccc3333", "Running one", { running_since: "2026-11-24T08:00:00.000Z" }));
    show();
    await ready();
    const pill = async (title: string) => (await row(title)).querySelectorAll("td")[3]!.querySelector("[data-level]") as HTMLElement;
    expect((await pill("Nightly docs check")).dataset["level"]).toBe("waiting");
    expect((await pill("Weekly review")).dataset["level"]).toBe("paused");
    expect((await pill("Running one")).dataset["level"]).toBe("running");
    // The neutral pill's fill is surface-2, the current row's fill too: without its own fill there it reads as a bare dot.
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    await waitFor(async () => expect((await row("Nightly docs check")).getAttribute("aria-current")).toBe("true"), SLOW);
    expect((await pill("Nightly docs check")).className).toContain(NEUTRAL_IN_CURRENT);
    expect((await pill("Running one")).className).not.toContain(NEUTRAL_IN_CURRENT);
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

  it("stacks its Cards as the other pages do, on the Card's own margin, with no flex gap added on top of it", async () => {
    show();
    await ready();
    const sections = [...document.querySelectorAll("section")];
    expect(sections).toHaveLength(2);
    // Card carries mt-6; a flex column with gap-6 around it doubled the space between the list and the runs Card.
    for (const s of sections) expect(s.parentElement!.className).not.toMatch(/\bgap-/);
    expect(sections[0]!.parentElement).toBe(sections[1]!.parentElement);
  });

  it("the sidebar lists Schedules after Calendar in the Tasks block, and the page is routed at /app/schedules", () => {
    const tasks = PAGES.filter((p) => p.group === "tasks").map((p) => p.path);
    expect(tasks.indexOf("schedules")).toBe(tasks.indexOf("calendar") + 1);
    expect(PAGES.find((p) => p.path === "schedules")?.label).toBe("Schedules");
  });
});

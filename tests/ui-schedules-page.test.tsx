// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScheduleRow, ScheduleRunRow, ScheduleSuggestionRow } from "../web/src/api.js";
import { PAGES } from "../web/src/pages.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-calendar-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/schedules.js";
const { SchedulesTab } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { SchedulesTab: FunctionComponent<{ switcher: unknown }> };
const BADGE_MODULE = "../web/src/components/ui/badge.js";

// The Schedules page over a faked server (design 09-dashboard-schedules): a table of schedules with a Switch and a
// "⋯" menu per row, the selected schedule's runs, and New schedule and Edit in one Dialog. The routes themselves are
// tested over the real store in the phase 1 tests.

const SLOW = { timeout: 5_000 };
/** The missed-time rule's Select, in the owner's words. */
const MISSED = "If the factory was off or busy at the time";
const RUN_NOW = "Run now too";
/** Picks a choice of the dialog's Select (the shared one draws its own list): opens it, then clicks the option. */
const pick = (dialog: HTMLElement, label: string, choice: string) => {
  fireEvent.click(within(dialog).getByLabelText(label));
  fireEvent.click(within(dialog).getByRole("option", { name: choice }));
};
const TOKEN = "tok_schedules";
const schedule = (id: string, title: string, over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id, title, cadence: { kind: "daily", spec: "09:00" }, zone: "Europe/Paris", next_due_at: "2026-11-25T08:00:00.000Z", running_since: null,
  skip_when_busy: false, action: { kind: "build", settings: { body: "Check the docs." } }, token_cap: null, trigger: null, paused: false, run_cap_usd: null, daily_cap_usd: null, ...over,
});
/** A Check a page schedule, as the list route stores it. */
const pageSchedule = (id: string, title: string, over: Partial<ScheduleRow> = {}): ScheduleRow =>
  schedule(id, title, { action: { kind: "check_page", settings: { instruction: "Find broken links.", url: "https://example.com/docs" } }, ...over });
const onMerge = (id: string, title: string, over: Partial<ScheduleRow> = {}) => pageSchedule(id, title, { cadence: null, trigger: "merge", next_due_at: null, zone: "UTC", ...over });

let schedules: ScheduleRow[];
let runs: Record<string, ScheduleRunRow[]>;
let suggestions: Record<string, ScheduleSuggestionRow[]>;
let posts: { path: string; body: Record<string, unknown>; token: string | null }[];
/** What the next write answers, when it is not a success. */
let refusal: string | null;
/** The draft and improve requests, apart from the writes; a model failure the next one answers with. */
let proposals: { path: string; body: Record<string, unknown> }[];
let modelFailure: string | null;

beforeEach(() => {
  schedules = [schedule("sch_aaaa1111", "Nightly docs check"), schedule("sch_bbbb2222", "Weekly review", { next_due_at: null, cadence: { kind: "weekly", spec: "mon 09:00" } })];
  runs = {
    sch_aaaa1111: [
      { schedule_id: "sch_aaaa1111", occurrence_at: "2026-11-23T08:00:00.000Z", outcome: "fired", recorded_at: "2026-11-23T08:00:05.000Z", transcript: null, output: "Found two stale pages.", cost_usd: 0.0123 },
      { schedule_id: "sch_aaaa1111", occurrence_at: "2026-11-24T08:00:00.000Z", outcome: "skipped", recorded_at: "2026-11-24T08:00:05.000Z", transcript: null },
    ],
    sch_bbbb2222: [],
  };
  suggestions = {};
  posts = [];
  refusal = null;
  proposals = [];
  modelFailure = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: TOKEN, actor: "local:owner", commands_enabled: true });
    if (u.pathname === "/api/v1/schedules" && !init?.method) return json(200, { schedules });
    if (u.pathname === "/api/v1/schedules/suggestions") return json(200, { suggestions: suggestions[u.searchParams.get("schedule")!] ?? [] });
    if (u.pathname === "/api/v1/schedules/runs") return json(200, { runs: runs[u.searchParams.get("schedule")!] ?? [] });
    if (init?.method === "POST" && (u.pathname === "/api/v1/schedules/draft" || u.pathname === "/api/v1/schedules/improve")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      proposals.push({ path: u.pathname.slice("/api/v1/schedules/".length), body });
      if (modelFailure !== null) return json(503, { error: modelFailure });
      if (u.pathname.endsWith("/draft")) {
        return json(200, { proposal: { id: "sch_zzzz9999", fields: { title: "Drafted title", cadence: "weekly", spec: "mon 08:00", zone: "Europe/Paris", action: "agent", body: "Summarise the week." } } });
      }
      return json(200, { proposal: { id: body.id, old: "Check the docs.", new: "Check the docs.\n  Then list stale pages." } });
    }
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(SchedulesTab, { switcher: createElement("span", { "data-switcher": "" }, "tabs") })));
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
    expect(screen.queryByRole("heading", { level: 1 })).toBeNull();
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

  it("New schedule is the page's one primary action, in the toolbar after the tab switch", async () => {
    show();
    await ready();
    const toolbar = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(toolbar.firstElementChild!.getAttribute("data-switcher")).toBe("");
    expect(within(toolbar).getByRole("button", { name: "New schedule" })).toBeTruthy();
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

  it("the row menu holds Run now, Edit, Pause or Resume, a separator and Delete; Run now posts run, and is off while the schedule is paused", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Weekly review")).getByRole("button", { name: "More for Weekly review" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Run now", "Edit", "Resume", "Delete"]);
    expect([...menu.children].map((li) => (li.getAttribute("role") === "separator" ? "|" : li.textContent))).toEqual(["Run now", "Edit", "Resume", "|", "Delete"]);
    const del = screen.getByRole("menuitem", { name: "Delete" });
    expect(del.className).toContain("text-pill-bad-fg");
    expect(del.querySelector("svg")).toBeTruthy();
    expect((screen.getByRole("menuitem", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    expect(screen.getByRole("menuitem", { name: "Pause" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Run now" }));
    await waitFor(() => expect(posts).toEqual([{ path: "run", body: { id: "sch_aaaa1111" }, token: TOKEN }]), SLOW);
  });

  it("Delete asks in a danger Dialog; confirming posts once, the row goes, the detail Card closes and the focus goes to the table", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    await screen.findByRole("region", { name: "About Nightly docs check" }, SLOW);
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete Nightly docs check?");
    expect(dialog.textContent).toContain("It stops running. Past runs stay in Work.");
    expect(posts).toEqual([]);
    // The server forgets it once the delete lands, so the reread has one row.
    schedules = schedules.filter((s) => s.id !== "sch_aaaa1111");
    const confirm = within(dialog).getByRole("button", { name: "Delete schedule" });
    expect(confirm.className).toContain("bg-failed");
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts).toEqual([{ path: "delete", body: { id: "sch_aaaa1111" }, token: TOKEN }]);
    await waitFor(() => expect(screen.queryAllByText("Nightly docs check")).toHaveLength(0), SLOW);
    expect(screen.queryByRole("region", { name: "About Nightly docs check" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(document.querySelector("[data-schedules-table]")), SLOW);
  });

  it("Cancel in the delete Dialog posts nothing; the detail Card's Delete opens the same Dialog", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    const card = await screen.findByRole("region", { name: "About Nightly docs check" }, SLOW);
    fireEvent.click(within(card).getByRole("button", { name: "Delete Nightly docs check" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts).toEqual([]);
    expect(await row("Nightly docs check")).toBeTruthy();
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

  /** Selects Nightly docs check with one run whose output is `output`, and returns that run's Output cell. */
  const outputCell = async (output: string) => {
    runs.sch_aaaa1111 = [{ schedule_id: "sch_aaaa1111", occurrence_at: "2026-11-23T08:00:00.000Z", outcome: "fired", recorded_at: "2026-11-23T08:00:05.000Z", transcript: null, output, cost_usd: 0.5 }];
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    const table = await screen.findByRole("table", { name: "Runs" }, SLOW);
    return [...table.querySelectorAll<HTMLElement>("tbody tr td")].at(-1)!;
  };
  /** The text a reader sees outside `[data-raw]` (stored text) in `el`. */
  const plainText = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-raw]").forEach((r) => r.remove());
    return copy.textContent ?? "";
  };
  const FILED = "wi_29b26f39e33d40c59a22b72dff5e2d91";
  const feedback = (filed: { id: string; title: string; created: boolean }[], unfiled: { title: string; reason: string }[] = []) => JSON.stringify({ filed, unfiled });

  it("a feedback run's output reads as Filed N items over its titles, each a link to its item page, with no JSON or ID in the text (owner: output should be readable)", async () => {
    const cell = await outputCell(feedback(
      [
        { id: FILED, title: "Margin guard allows whole files", created: true },
        { id: "wi_00779d00000000000000000000000000", title: "Dialog and popover titles", created: false },
      ],
      [{ title: "Tidy the footer", reason: "no_evidence" }],
    ));
    expect(cell.querySelector("p")!.textContent).toBe("Filed 2 items");
    const links = within(cell).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Margin guard allows whole files", "Dialog and popover titles"]);
    expect(links[0]!.getAttribute("href")).toMatch(new RegExp(`/items/${FILED}$`));
    expect(cell.textContent).toContain("Already filed");
    expect(cell.textContent).toContain("Tidy the footer");
    expect(cell.textContent).toContain("Not filed: no evidence from the code");
    expect(cell.textContent).not.toMatch(/[{}]|wi_|no_evidence|"filed"/);
    // The stored text stays one press away, for debugging, inside [data-raw].
    fireEvent.click(within(cell).getByText("Raw output"));
    const raw = cell.querySelector("pre [data-raw]")!;
    expect(raw.textContent).toContain(FILED);
    expect(plainText(cell)).not.toMatch(/[{}]|wi_|no_evidence/);
  });

  it("a long filed list shows three entries and opens the rest in place with Show N more, so the row keeps a sensible height", async () => {
    const cell = await outputCell(feedback(["One", "Two", "Three", "Four", "Five"].map((title, i) => ({ id: `wi_${i}aaaaaaaa`, title, created: true }))));
    expect(within(cell).getAllByRole("link").map((a) => a.textContent)).toEqual(["One", "Two", "Three"]);
    fireEvent.click(within(cell).getByRole("button", { name: "Show 2 more" }));
    expect(within(cell).getAllByRole("link")).toHaveLength(5);
  });

  it("a feedback run that filed nothing says Nothing filed", async () => {
    const cell = await outputCell(feedback([]));
    expect(cell.querySelector("p")!.textContent).toBe("Nothing filed");
    expect(within(cell).queryAllByRole("link")).toHaveLength(0);
  });

  it("another JSON output reads as key: value lines, never a JSON blob, with the raw text behind Raw output", async () => {
    const cell = await outputCell(JSON.stringify({ checked: 12, broken: ["a", "b"], ok: false }));
    const terms = [...cell.querySelectorAll("dt")].map((d) => d.textContent);
    const values = [...cell.querySelectorAll("dd")].map((d) => d.textContent);
    expect(terms).toEqual(["checked", "broken", "ok"]);
    expect(values).toEqual(["12", "2 entries", "false"]);
    expect(cell.textContent).not.toMatch(/[{}[\]]/);
    expect(within(cell).getByText("Raw output")).toBeTruthy();
  });

  it("a plain text output shows as written, with no Raw output", async () => {
    const cell = await outputCell("Found two stale pages.\nBoth under docs/.");
    expect(cell.textContent).toBe("Found two stale pages.\nBoth under docs/.");
    expect(within(cell).queryByText("Raw output")).toBeNull();
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

  it("a long title is cut to the column's width, whole in its tooltip, so it never widens the table past a tablet's edge", async () => {
    const long = "Weekly check of the public pricing page for broken links, stale prices and out-of-date plan names";
    schedules.push(schedule("sch_long", long));
    show();
    const title = [...(await row(long)).querySelectorAll<HTMLElement>("td span")].find((el) => el.textContent === long && !el.hasAttribute("data-summary"))!;
    expect(title.title).toBe(long);
    expect(title.className.split(/\s+/)).toEqual(expect.arrayContaining(["w-0", "min-w-full", "truncate"]));
  });

  it("a long Repeats wraps between words on a narrow table instead of pushing the Switch and the menu past a tablet's edge", async () => {
    schedules.push(schedule("sch_two_days", "Pricing check", { cadence: { kind: "weekly", spec: "mon,thu 09:00" } }));
    show();
    const cell = [...(await row("Pricing check")).querySelectorAll("td")].find((td) => td.textContent === "Weekly on Mon and Thu at 09:00")!;
    expect(cell.className.split(/\s+/)).not.toContain("whitespace-nowrap");
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
    expect(pairs["If the factory was off or busy at the time"]).toBe("Skip that time");
    expect(detail.textContent).not.toMatch(/While the factory is busy|Skips the run|Runs anyway/);
    expect(pairs["Token limit"]).toBe("50,000");
    await waitFor(() => expect(Object.fromEntries([...dl.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]))["Last run"]).not.toBe(""), SLOW);
    expect([...dl.querySelectorAll("dd")].every((dd) => dd.className.includes("min-w-0") && dd.className.includes("wrap-anywhere"))).toBe(true);
    // The text is clamped to two lines (the shared Clamp), not cut by the page.
    expect(dl.querySelector("dd p")!.className).toContain("line-clamp-2");
  });

  it("a run row links its transcript when its claim started one, and shows no link when none", async () => {
    runs.sch_aaaa1111![0]!.transcript = "/app/items/wi_9/runs/run_9";
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    const table = await screen.findByRole("table", { name: "Runs" }, SLOW);
    const links = within(table).getAllByRole("link", { name: /Transcript of the run due/ });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toBe("/app/items/wi_9/runs/run_9");
  });

  it("a summary schedule setup adds shows its Last run and Next run in its detail Card", async () => {
    schedules.push(schedule("summary-morning", "Morning summary", { action: { kind: "summary", settings: {} }, cadence: { kind: "interval", spec: "15" }, next_due_at: "2026-11-25T08:15:00.000Z" }));
    runs["summary-morning"] = [{ schedule_id: "summary-morning", occurrence_at: "2026-11-25T08:00:00.000Z", outcome: "fired", recorded_at: "2026-11-25T08:00:05.000Z", transcript: null, output: "nothing to report" }];
    show();
    await ready();
    fireEvent.click(within(await row("Morning summary")).getByRole("button", { name: "Show what Morning summary does and its runs" }));
    const detail = await screen.findByRole("region", { name: "About Morning summary" }, SLOW);
    const pairs = () => Object.fromEntries([...detail.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));
    await waitFor(() => expect(pairs()["Last run"]).toMatch(/Nov 2[45], 2026/), SLOW);
    expect(pairs()["Next run"]).toMatch(/Nov 2[45], 2026/);
    expect(pairs()["Does"]).toMatch(/^Sends you a summary/);
    expect(pairs()["Repeats"]).toBe("Every 15 minutes");
  });

  it("a schedule with no token limit shows the default, and one that has not run says so", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Weekly review")).getByRole("button", { name: "Show what Weekly review does and its runs" }));
    const detail = await screen.findByRole("region", { name: "About Weekly review" }, SLOW);
    await waitFor(() => expect(detail.textContent).toContain("Not run yet"), SLOW);
    expect(detail.textContent).toContain("Default (200,000)");
    expect(detail.textContent).toContain("If the factory was off or busy at the timeRun once when it's back");
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
    for (const label of ["Title", "Repeats", "When", "Time zone", "Does", "Text", MISSED, "Token limit"]) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    expect(within(dialog).queryByLabelText("Skip while the factory is busy")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Nightly docs check" } });
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Look for stale pages." } });
    pick(dialog, MISSED, "Skip that time");
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

  const openNew = async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    return screen.findByRole("dialog", undefined, SLOW);
  };
  const openEdit = async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    return screen.findByRole("dialog", undefined, SLOW);
  };
  const press = (dialog: HTMLElement, name: string) => fireEvent.click(within(dialog).getByRole("button", { name }));

  /** The picked choice of the missed-time Select, as its field shows it. */
  const missedText = (dialog: HTMLElement) => within(dialog).getByLabelText(MISSED).textContent;

  it("the missed-time Select offers Run once when it's back and Skip that time; New starts on Run once when it's back", async () => {
    const dialog = await openNew();
    expect(missedText(dialog)).toBe("Run once when it's back");
    fireEvent.click(within(dialog).getByLabelText(MISSED));
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Run once when it's back", "Skip that time"]);
  });

  it("Edit starts the missed-time Select on Skip that time for a skip_when_busy schedule, and sends the change as skip_when_busy", async () => {
    schedules[0] = { ...schedules[0]!, skip_when_busy: true };
    const dialog = await openEdit();
    expect(missedText(dialog)).toBe("Skip that time");
    pick(dialog, MISSED, "Run once when it's back");
    press(dialog, "Save");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toEqual({ id: "sch_aaaa1111", skip_when_busy: false });
  });

  it("Edit starts on Run once when it's back for a schedule that does not skip, and never shows Run now too", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 25, 12, 0) });
    const dialog = await openEdit();
    expect(missedText(dialog)).toBe("Run once when it's back");
    expect(within(dialog).queryByLabelText(RUN_NOW)).toBeNull();
  });

  it("Run now too shows on New only for a daily or weekly time already passed today in the browser's zone, off by default", async () => {
    // A Wednesday, noon in the browser's own zone.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 25, 12, 0) });
    const dialog = await openNew();
    const runNow = () => within(dialog).queryByLabelText(RUN_NOW);
    const set = (label: string, value: string) => fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    set("When", "09:00");
    expect(runNow()!.getAttribute("aria-checked")).toBe("false");
    set("When", "13:00");
    expect(runNow()).toBeNull();
    pick(dialog, "Repeats", "Weekly");
    set("When", "wed,fri 09:00");
    expect(runNow()).toBeTruthy();
    set("When", "mon,fri 09:00");
    expect(runNow()).toBeNull();
    set("When", "wed 13:00");
    expect(runNow()).toBeNull();
    pick(dialog, "Repeats", "At an interval");
    set("When", "30");
    expect(runNow()).toBeNull();
    pick(dialog, "Repeats", "Cron rule");
    set("When", "0 9 * * *");
    expect(runNow()).toBeNull();
  });

  it("Add posts run_now: true when Run now too is on, and no run_now when it is off", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 25, 12, 0) });
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Now too" } });
    fireEvent.change(within(dialog).getByLabelText("When"), { target: { value: "09:00" } });
    fireEvent.click(within(dialog).getByLabelText(RUN_NOW));
    press(dialog, "Add schedule");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toMatchObject({ id: "now-too", spec: "09:00", skip_when_busy: false, run_now: true });
    cleanup();
    posts = [];
    const again = await openNew();
    fireEvent.change(within(again).getByLabelText("Title"), { target: { value: "Later" } });
    fireEvent.change(within(again).getByLabelText("When"), { target: { value: "09:00" } });
    press(again, "Add schedule");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect("run_now" in posts[0]!.body).toBe(false);
  });

  it("New schedule shows Describe what should run and when over a text box, with a Draft button, and sends nothing until Draft is pressed", async () => {
    const dialog = await openNew();
    expect(within(dialog).getByLabelText("Describe what should run and when").tagName).toBe("TEXTAREA");
    expect(within(dialog).getByRole("button", { name: "Draft" })).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Improve" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Describe what should run and when"), { target: { value: "weekly summary" } });
    expect(proposals).toHaveLength(0);
  });

  it("Draft posts the words, fills the fields, leaves the busy rule and token limit, and rings the fields it changed until they are edited", async () => {
    const dialog = await openNew();
    pick(dialog, MISSED, "Skip that time");
    fireEvent.change(within(dialog).getByLabelText("Token limit"), { target: { value: "700" } });
    fireEvent.change(within(dialog).getByLabelText("Describe what should run and when"), { target: { value: "every monday summarise the week" } });
    press(dialog, "Draft");
    await waitFor(() => expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Drafted title"), SLOW);
    expect(proposals).toEqual([{ path: "draft", body: { words: "every monday summarise the week" } }]);
    expect((within(dialog).getByLabelText("When") as HTMLInputElement).value).toBe("mon 08:00");
    expect((within(dialog).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("Summarise the week.");
    expect(within(dialog).getByLabelText("Repeats").textContent).toContain("Weekly");
    expect(within(dialog).getByLabelText("Does").textContent).toContain("Asks an agent");
    expect((within(dialog).getByLabelText("Token limit") as HTMLInputElement).value).toBe("700");
    expect(within(dialog).getByLabelText(MISSED).textContent).toBe("Skip that time");
    const title = within(dialog).getByLabelText("Title");
    expect(title.hasAttribute("data-changed")).toBe(true);
    expect(title.className).toContain("ring-2");
    expect(within(dialog).getByLabelText("Token limit").hasAttribute("data-changed")).toBe(false);
    // The zone is the same as before the draft only if the browser's is Europe/Paris, so it is not asserted either way.
    fireEvent.change(title, { target: { value: "My own title" } });
    expect(title.hasAttribute("data-changed")).toBe(false);
    expect(within(dialog).getByLabelText("When").hasAttribute("data-changed")).toBe(true);
    // Any filled field can still be changed before Add, and Add uses the title-made ID.
    press(dialog, "Add schedule");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toMatchObject({ id: "my-own-title", title: "My own title", cadence: "weekly", spec: "mon 08:00", action: "agent", body: "Summarise the week.", token_cap: 700 });
  });

  it("a failed draft shows a bad Notice in the Dialog and the fields and buttons stay usable", async () => {
    modelFailure = "Draft and Improve are off: no model is configured (plugins.llm).";
    const dialog = await openNew();
    fireEvent.change(within(dialog).getByLabelText("Describe what should run and when"), { target: { value: "weekly summary" } });
    press(dialog, "Draft");
    await waitFor(() => expect(within(dialog).getByText(/no model is configured/)).toBeTruthy(), SLOW);
    expect(within(dialog).getByText(/no model is configured/).closest("[data-tone]")!.getAttribute("data-tone")).toBe("bad");
    expect((within(dialog).getByRole("button", { name: "Draft" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Add schedule" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Still typing" } });
    expect((within(dialog).getByLabelText("Title") as HTMLInputElement).value).toBe("Still typing");
  });

  it("Improve on Edit posts the saved schedule's ID and shows the saved and revised text side by side, whitespace kept; Keep mine leaves Text; it can be pressed again", async () => {
    const dialog = await openEdit();
    expect(within(dialog).queryByLabelText("Describe what should run and when")).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Text"), { target: { value: "Typed but not saved" } });
    expect(proposals).toHaveLength(0);
    press(dialog, "Improve");
    await waitFor(() => expect(within(dialog).getByText("Revised text")).toBeTruthy(), SLOW);
    expect(proposals).toEqual([{ path: "improve", body: { id: "sch_aaaa1111" } }]);
    expect(within(dialog).getByText("Saved text")).toBeTruthy();
    const revised = within(dialog).getByText(/Then list stale pages/);
    expect(revised.className).toContain("whitespace-pre-wrap");
    expect(revised.textContent).toBe("Check the docs.\n  Then list stale pages.");
    press(dialog, "Keep mine");
    expect((within(dialog).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("Typed but not saved");
    expect(within(dialog).queryByText("Revised text")).toBeNull();
    press(dialog, "Improve");
    await waitFor(() => expect(within(dialog).getByText("Revised text")).toBeTruthy(), SLOW);
    expect(proposals).toHaveLength(2);
  });

  it("Use this puts the revised text in Text, Improve can be pressed again, and Save sends Does and Text together and nothing else", async () => {
    const dialog = await openEdit();
    press(dialog, "Improve");
    await waitFor(() => expect(within(dialog).getByText("Revised text")).toBeTruthy(), SLOW);
    press(dialog, "Use this");
    expect((within(dialog).getByLabelText("Text") as HTMLTextAreaElement).value).toBe("Check the docs.\n  Then list stale pages.");
    expect(within(dialog).queryByText("Revised text")).toBeNull();
    press(dialog, "Improve");
    await waitFor(() => expect(within(dialog).getByText("Revised text")).toBeTruthy(), SLOW);
    press(dialog, "Keep mine");
    press(dialog, "Save");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "edit", body: { id: "sch_aaaa1111", action: "build", body: "Check the docs.\n  Then list stale pages." }, token: TOKEN });
  });

  it("a failed improve shows a bad Notice and the form stays usable", async () => {
    modelFailure = "the model cut off";
    const dialog = await openEdit();
    press(dialog, "Improve");
    await waitFor(() => expect(within(dialog).getByText(/the model cut off/)).toBeTruthy(), SLOW);
    expect(within(dialog).getByText(/the model cut off/).closest("[data-tone]")!.getAttribute("data-tone")).toBe("bad");
    expect((within(dialog).getByRole("button", { name: "Improve" }) as HTMLButtonElement).disabled).toBe(false);
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(false);
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

  it("the Tasks block has no Schedules entry: the page is the Calendar page's second tab", () => {
    expect(PAGES.filter((p) => p.group === "tasks").map((p) => p.path)).toEqual(expect.arrayContaining(["chat", "tasks", "calendar"]));
    expect(PAGES.find((p) => p.path === "schedules")).toBeUndefined();
  });
});

// Check a page schedules and On each merge (design 09-dashboard-schedules).
describe("Schedules page, Check a page", () => {
  beforeEach(() => {
    schedules.push(
      onMerge("cp_merge", "Docs on merge"),
      pageSchedule("cp_paused", "Paused page", { paused: true, cadence: { kind: "interval", spec: "60" }, run_cap_usd: 0.5, daily_cap_usd: 2 }),
    );
  });

  it("an On each merge schedule's Repeats and Next run read On each merge, its Switch is on and its State Waiting", async () => {
    show();
    await ready();
    const cells = (await row("Docs on merge")).querySelectorAll("td");
    expect([cells[1]!.textContent, cells[2]!.textContent, cells[3]!.textContent]).toEqual(["On each merge", "On each merge", "Waiting"]);
    expect(within(await row("Docs on merge")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(cells[4]!.textContent).toBe("Checks a page");
  });

  it("a paused page schedule reads its paused flag: Switch off, State and Next run Paused, Resume in the menu, Run now off", async () => {
    show();
    await ready();
    const r = await row("Paused page");
    expect(r.querySelectorAll("td")[2]!.textContent).toBe("Paused");
    expect(within(r).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(r).getByRole("button", { name: "More for Paused page" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Run now", "Edit", "Resume", "Delete"]);
    expect((screen.getByRole("menuitem", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(within(r).getByRole("switch"));
    await waitFor(() => expect(posts).toEqual([{ path: "resume", body: { id: "cp_paused" }, token: TOKEN }]), SLOW);
  });

  it("Run now is off on an On each merge schedule, even while it is not paused", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Docs on merge")).getByRole("button", { name: "More for Docs on merge" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Run now", "Edit", "Pause", "Delete"]);
    expect((screen.getByRole("menuitem", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("an On each merge schedule that is paused still reads On each merge in Next run", async () => {
    schedules.push(onMerge("cp_pm", "Paused merge", { paused: true }));
    show();
    await ready();
    const cells = (await row("Paused merge")).querySelectorAll("td");
    expect([cells[2]!.textContent, cells[3]!.textContent]).toEqual(["On each merge", "Paused"]);
  });

  it("New schedule offers Build, Agent, Feedback and Check a page; Check a page shows its own fields and hides the others", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.click(within(dialog).getByLabelText("Does"));
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Builds a task", "Asks an agent", "Gives feedback as tasks", "Checks a page"]);
    fireEvent.click(within(dialog).getByRole("option", { name: "Builds a task" }));
    fireEvent.click(within(dialog).getByLabelText("Repeats"));
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).not.toContain("On each merge");
    fireEvent.click(within(dialog).getByRole("option", { name: "Daily" }));
    pick(dialog, "Does", "Checks a page");
    for (const label of ["Instruction", "Page URL", "Run cap (USD)", "Daily cap (USD)"]) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    for (const label of [MISSED, "Token limit", "Text"]) expect(within(dialog).queryByLabelText(label)).toBeNull();
    fireEvent.click(within(dialog).getByLabelText("Repeats"));
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toContain("On each merge");
    fireEvent.click(within(dialog).getByRole("option", { name: "On each merge" }));
    pick(dialog, "Does", "Builds a task");
    expect(within(dialog).getByLabelText("Repeats").textContent).toContain("Daily");
    expect(within(dialog).queryByLabelText("Instruction")).toBeNull();
  });

  it("adding a Check a page schedule on each merge sends its instruction, page and caps, blank caps as null, and no spec, zone or missed rule", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New schedule" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Title"), { target: { value: "Docs on merge 2" } });
    pick(dialog, "Does", "Checks a page");
    pick(dialog, "Repeats", "On each merge");
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Find broken links." } });
    fireEvent.change(within(dialog).getByLabelText("Page URL"), { target: { value: "https://example.com/docs" } });
    fireEvent.change(within(dialog).getByLabelText("Daily cap (USD)"), { target: { value: "2.5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add schedule" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({
      path: "add", token: TOKEN,
      body: { id: "docs-on-merge-2", title: "Docs on merge 2", action: "check-page", cadence: "on-merge", instruction: "Find broken links.", url: "https://example.com/docs", run_cap_usd: null, daily_cap_usd: 2.5 },
    });
  });

  it("Edit of a Check a page schedule shows Repeats, When, Time zone and Does read only, and a save sends only what changed", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Docs on merge")).getByRole("button", { name: "More for Docs on merge" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    for (const label of ["Repeats", "When", "Time zone", "Does"]) expect((within(dialog).getByLabelText(label) as HTMLElement & { disabled: boolean }).hasAttribute("disabled") || within(dialog).getByLabelText(label).getAttribute("aria-disabled") === "true").toBe(true);
    expect(within(dialog).getByLabelText("Repeats").textContent).toContain("On each merge");
    expect((within(dialog).getByLabelText("Instruction") as HTMLTextAreaElement).value).toBe("Find broken links.");
    expect((within(dialog).getByLabelText("Page URL") as HTMLInputElement).value).toBe("https://example.com/docs");
    expect(within(dialog).queryByRole("button", { name: "Improve" })).toBeNull();
    fireEvent.change(within(dialog).getByLabelText("Run cap (USD)"), { target: { value: "1.5" } });
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Check spelling." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "edit", token: TOKEN, body: { id: "cp_merge", instruction: "Check spelling.", run_cap_usd: 1.5 } });
  });

  it("Edit of a plain schedule lists Build, Agent and Feedback only", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "More for Nightly docs check" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.click(within(dialog).getByLabelText("Does"));
    expect(within(dialog).getAllByRole("option").map((o) => o.textContent)).toEqual(["Builds a task", "Asks an agent", "Gives feedback as tasks"]);
  });

  it("the detail Card of a Check a page schedule lists its suggestions read only, above Runs: text clamped, state a Badge", async () => {
    suggestions["cp_merge"] = [
      { id: "s1", text: "Fix the broken link on the install page.", state: "pending", created_at: "2026-11-24T08:00:00.000Z" },
      { id: "s2", text: "Rename the heading.", state: "snoozed", created_at: "2026-11-24T09:00:00.000Z" },
    ];
    show();
    await ready();
    fireEvent.click(within(await row("Docs on merge")).getByRole("button", { name: "Show what Docs on merge does and its runs" }));
    const detail = await screen.findByRole("region", { name: "About Docs on merge" }, SLOW);
    const list = await within(detail).findByRole("table", { name: "Suggestions" }, SLOW);
    const runsCard = (await screen.findByText("This schedule has not run yet.", undefined, SLOW)).closest("section")!;
    expect(detail.compareDocumentPosition(runsCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const cells = [...list.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
    expect(cells).toEqual([["Fix the broken link on the install page.", "Pending"], ["Rename the heading.", "Snoozed"]]);
    expect(list.querySelector("p.line-clamp-2")).toBeTruthy();
    expect([...list.querySelectorAll("[data-level]")].map((b) => (b as HTMLElement).dataset["level"])).toEqual(["pending", "snoozed"]);
    expect(within(detail).queryByRole("button", { name: /accept|dismiss|snooze/i })).toBeNull();
    const pairs = Object.fromEntries([...detail.querySelectorAll("dt")].map((dt) => [dt.textContent, dt.nextElementSibling!.textContent]));
    expect(pairs["Repeats"]).toBe("On each merge");
    expect(pairs["Page"]).toBe("https://example.com/docs");
    expect(pairs["Next run"]).toBe("On each merge");
    expect(pairs["Time zone"]).toBeUndefined();
  });

  it("a Check a page schedule with no suggestions says so; a plain schedule has no suggestions section", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Docs on merge")).getByRole("button", { name: "Show what Docs on merge does and its runs" }));
    expect(await screen.findByText("This schedule has no suggestions yet.", undefined, SLOW)).toBeTruthy();
    fireEvent.click(within(await row("Nightly docs check")).getByRole("button", { name: "Show what Nightly docs check does and its runs" }));
    await screen.findByRole("region", { name: "About Nightly docs check" }, SLOW);
    expect(document.querySelector("[data-schedule-suggestions]")).toBeNull();
  });
});

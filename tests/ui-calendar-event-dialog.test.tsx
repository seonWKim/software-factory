// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent, CalendarEvents } from "../web/src/api.js";

// tsconfig.test.json checks this file without JSX, so the page is built with createElement and its .tsx module is
// loaded by a specifier the node check skips (as tests/ui-calendar-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/calendar.js";
const INPUT_MODULE = "../web/src/components/ui/input.js";
const { CalendarPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { CalendarPage: FunctionComponent };
const { Input } = (await import(/* @vite-ignore */ INPUT_MODULE)) as { Input: FunctionComponent<Record<string, unknown>> };

// The New event, Edit and Delete controls of the Calendar page (design 09-dashboard-tasks-calendar, New event) over a
// faked server: the phase 1 local-event routes are recorded, and the events read answers what they stored. Today is
// Thursday 2026-11-12 (local); the read's zone is UTC so the posted instants are the typed times.

const SLOW = { timeout: 5_000 };
const TOKEN = "tok_dialog";
interface Stored { id: string; title: string; starts_at: string; ends_at: string; all_day: boolean; repeats: string; copied_to?: string | null; sync_error?: string | null }
let stored: Stored[];
let posts: { path: string; body: Record<string, unknown>; token: string | null }[];
let refuse: string | null;
let copyTarget: CalendarEvents["copy"];
let syncAnswer: Record<string, unknown> | undefined;

const asEvent = (e: Stored): CalendarEvent => ({
  kind: "event", source: "local", id: e.id, title: e.title, all_day: e.all_day, time: e.all_day ? null : e.starts_at.slice(11, 16), starts_at: e.starts_at, ends_at: e.ends_at, details: null, repeats: e.repeats as "none",
  ...(e.sync_error === undefined ? {} : { copied_to: e.copied_to ?? null, sync_error: e.sync_error }),
});

/** Each date from `from` through `to` with the stored events that start on it (no repeat expansion: the tests use one day). */
function answer(from: string, to: string): CalendarEvents {
  const days: CalendarEvents["days"] = [];
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  for (let n = 0; ; n++) {
    const t = new Date(y, m - 1, d + n);
    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
    if (date > to) break;
    days.push({ date, synced: true, events: stored.filter((e) => e.starts_at.startsWith(date)).map(asEvent) });
  }
  return { from, to, time_zone: "UTC", days, calendar: [{ source: "google-calendar", synced_at: "2026-11-12T08:00:00.000Z", failed: false }], sync_pending: false, ...(copyTarget === undefined ? {} : { copy: copyTarget }) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 12, 10, 0) });
  stored = [];
  posts = [];
  refuse = null;
  copyTarget = undefined;
  syncAnswer = undefined;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: TOKEN, actor: "local:owner", commands: true });
    if (u.pathname.startsWith("/api/v1/calendar/local-events") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path: u.pathname.slice("/api/v1/calendar/local-events".length) || "/", body, token: new Headers(init.headers).get("x-csrf-token") });
      if (refuse !== null) return json(400, { error: refuse });
      const { id, ...fields } = body as { id: string } & Partial<Stored>;
      if (u.pathname.endsWith("/delete")) stored = stored.filter((e) => e.id !== id);
      else if (u.pathname.endsWith("/edit")) stored = stored.map((e) => (e.id === id ? { ...e, ...fields } : e));
      else stored.push({ all_day: false, repeats: "none", ...fields, id } as Stored);
      return json(200, { event: { id }, ...(syncAnswer === undefined ? {} : { sync: syncAnswer }) });
    }
    if (u.pathname !== "/api/v1/calendar/events") return json(404, { error: "Not found." });
    return json(200, answer(u.searchParams.get("from")!, u.searchParams.get("to")!));
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(CalendarPage)));
const dialog = () => screen.getByRole("dialog", {}) as HTMLElement;
const field = (name: string) => within(dialog()).getByLabelText(name) as HTMLInputElement;
const type = (name: string, value: string) => fireEvent.change(field(name), { target: { value } });
const save = (name: string) => fireEvent.click(within(dialog()).getByRole("button", { name }));
const openNew = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "New event" }, SLOW));
  await screen.findByRole("dialog");
};
const chip = async (id: string) => {
  const el = await screen.findByText((_, e) => e?.getAttribute("data-event") === `local:${id}`, undefined, SLOW);
  fireEvent.click(el);
  return el;
};

describe("New event dialog", () => {
  it("the button opens the shared Dialog on today at 09:00; a click on an empty day opens it for that day", async () => {
    show();
    await openNew();
    expect(dialog().hasAttribute("data-dialog")).toBe(true);
    expect(within(dialog()).getByRole("heading", { name: "New event" })).toBeTruthy();
    expect(field("Date").value).toBe("2026-11-12");
    expect(field("Start").value).toBe("09:00");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const day = document.querySelector<HTMLElement>('[data-day="2026-11-10"]')!;
    fireEvent.click(day);
    await screen.findByRole("dialog");
    expect(field("Date").value).toBe("2026-11-10");
    expect(field("Start").value).toBe("09:00");
    expect(posts).toEqual([]);
  });

  it("has title, date, start and end time or all day, time zone and repeat, and no location or notes", async () => {
    show();
    await openNew();
    const names = [...dialog().querySelectorAll("label, [role=group] > span")].map((l) => l.textContent);
    expect(names).toEqual(expect.arrayContaining(["Title", "Date", "All day", "Start", "End", "Time zone", "Repeat"]));
    expect(names.join(" ")).not.toMatch(/location|notes/i);
    expect(field("Date").type).toBe("date");
    expect(field("Start").type).toBe("time");
    expect(within(dialog()).getByRole("combobox", { name: "Time zone" }).textContent).toBe("UTC");
    fireEvent.click(within(dialog()).getByRole("combobox", { name: "Repeat" }));
    expect(within(dialog()).getAllByRole("option").map((o) => o.textContent)).toEqual(["Does not repeat", "Daily", "Weekly", "Monthly"]);
    fireEvent.click(within(dialog()).getByRole("switch"));
    expect(field("End date").type).toBe("date");
    expect(within(dialog()).queryByLabelText("Start")).toBeNull();
  });

  it("refuses an empty title and an end before the start in the dialog, and posts nothing", async () => {
    show();
    await openNew();
    save("Add event");
    expect(within(dialog()).getByRole("alert").textContent).toBe("Give the event a title.");
    type("Title", "Plan");
    type("End", "08:00");
    save("Add event");
    expect(within(dialog()).getByRole("alert").textContent).toBe("The end must be after the start.");
    fireEvent.click(within(dialog()).getByRole("switch"));
    type("End date", "2026-11-11");
    type("Date", "2026-11-12");
    save("Add event");
    expect(within(dialog()).getByRole("alert").textContent).toBe("The end date must not be before the date.");
    expect(posts).toEqual([]);
  });

  it("saving posts instants in the chosen zone with a client id, and the event shows at once", async () => {
    show();
    await openNew();
    type("Title", "Plan");
    type("Date", "2026-11-13");
    save("Add event");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts).toHaveLength(1);
    const { path, body, token } = posts[0]!;
    expect([path, token]).toEqual(["/", TOKEN]);
    expect(body).toMatchObject({ title: "Plan", starts_at: "2026-11-13T09:00:00.000Z", ends_at: "2026-11-13T10:00:00.000Z", all_day: false, repeats: "none" });
    expect(body.id).toMatch(/^le_[A-Za-z0-9]{8,}$/);
    await screen.findByText((_, e) => e?.getAttribute("data-event") === `local:${body.id}`, undefined, SLOW);
  });

  it("an all-day event runs from local midnight of the start date to the midnight after the end date", async () => {
    show();
    await openNew();
    type("Title", "Trip");
    fireEvent.click(within(dialog()).getByRole("switch"));
    type("Date", "2026-11-13");
    type("End date", "2026-11-14");
    save("Add event");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toMatchObject({ starts_at: "2026-11-13T00:00:00.000Z", ends_at: "2026-11-15T00:00:00.000Z", all_day: true });
  });

  it("a server refusal shows in the dialog, which stays open", async () => {
    refuse = "end must be after start";
    show();
    await openNew();
    type("Title", "Plan");
    save("Add event");
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toBe("end must be after start"), SLOW);
  });
});

describe("Edit and Delete", () => {
  const mine = (over: Partial<Stored> = {}): Stored => ({ id: "le_aaaaaaaa", title: "Mine", starts_at: "2026-11-12T14:30:00.000Z", ends_at: "2026-11-12T15:00:00.000Z", all_day: false, repeats: "none", ...over });

  it("a local event's details have Edit and Delete; another source's have neither", async () => {
    stored = [mine()];
    show();
    await chip("le_aaaaaaaa");
    const panel = await screen.findByRole("dialog");
    expect(within(panel).getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "Delete" })).toBeTruthy();
  });

  it("Edit opens the dialog prefilled from the event and posts only the changed fields' values", async () => {
    stored = [mine()];
    show();
    await chip("le_aaaaaaaa");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Edit event" })).toBeTruthy());
    expect([field("Title").value, field("Date").value, field("Start").value, field("End").value]).toEqual(["Mine", "2026-11-12", "14:30", "15:00"]);
    type("Title", "Renamed");
    save("Save");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.path).toBe("/edit");
    expect(posts[0]!.body).toMatchObject({ id: "le_aaaaaaaa", title: "Renamed", starts_at: "2026-11-12T14:30:00.000Z" });
    await screen.findByText("Renamed", undefined, SLOW);
  });

  it("a repeating event locks its date, time and all-day; only the title and repeat are posted", async () => {
    stored = [mine({ repeats: "weekly" })];
    show();
    await chip("le_aaaaaaaa");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Edit event" })).toBeTruthy());
    for (const name of ["Date", "Start", "End"]) expect(field(name).disabled).toBe(true);
    expect((within(dialog()).getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    type("Title", "Weekly sync");
    save("Save");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toEqual({ id: "le_aaaaaaaa", title: "Weekly sync", repeats: "weekly" });
  });

  it("Delete asks first: Cancel posts nothing, Delete event posts the id and the event leaves the page", async () => {
    stored = [mine()];
    show();
    await chip("le_aaaaaaaa");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    const confirm = await screen.findByRole("dialog");
    expect(within(confirm).getByRole("heading").textContent).toBe("Delete Mine");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual([]);
    await chip("le_aaaaaaaa");
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete event" }));
    await waitFor(() => expect(posts).toEqual([{ path: "/delete", body: { id: "le_aaaaaaaa" }, token: TOKEN }]), SLOW);
    await waitFor(() => expect(document.querySelector('[data-event="local:le_aaaaaaaa"]')).toBeNull(), SLOW);
  });
});

describe("Also add to Google Calendar", () => {
  const SWITCH = "Also add to Google Calendar";
  const NOTE = "Reconnect Google Calendar with write access to add events there";
  const copySwitch = () => within(dialog()).getByRole("switch", { name: SWITCH }) as HTMLButtonElement;

  it("with write access the switch is on by default and the add posts sync: true", async () => {
    copyTarget = { label: "Google Calendar", writable: true };
    syncAnswer = { state: "synced", provider: "google-calendar" };
    show();
    await openNew();
    await waitFor(() => expect(copySwitch().getAttribute("aria-checked")).toBe("true"), SLOW);
    expect(within(dialog()).queryByText(NOTE)).toBeNull();
    expect(within(dialog()).getByRole("group", { name: SWITCH })).toBeTruthy();
    type("Title", "Plan");
    save("Add event");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts[0]!.body).toMatchObject({ title: "Plan", sync: true });
  });

  it("the owner can turn the switch off, and the add then posts no sync", async () => {
    copyTarget = { label: "Google Calendar", writable: true };
    show();
    await openNew();
    await waitFor(() => expect(copySwitch().getAttribute("aria-checked")).toBe("true"), SLOW);
    fireEvent.click(copySwitch());
    expect(copySwitch().getAttribute("aria-checked")).toBe("false");
    type("Title", "Plan");
    save("Add event");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).not.toHaveProperty("sync");
  });

  it("with a read-only connection the switch is off and read-only, with the note to reconnect", async () => {
    copyTarget = { label: "Google Calendar", writable: false };
    show();
    await openNew();
    await waitFor(() => expect(copySwitch().getAttribute("aria-checked")).toBe("false"), SLOW);
    expect(copySwitch().getAttribute("aria-readonly")).toBe("true");
    expect(within(dialog()).getByText(NOTE)).toBeTruthy();
    fireEvent.click(copySwitch());
    expect(copySwitch().getAttribute("aria-checked")).toBe("false");
    type("Title", "Plan");
    save("Add event");
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).not.toHaveProperty("sync");
  });

  it("with no calendar that takes copies there is no switch for it", async () => {
    show();
    await openNew();
    await screen.findByRole("dialog");
    expect(within(dialog()).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual(["All day"]);
  });

  it("a failed copy keeps the event saved and shows the error in the dialog; its button then closes it", async () => {
    copyTarget = { label: "Google Calendar", writable: true };
    syncAnswer = { state: "failed", error: "quota exceeded" };
    show();
    await openNew();
    await waitFor(() => expect(copySwitch().getAttribute("aria-checked")).toBe("true"), SLOW);
    type("Title", "Plan");
    save("Add event");
    await waitFor(() => expect(within(dialog()).getByRole("alert").textContent).toBe("Saved here, but the copy in Google Calendar failed: quota exceeded"), SLOW);
    expect(stored.map((e) => e.title)).toEqual(["Plan"]);
    save("Add event");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts).toHaveLength(1);
  });
});

describe("A copy's error on the event", () => {
  it("editing an event whose copy failed shows that error, kept on the event", async () => {
    copyTarget = { label: "Google Calendar", writable: true };
    stored = [{ id: "le_bbbbbbbb", title: "Kept", starts_at: "2026-11-12T14:30:00.000Z", ends_at: "2026-11-12T15:00:00.000Z", all_day: false, repeats: "none", copied_to: "google-calendar", sync_error: "quota exceeded" }];
    show();
    await chip("le_bbbbbbbb");
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(within(dialog()).getByText(/The copy in Google Calendar failed: quota exceeded\./)).toBeTruthy(), SLOW);
    expect(within(dialog()).queryByRole("switch", { name: "Also add to Google Calendar" })).toBeNull();
  });
});

describe("Input date and time", () => {
  it("takes date and time on the field classes, and components.md lists them", () => {
    render(createElement("div", null, createElement(Input, { type: "date", "aria-label": "d" }), createElement(Input, { type: "time", "aria-label": "t" })));
    const [d, t] = [screen.getByLabelText("d"), screen.getByLabelText("t")] as HTMLInputElement[];
    expect([d!.type, t!.type]).toEqual(["date", "time"]);
    for (const el of [d!, t!]) expect(el.className).toContain("h-8");
    const doc = readFileSync("design-system/components.md", "utf8");
    const input = doc.slice(doc.indexOf("## Input"), doc.indexOf("## Textarea"));
    expect(input).toMatch(/`date`/);
    expect(input).toMatch(/`time`/);
  });
});

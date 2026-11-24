// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { type FunctionComponent, createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoutineRow } from "../web/src/api.js";
import { en } from "../web/src/i18n/en.js";
import { PAGES } from "../web/src/pages.js";

// The page is built with createElement and its .tsx module loaded by a specifier the node check skips
// (as tests/ui-schedules-page.test.tsx does).
const PAGE_MODULE = "../web/src/views/routines.js";
const { RoutinesPage } = (await import(/* @vite-ignore */ PAGE_MODULE)) as { RoutinesPage: FunctionComponent };

// The Routines page over a faked server (design 09-dashboard-routines): a table of routines with a Switch and a "⋯"
// menu per row, the selected routine's detail card, New routine and Edit in one Dialog, and a Delete confirmation.

const SLOW = { timeout: 5_000 };
const TOKEN = "tok_routines";
const routine = (id: string, name: string, over: Partial<RoutineRow> = {}): RoutineRow => ({
  id, name, instruction: "Look for stale pages.", url: "https://example.com/docs", schedule: { kind: "daily", spec: "09:00" }, zone: "Europe/Paris",
  trigger: null, run_cap_usd: 1.5, daily_cap_usd: null, paused: false, next_due_at: "2026-11-25T08:00:00.000Z", last_run_at: null, ...over,
});

let routines: RoutineRow[];
let posts: { path: string; body: Record<string, unknown>; token: string | null }[];
let refusal: string | null;

beforeEach(() => {
  routines = [routine("rtn_aaaa1111", "Docs check"), routine("rtn_bbbb2222", "After merge", { schedule: null, trigger: "merge", paused: true, next_due_at: null })];
  posts = [];
  refusal = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url, "http://127.0.0.1");
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/v1/session") return json(200, { csrf_token: TOKEN, actor: "local:owner", commands_enabled: true });
    if (u.pathname === "/api/v1/routines" && !init?.method) return json(200, { routines });
    if (init?.method === "POST" && u.pathname.startsWith("/api/v1/routines/")) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ path: u.pathname.slice("/api/v1/routines/".length), body, token: new Headers(init.headers).get("x-csrf-token") });
      if (refusal !== null) return json(409, { error: refusal });
      return json(200, { routine: routines[0] });
    }
    return json(404, { error: "Not found." });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = () => render(createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(RoutinesPage)));
const row = async (name: string) => (await screen.findByText(name, undefined, SLOW)).closest("tr")!;
const ready = async () => {
  await row("Docs check");
  await waitFor(() => expect((screen.getByRole("button", { name: "New routine" }) as HTMLButtonElement).disabled).toBe(false), SLOW);
};
const openMenu = async (name: string, item: string) => {
  fireEvent.click(within(await row(name)).getByRole("button", { name: `More for ${name}` }));
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
};

describe("Routines page", () => {
  it("is a PAGES entry in the System block between Health and Workers, with its text in the catalog", () => {
    const system = PAGES.filter((p) => p.group === "system").map((p) => p.key);
    expect(system.indexOf("routines")).toBe(system.indexOf("health") + 1);
    expect(system.indexOf("workers")).toBe(system.indexOf("routines") + 1);
    expect(en["page.routines"]).toBe("Routines");
    expect(en["routines.new"]).toBe("New routine");
  });

  it("lists the routines in a table inside a Card, a Switch on for a running one and off for a paused one, and shows no raw ID", async () => {
    show();
    const table = await screen.findByRole("table", { name: "Routines" }, SLOW);
    expect(table.closest("section")).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Routines" })).toBeTruthy();
    expect(within(await row("Docs check")).getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(within(await row("After merge")).getByRole("switch").getAttribute("aria-checked")).toBe("false");
    expect(within(await row("After merge")).getByText("On merge")).toBeTruthy();
    expect(within(await row("Docs check")).getByText("Every day at 09:00")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/rtn_[a-z0-9]+/);
  });

  it("the Switch posts pause for a running row and resume for a paused one, with the CSRF token", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Docs check")).getByRole("switch"));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "pause", body: { id: "rtn_aaaa1111" }, token: TOKEN });
    await waitFor(() => expect((within(screen.getByRole("table", { name: "Routines" })).getAllByRole("switch")[0] as HTMLButtonElement).disabled).toBe(false), SLOW);
    fireEvent.click(within(await row("After merge")).getByRole("switch"));
    await waitFor(() => expect(posts).toHaveLength(2), SLOW);
    expect(posts[1]).toEqual({ path: "resume", body: { id: "rtn_bbbb2222" }, token: TOKEN });
  });

  it("the row menu holds Run now, Edit and Delete", async () => {
    show();
    await ready();
    fireEvent.click(within(await row("Docs check")).getByRole("button", { name: "More for Docs check" }));
    expect(within(screen.getByRole("menu")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Run now", "Edit", "Delete"]);
  });

  it("Run now posts run with the routine's id and the CSRF token", async () => {
    show();
    await ready();
    await openMenu("Docs check", "Run now");
    await waitFor(() => expect(posts).toEqual([{ path: "run", body: { id: "rtn_aaaa1111" }, token: TOKEN }]), SLOW);
  });

  it("Run now is disabled for a paused routine and for an On merge routine", async () => {
    routines = [routine("rtn_aaaa1111", "Docs check", { paused: true }), routine("rtn_bbbb2222", "After merge", { schedule: null, trigger: "merge" })];
    show();
    await ready();
    for (const name of ["Docs check", "After merge"]) {
      fireEvent.click(within(await row(name)).getByRole("button", { name: `More for ${name}` }));
      expect((screen.getByRole("menuitem", { name: "Run now" }) as HTMLButtonElement).disabled || screen.getByRole("menuitem", { name: "Run now" }).getAttribute("aria-disabled") === "true").toBe(true);
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    }
    expect(posts).toHaveLength(0);
  });

  it("shows a refused run's error in an alert", async () => {
    refusal = "routine is paused";
    show();
    await ready();
    await openMenu("Docs check", "Run now");
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toContain(refusal);
  });

  it("a paused selected routine shows the warn Notice with its details; a running one shows none", async () => {
    show();
    await ready();
    expect(screen.getByText("Select a routine to see its details.")).toBeTruthy();
    fireEvent.click(within(await row("Docs check")).getByRole("button", { name: "Show details of Docs check" }));
    expect(await screen.findByText("Look for stale pages.")).toBeTruthy();
    expect(document.querySelector("[data-tone=warn]")).toBeNull();
    fireEvent.click(within(await row("After merge")).getByRole("button", { name: "Show details of After merge" }));
    await waitFor(() => expect(document.querySelector("[data-tone=warn]")).not.toBeNull(), SLOW);
  });

  it("New routine opens a Dialog with the fields and posts them with a name-made ID that is not shown", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    for (const label of ["Name", "Instruction", "Page URL", "Repeats", "When", "Time zone", "Run cap USD", "Daily cap USD"]) expect(within(dialog).getByLabelText(label)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Docs check" } });
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Read the docs." } });
    fireEvent.change(within(dialog).getByLabelText("Run cap USD"), { target: { value: "2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add routine" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.path).toBe("add");
    expect(posts[0]!.body).toMatchObject({ id: "docs-check", name: "Docs check", instruction: "Read the docs.", url: null, schedule: { kind: "daily", spec: "09:00" }, trigger: null, run_cap_usd: 2, daily_cap_usd: null });
  });

  it("choosing On merge hides When and sends the merge trigger with no schedule", async () => {
    show();
    await ready();
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Merged" } });
    fireEvent.change(within(dialog).getByLabelText("Instruction"), { target: { value: "Review it." } });
    fireEvent.click(within(dialog).getByLabelText("Repeats"));
    fireEvent.click(await screen.findByRole("option", { name: "On merge" }));
    await waitFor(() => expect(within(dialog).queryByLabelText("When")).toBeNull(), SLOW);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add routine" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]!.body).toMatchObject({ schedule: null, trigger: "merge" });
  });

  it("Edit opens the same Dialog filled in and sends only the fields that changed", async () => {
    show();
    await ready();
    await openMenu("Docs check", "Edit");
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    expect((within(dialog).getByLabelText("Name") as HTMLInputElement).value).toBe("Docs check");
    expect((within(dialog).getByLabelText("Instruction") as HTMLTextAreaElement).value).toBe("Look for stale pages.");
    fireEvent.change(within(dialog).getByLabelText("When"), { target: { value: "10:30" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posts).toHaveLength(1), SLOW);
    expect(posts[0]).toEqual({ path: "edit", body: { id: "rtn_aaaa1111", schedule: { kind: "daily", spec: "10:30" }, trigger: null }, token: TOKEN });
  });

  it("Delete asks in a Dialog first: nothing posts until it is confirmed", async () => {
    show();
    await ready();
    await openMenu("Docs check", "Delete");
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    expect(within(dialog).getByText("Delete Docs check")).toBeTruthy();
    expect(posts).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull(), SLOW);
    expect(posts).toHaveLength(0);
    await openMenu("Docs check", "Delete");
    fireEvent.click(within(await screen.findByRole("dialog", undefined, SLOW)).getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(posts).toEqual([{ path: "delete", body: { id: "rtn_aaaa1111" }, token: TOKEN }]), SLOW);
  });

  it("shows the server's refusal of a write in a bad Notice, and a refused save stays in the Dialog", async () => {
    refusal = "changed by another worker, try again";
    show();
    await ready();
    fireEvent.click(within(await row("Docs check")).getByRole("switch"));
    expect((await screen.findByRole("alert", undefined, SLOW)).textContent).toContain(refusal);
    fireEvent.click(screen.getByRole("button", { name: "New routine" }));
    const dialog = await screen.findByRole("dialog", undefined, SLOW);
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "X" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add routine" }));
    await waitFor(() => expect(within(dialog).getByText(/changed by another worker/)).toBeTruthy(), SLOW);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

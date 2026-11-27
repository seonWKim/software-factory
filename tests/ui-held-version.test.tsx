// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";
import { EvalsPage } from "../web/src/views/evals.js";

// Settling a held skill version from the dashboard (design 07-self-improvement, 09-dashboard-evals): the held-version
// alarm in Needs you and the top of the skill's Evals page show the version, the cases that got worse, "Use this
// version" and "Keep the current version". Both post the one settle route (POST /api/v1/evals/write, op version.settle);
// Keep asks for an optional reason in a Dialog first. After either, the alarm clears and the versions list marks the
// right version current. The reads and the POST are a fake fetch whose answers follow the settle.

const AT = "2026-11-26T00:00:00.000Z";
const SKILL = "skills/review-plan/SKILL.md";
const ENC = encodeURIComponent(SKILL);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const HELD = {
  ref_id: "sref_1", version: 4, skill: SKILL, pass_rate: 0.4, before: 0.8, current_version: 3, alert_id: "al_held",
  fell: [{ case_id: "case_a", input: "Plan a refactor of the store" }, { case_id: "case_b", input: null }],
};
const ALARM = {
  code: "alarm", text: "skills/review-plan/SKILL.md version 4 is held: its pass rate 0.4 on standard fell from 0.8 (version 3).",
  command: "Use this version or Keep the current version", until: AT, pattern: "skill_version_gate", error_code: "pass_rate_drop", alert_id: "al_held",
};
const version = (n: number, current: boolean) => ({
  version: n, folder_hash: `hash-${n}`, created_at: `2026-11-2${n}T10:00:00.000Z`, current, run_id: `run_${n}`, pass_rate: n === 4 ? 0.4 : 0.8, change: null,
});
const RUN = { id: "run_4", status: "passed", started_at: AT, skill_version: "hash-4", model_class: "standard", judge_model_class: "strong", replays: 1, pass_rate: 0.4, errored: 0 };

let held: unknown[];
let alarms: unknown[];
let currentVersion: number;
let posts: { body: Record<string, unknown>; token: string | null }[];
let refuse: string | null;

beforeEach(() => {
  held = [HELD];
  alarms = [ALARM];
  currentVersion = 3;
  posts = [];
  refuse = null;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ body, token: new Headers(init.headers).get("x-csrf-token") });
      if (url !== "/api/v1/evals/write" || body.op !== "version.settle") return json(404, { error: "Not found." });
      if (refuse !== null) return json(409, { error: refuse });
      if (body.decision === "approve") currentVersion = body.version as number;
      held = [];
      alarms = [];
      return json(200, { ref: body.ref, version: body.version, decision: body.decision, state: body.decision === "approve" ? "passed" : "rejected" });
    }
    const path = url.split("?")[0]!;
    const reads: Record<string, unknown> = {
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: alarms.length, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 }, system_actions: alarms },
      "/api/v1/items": { as_of: AT, total: 0, items: [], facets: { allStates: 0, state: {} }, counts: { open: 0, running: 0 } },
      "/api/v1/tasks": { today_date: "2026-11-26", today: { overdue: [], due: [] }, upcoming: [], projects: [], csrf_token: "tok", can_build: true, active_projects: [] },
      "/api/v1/runs": { as_of: AT, runs: [] },
      "/api/v1/queue": { as_of: AT, queue: [] },
      "/api/v1/pauses": { pauses: [], csrf_token: null },
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/evals": { skills: [SKILL], held },
      [`/api/v1/evals/${ENC}/runs`]: { runs: [RUN] },
      [`/api/v1/evals/${ENC}/grid`]: { rows: [] },
      [`/api/v1/evals/${ENC}/versions`]: { versions: [4, 3].map((n) => version(n, n === currentVersion)), unlinked: [] },
    };
    const body = reads[path];
    return body === undefined ? json(404, { error: "Not found." }) : json(200, body);
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  history.replaceState(null, "", "/app/tasks");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

/** `el`, once its buttons are enabled (the session's CSRF token has loaded). */
async function ready(el: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => expect(within(el).getAllByRole("button").every((b) => !(b as HTMLButtonElement).disabled)).toBe(true));
  return el;
}

/** The Tasks page, once the held-version alarm row has loaded its held version. */
async function heldAlarm(): Promise<HTMLElement> {
  render(<QueryClientProvider client={client()}><App /></QueryClientProvider>);
  const check = await screen.findByRole("list", { name: "Check" });
  await waitFor(() => expect(check.querySelector("[data-held-alarm]")).not.toBeNull());
  return ready(check.querySelector<HTMLElement>("[data-held-alarm]")!);
}

/** The Evals page of SKILL, once its held version and its versions list have loaded. */
async function evalsPage(): Promise<{ block: HTMLElement; versions: HTMLElement }> {
  render(<QueryClientProvider client={client()}><EvalsPage skill={SKILL} /></QueryClientProvider>);
  const versions = await screen.findByRole("list", { name: "Versions of this skill, newest first" });
  await waitFor(() => expect(document.querySelector("[data-held-version]")).not.toBeNull());
  return { block: await ready(document.querySelector<HTMLElement>("[data-held-version]")!), versions };
}

const currentIn = (list: HTMLElement): string | null =>
  [...list.querySelectorAll<HTMLElement>("li[data-version]")].find((li) => li.textContent!.includes("Current"))?.getAttribute("data-version") ?? null;

describe("the held-version alarm", () => {
  it("shows the held version, the cases that got worse, and Keep the current version then Use this version", async () => {
    const row = await heldAlarm();
    expect(row.getAttribute("data-check")).toBe("alarm");
    expect(row.textContent).toContain("Version 4 is waiting for your decision");
    expect(row.textContent).toContain("Pass rate 40%, down from 80% on version 3");
    const cases = within(row).getByRole("list", { name: "Cases that got worse" });
    expect([...cases.querySelectorAll("li")].map((li) => li.getAttribute("data-case"))).toEqual(["case_a", "case_b"]);
    expect(cases.textContent).toContain("Plan a refactor of the store");
    expect(within(row).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep the current version", "Use this version"]);
  });

  it("Use this version approves that version through the settle route, and the alarm clears", async () => {
    const row = await heldAlarm();
    fireEvent.click(within(row).getByRole("button", { name: "Use this version" }));
    await waitFor(() => expect(document.querySelector("[data-held-alarm]")).toBeNull());
    expect(posts).toEqual([{ body: { op: "version.settle", ref: "sref_1", version: 4, decision: "approve" }, token: "tok" }]);
    expect(document.querySelector('li[data-check="alarm"]')).toBeNull();
    expect(currentVersion).toBe(4);
  });

  it("Keep the current version opens a Dialog with an optional reason; confirming rejects the held version, and the alarm clears", async () => {
    const row = await heldAlarm();
    fireEvent.click(within(row).getByRole("button", { name: "Keep the current version" }));
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    expect(within(dialog).getByRole("heading", { name: "Keep the current version of review-plan?" })).toBeTruthy();
    const reason = within(dialog).getByLabelText("Reason (optional)") as HTMLTextAreaElement;
    expect(reason.required).toBe(false);
    // Nothing is sent until the Dialog is confirmed.
    expect(posts).toEqual([]);
    fireEvent.change(reason, { target: { value: "The new wording drops the plan checks" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the current version" }));
    await waitFor(() => expect(document.querySelector("[data-held-alarm]")).toBeNull());
    // The reason stays in the Dialog: it is not stored (decision 1 of the spec).
    expect(posts).toEqual([{ body: { op: "version.settle", ref: "sref_1", version: 4, decision: "reject" }, token: "tok" }]);
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
    expect(currentVersion).toBe(3);
  });

  it("Keep the current version with an empty reason still rejects", async () => {
    const row = await heldAlarm();
    fireEvent.click(within(row).getByRole("button", { name: "Keep the current version" }));
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the current version" }));
    await waitFor(() => expect(posts.map((p) => p.body.decision)).toEqual(["reject"]));
  });

  it("a refusal shows in plain words and the alarm stays", async () => {
    refuse = "Version 4 of this skill is not waiting for a decision, so nothing was changed.";
    const row = await heldAlarm();
    fireEvent.click(within(row).getByRole("button", { name: "Use this version" }));
    expect((await within(row).findByRole("alert")).textContent).toBe(refuse);
    expect(document.querySelector("[data-held-alarm]")).not.toBeNull();
  });
});

describe("the held version on the Evals page", () => {
  it("is a warn Notice above the Versions Card with its rates, the cases that got worse and both buttons", async () => {
    const { block, versions } = await evalsPage();
    expect(block.compareDocumentPosition(versions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // A warn Notice above the Versions Card, not a Card of its own.
    const notice = within(block).getByRole("alert");
    expect(notice.getAttribute("data-tone")).toBe("warn");
    expect(notice.textContent).toContain("Version 4 is waiting for your decision");
    expect(block.compareDocumentPosition(screen.getByRole("region", { name: "Versions" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Versions", "Cases", "Compare", "SKILL.md diff"]);
    expect(block.textContent).toContain("Pass rate 40%, down from 80% on version 3");
    expect(within(block).getByRole("list", { name: "Cases that got worse" }).querySelectorAll("li").length).toBeGreaterThan(0);
    expect(within(block).getAllByRole("button").map((b) => b.textContent)).toEqual(["Keep the current version", "Use this version"]);
  });

  it("Use this version makes that version current in the versions list, and the held block leaves", async () => {
    const { block, versions } = await evalsPage();
    expect(currentIn(versions)).toBe("3");
    fireEvent.click(within(block).getByRole("button", { name: "Use this version" }));
    await waitFor(() => expect(currentIn(screen.getByRole("list", { name: "Versions of this skill, newest first" }))).toBe("4"));
    await waitFor(() => expect(document.querySelector("[data-held-version]")).toBeNull());
    expect(posts.map((p) => p.body)).toEqual([{ op: "version.settle", ref: "sref_1", version: 4, decision: "approve" }]);
  });

  it("Keep the current version keeps the current version current", async () => {
    const { block } = await evalsPage();
    fireEvent.click(within(block).getByRole("button", { name: "Keep the current version" }));
    const dialog = document.querySelector<HTMLElement>("dialog[data-dialog]")!;
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep the current version" }));
    await waitFor(() => expect(document.querySelector("[data-held-version]")).toBeNull());
    expect(currentIn(screen.getByRole("list", { name: "Versions of this skill, newest first" }))).toBe("3");
    expect(posts.map((p) => p.body.decision)).toEqual(["reject"]);
  });
});

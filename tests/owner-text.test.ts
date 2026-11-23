// @vitest-environment jsdom
// Owner text for a failed item (issue #758): /app/tasks, /app/items and the failed item's page show no snake_case or
// kebab-case token. Codes and full IDs sit in `<code>` inside a disclosure; text shown as stored (a title, a message
// body, a stored detail) sits in `[data-raw]`, outside a disclosure. The server's own words (why.ts, alarms.ts) make
// the fixture's sentences, so the check covers the server side too. No live model or remote call: fetch is a stub.
import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { alarmCommand, alarmFullText, alarmText } from "../src/ui/alarms.js";
import { whyWaiting, withAlarms, type WhyInput } from "../src/ui/why.js";
import type { Alert } from "../src/interfaces/factory-store.js";

// tsconfig.test.json checks this file without JSX, so the shell fixtures (a .tsx module) load by a specifier the node check skips.
const FIXTURES = "./ui-shell-fixtures.js";
const { AT, RESPONSES, detail, items, overview, row, installShellFixtures, mount } = (await import(/* @vite-ignore */ FIXTURES)) as {
  AT: string;
  RESPONSES: Record<string, unknown>;
  detail: { item: Record<string, unknown> };
  items: { items: unknown[] };
  overview: Record<string, unknown>;
  row: (n: number, level: string, title: string, extra?: object) => Record<string, unknown>;
  installShellFixtures: () => void;
  mount: () => { container: HTMLElement };
};

installShellFixtures();

const SNAKE = /[a-z]+_[a-z]+/;
const KEBAB = /\b[a-z]+-[a-z]+\b/;

/** The text an owner reads: without `<code>` inside a disclosure, text shown as stored (`[data-raw]` outside a disclosure), scripts and styles. */
function visibleText(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  copy.querySelectorAll("details code, [data-raw]:not(details), script, style").forEach((n) => n.remove());
  const words: string[] = [];
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) words.push(n.textContent ?? "");
  return words.join(" ");
}

/** The internal names `text` shows: each snake_case or kebab-case token. */
const internalNames = (text: string) => [...text.matchAll(new RegExp(`${SNAKE.source}|${KEBAB.source}`, "g"))].map((m) => m[0]);

const RUN = "run_f726027e43a847fdb81fac7c64cec9a2";
const OLDER = "run_0c1d2e3f43a847fdb81fac7c64cec9a2";
const zeroTokens: Alert = {
  id: "al_1", pattern: "zero_tokens", pattern_key: "zero_tokens", error_code: "zero_tokens", count: 4,
  detail: "the last failed with exception", created_at: AT as Alert["created_at"],
};
const repeated: Alert = {
  id: "al_2", pattern: "repeated_error", pattern_key: "repeated_error:x", error_code: "exception", count: 3,
  detail: "boom in the worker", created_at: AT as Alert["created_at"],
};

/** The failed item as the server reasons about it: triage failed twice the same way. */
const failedInput: WhyInput = {
  item: { stage: "NEW", blocked_on: "human", blocked_reason: "repeated_failure", close_reason: null },
  run: null, decision: null, pauses: {}, not_before: null, phases: { waiting_on: 0, waiting_on_number: null },
};
const why = { ...withAlarms(whyWaiting(failedInput), [alarmText(zeroTokens)]), ref_url: null };
const failed = row(7, "repeated_failure", "Add the export button", {
  id: "wi_f726027e43a847fdb81fac7c64cec9a2", stage: "NEW", blocked_on: "human", blocked_reason: "repeated_failure", reason_code: why.reason_code, why,
});

Object.assign(overview, {
  system_actions: [zeroTokens, repeated].map((a) => ({
    code: "alarm", text: alarmFullText(a), command: alarmCommand(a), until: AT, work_item_id: null, pattern: a.pattern, error_code: a.error_code,
  })),
});
items.items.push(failed);
RESPONSES[`/api/v1/items/${failed.id}`] = {
  ...detail,
  item: { ...detail.item, ...failed, restart_count: 2, why },
  runs: [
    { id: OLDER, kind: "triage", status: "failed", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 0, error: { code: "exception", detail: "boom in the worker" } },
    { id: RUN, kind: "triage", status: "failed", attempt: 2, started_at: AT, finished_at: AT, created_at: AT, tokens: 0, error: { code: "exception", detail: "boom in the worker" } },
  ],
  timeline: [
    { version: 1, at: AT, actor: { kind: "user", id: "github:1" }, reason: "intake", changes: { stage: { from: "null", to: '"NEW"' } }, detail: null },
    {
      version: 2, at: AT, actor: { kind: "system", id: "system" }, reason: "repeated_failure",
      changes: { blocked_on: { from: '"none"', to: '"human"' }, blocked_reason: { from: "null", to: '"repeated_failure"' }, restart_count: { from: "1", to: "2" } }, detail: null,
    },
  ],
  thread: [
    {
      seq: 1, at: AT, kind: "run-failed", author: "factory", role: "factory", channel: "github_issue", anchor: "msg-1",
      // The comment as run-results.unit.ts writes it: the failure in words, its code under Details.
      body: "## Factory check: the same failure twice\n\nThe triage run failed twice in a row the same way: the worker hit an unexpected error.\n\n<details><summary>Details</summary>\n\nError code: `exception`\n\n</details>",
    },
  ],
};

describe("owner text for a failed item (issue #758)", () => {
  it("/app/tasks shows no internal name, and the alarm says how the last run failed in words", async () => {
    history.replaceState(null, "", "/app/tasks");
    const { container } = mount();
    const needs = await screen.findByRole("region", { name: "Needs you" });
    const alarms = await within(needs).findAllByText(/^Alarm:/);
    expect(alarms.map((a) => a.textContent)).toEqual([
      "Alarm: 4 agent runs in a row used no tokens: the last one failed (the worker hit an unexpected error)",
      "Alarm: 3 runs on several items failed the same way (the worker hit an unexpected error): boom in the worker",
    ]);
    for (const a of alarms) expect(internalNames(a.textContent ?? "")).toEqual([]);
    expect(internalNames(visibleText(container))).toEqual([]);
  });

  it("/app/items shows the failed item's reason in plain words and no internal name", async () => {
    history.replaceState(null, "", "/app/items");
    const { container } = mount();
    const reason = await screen.findByText(/^Triage failed twice the same way/);
    expect(reason.closest("[data-why]")!.textContent).toBe("Triage failed twice the same way. Decide what happens next. Alarm: 4 agent runs in a row used no tokens");
    expect(internalNames(visibleText(container))).toEqual([]);
  });

  it("the failed item's page shows no internal name; codes and full run IDs are in code under Details", async () => {
    history.replaceState(null, "", `/app/items/${failed.id}`);
    const { container } = mount();
    const table = await screen.findByRole("table", { name: "Runs" });
    await screen.findByRole("heading", { level: 1, name: "Add the export button" });
    expect(internalNames(visibleText(container))).toEqual([]);
    // The Runs table: the row's title is the step and its attempt; no run ID, short or full, is row text (Copy ID in
    // its ⋯ menu copies it, design 09-dashboard-item).
    const run = table.querySelector<HTMLElement>(`tr[data-run="${RUN}"]`)!;
    expect(run.querySelector<HTMLElement>("[data-cell-title]")!.textContent).toMatch(/^\w+ #\d+$/);
    expect(run.textContent).not.toContain("f726027e");
    // The thread names the message's kind in words.
    const thread = screen.getByRole("list", { name: "Thread" });
    expect(within(thread).getByText("Run failed")).toBeTruthy();
    // The factory's run-failed comment names the failure in words; its error code is code under Details.
    const body = thread.querySelector<HTMLElement>("[data-raw]")!;
    body.querySelectorAll("[data-raw]").forEach((n) => n.removeAttribute("data-raw"));
    expect(visibleText(body)).toContain("the worker hit an unexpected error");
    expect(internalNames(visibleText(body))).toEqual([]);
    expect([...body.querySelectorAll("details code")].map((c) => c.textContent)).toContain("exception");
    // The timeline's sentence for the repeated failure, its fields in code under Details.
    expect(screen.getByText("Failed twice the same way, so it needs you")).toBeTruthy();
    expect([...container.querySelectorAll("details code")].map((c) => c.textContent)).toContain("blocked_reason: – → repeated_failure");
  });

  it("the header labels the commit hash Factory version, with a tooltip", async () => {
    history.replaceState(null, "", "/app/tasks");
    mount();
    const rev = await screen.findByTestId("factory-rev");
    const label = screen.getByText("Factory version");
    expect(label.parentElement).toBe(rev.parentElement);
    expect(rev.getAttribute("title")).toBeTruthy();
  });
});

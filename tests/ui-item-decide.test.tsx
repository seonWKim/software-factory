// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../web/src/App.js";

// The item page's "What you need to decide" box (design 09-dashboard-app): at the top, the reason, In short, each
// open decision with its default, and the buttons that apply now (the one the state asks for is primary), plus the
// same command for a terminal with the item's short number. Every control has a name; the severity choice has a
// visible "Severity" label. The owner reads "you", a worker "worker N", their IDs behind a details element.

const AT = "2026-11-12T00:00:00.000Z";
const cmd = (name: string) => ({ name, usage: `/${name}`, description: name, allowed: true, reason: null });
const SPEC = {
  in_short: "AS-IS: nothing checks the scope.\nTO-BE: CI checks the scope.",
  decisions: [
    { question: "Fail the job, or only warn?", options: ["Fail the job", "Only warn"], default: "Fail the job", reason: "A failing job blocks merges.", owner_only: false },
    { question: "Name the step?", options: [], default: "scope", reason: null, owner_only: false },
  ],
};
const item = (extra: object = {}) => ({
  id: "wi_9f3c2a", source: { type: "github_issue", id: "o/r#30", link: "https://github.com/o/r/issues/30" }, title: "Check the scope in CI",
  stage: "READY", close_reason: null, blocked_on: "human", blocked_reason: "spec_pending", tier: 2, loop_count: 0, restart_count: 0, token_cost: 0,
  change_ref: null, change_url: null, spec_comment_url: null, parent_id: null, phase: null, phases: [], version: 3, created_at: AT, updated_at: AT,
  why: { code: "human", reason_code: "spec_pending", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null },
  ...extra,
});
const detail = (extra: object = {}) => ({
  as_of: AT,
  item: item(),
  timeline: [
    { version: 1, at: AT, actor: { kind: "user", id: "local:me" }, reason: "intake", changes: {}, detail: null },
    { version: 2, at: AT, actor: { kind: "user", id: "github:4711", name: null }, reason: "comment", changes: {}, detail: null },
  ],
  runs: [{ id: "run_t1", kind: "triage", status: "succeeded", attempt: 1, started_at: AT, finished_at: AT, created_at: AT, tokens: 5, error: null, attempts: [{ attempt: 1, worker_id: "mac-mini:4242:3" }] }],
  commands: ["approve", "revise", "reject"].map(cmd),
  replies: [],
  spec: SPEC,
  ...extra,
});

let body: Record<string, unknown>;

beforeEach(() => {
  body = detail();
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = url.split("?")[0]!;
    const bodies: Record<string, unknown> = {
      "/api/v1/items/wi_9f3c2a": body,
      "/api/v1/session": { as_of: AT, csrf_token: "tok", commands_enabled: true, actor: "local:me", actor_source: "environment" },
      "/api/v1/overview": { as_of: AT, stages: {}, needs_you: 1, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } },
    };
    const out = bodies[path];
    if (out === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }));
  vi.stubGlobal("scrollTo", () => undefined);
  history.replaceState(null, "", "/app/items/wi_9f3c2a");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

/** The box, once the session has enabled its buttons. */
async function box() {
  const decide = await screen.findByRole("region", { name: "What you need to decide" });
  await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false));
  return decide;
}

const FACTORY_MSG = { seq: 7, at: AT, kind: "spec", author: "factory", role: "factory", channel: "github_issue", anchor: "msg-7", body: "## Spec ready for approval\n\nLonger text of the spec." };

describe("item page: What you need to decide", () => {
  it("an item in triage (next actor is the factory) renders no decision box, but still has its menu", async () => {
    body = detail({ item: item({ stage: "NEW", blocked_on: null, blocked_reason: null, why: { code: "triage", reason_code: "person", params: { reason: "Running triage" }, alarms: [], holder_id: null, next_actor: "factory", refs: [], ref_url: null } }), spec: null });
    mount();
    await screen.findByRole("heading", { name: "Check the scope in CI" });
    await screen.findByRole("button", { name: "More commands" });
    expect(document.querySelector("[data-decide]")).toBeNull();
    expect(screen.queryByRole("region", { name: "What you need to decide" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("at merge_pending renders one box whose first button is Merge, then Good/Bad, Feedback and the menu", async () => {
    body = detail({
      item: item({ stage: "MERGE_PENDING", blocked_reason: null, merge: { enabled: true, reason: null }, why: { code: "merge", reason_code: "person", params: { reason: "Ready to merge" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
      commands: ["verdict", "reject"].map(cmd), spec: null,
    });
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    expect(document.querySelectorAll("[data-decide]")).toHaveLength(1);
    await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
    const row = within(decide).getByRole("button", { name: "Merge" }).closest("[data-command]")!.parentElement!;
    expect([...row.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Merge", "Good", "Bad", "Feedback", "⋯"]);
    expect(decide.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("shows the latest factory message above the note box, with a Show in thread link to its anchor", async () => {
    const older = { ...FACTORY_MSG, seq: 3, anchor: "msg-3", at: "2026-11-11T00:00:00.000Z", body: "An older message." };
    body = detail({ thread: [older, FACTORY_MSG] });
    mount();
    const decide = await box();
    const context = decide.querySelector("[data-decide-context]") as HTMLElement;
    expect(context.textContent).toContain("Spec ready for approval");
    expect(context.textContent).not.toContain("older");
    expect(within(context).getByRole("link", { name: "Show in thread" }).getAttribute("href")).toBe("#msg-7");
    expect(context.compareDocumentPosition(within(decide).getByRole("textbox", { name: "Note" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("at spec approval shows the box at the top with the reason, each open decision, Approve and Revise", async () => {
    mount();
    const decide = await box();
    // At the top: after the title, before the facts, the thread and the runs.
    const title = screen.getByRole("heading", { name: "Check the scope in CI" });
    expect(title.compareDocumentPosition(decide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const later of [screen.getByText("Tier"), screen.getByRole("region", { name: "Thread" }), screen.getByRole("region", { name: "Runs" })]) {
      expect(decide.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(within(decide).getByTestId("why").textContent).toBe("Waiting for a person to approve the spec");
    expect(within(decide).getByRole("region", { name: "In short" }).textContent).toContain("TO-BE: CI checks the scope.");
    expect(within(decide).getByRole("radiogroup", { name: "1. Fail the job, or only warn?" })).toBeTruthy();
    expect((within(decide).getByRole("radio", { name: "Fail the job(default)" }) as HTMLInputElement).checked).toBe(true);
    expect((within(decide).getByRole("textbox", { name: "Answer 2" }) as HTMLInputElement).value).toBe("scope");
    // The row reads Approve, Revise; approve, the one the state asks for, is first and the one primary button.
    const buttons = ["Approve", "Revise"].map((n) => within(decide).getByRole("button", { name: n }));
    expect(buttons[0]!.className).toContain("bg-accent");
    expect(buttons[1]!.className).not.toContain("bg-accent");
    expect(within(decide).queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("has no control without an accessible name", async () => {
    mount();
    await box();
    const result = await axe.run(document.querySelector("main")!, {
      runOnly: ["button-name", "select-name", "label", "aria-input-field-name", "link-name", "summary-name", "input-button-name"],
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });

  it("the terminal hint names the item's short number; Copy copies the full command", async () => {
    const copied: string[] = [];
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: async (t: string) => void copied.push(t) } });
    mount();
    const decide = await box();
    const hint = decide.querySelector("[data-cli-hint]") as HTMLElement;
    expect(hint.querySelector("code")!.textContent).toBe("factory approve #30");
    expect(hint.textContent).not.toContain("wi_9f3c2a");
    within(hint).getByRole("button", { name: "Copy command" }).click();
    await vi.waitFor(() => expect(copied).toEqual(["factory approve wi_9f3c2a"]));
  });

  it("shows the owner as you and a worker as worker N, each ID in a tooltip on its name", async () => {
    mount();
    await box();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    const people = [...timeline.querySelectorAll("[data-id]")].map((s) => s.textContent);
    expect(people).toContain("you");
    expect(people).toContain("a person");
    const runs = screen.getByRole("table", { name: "Runs" });
    const worker = runs.querySelector("[data-id]")!;
    expect(worker.tagName).toBe("BUTTON");
    expect(worker.textContent).toBe("worker 3");
    expect(runs.querySelector("details")).toBeNull();
    fireEvent.mouseEnter(worker.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("mac-mini:4242:3");
    // "Acting as" names the viewer as you too.
    expect(document.querySelector("[data-commands-actor] [data-id]")!.textContent).toBe("you");
  });
});

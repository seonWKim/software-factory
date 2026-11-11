// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
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
  why: { code: "human", text: "Waiting for a person to approve the spec", next_actor: "human", refs: [], ref_url: null },
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
  await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "approve" }) as HTMLButtonElement).disabled).toBe(false));
  return decide;
}

describe("item page: What you need to decide", () => {
  it("at spec approval shows the box at the top with the reason, each open decision, Approve, Revise and Reject", async () => {
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
    // The buttons read Approve, Revise and Reject; approve, the one the state asks for, is the one primary button.
    const buttons = ["approve", "revise", "reject"].map((n) => within(decide).getByRole("button", { name: n }));
    for (const b of buttons) expect(b.className.split(" ")).toContain("capitalize");
    expect(buttons[0]!.className).toContain("bg-zinc-900");
    expect(buttons.slice(1).map((b) => b.className.includes("bg-zinc-900"))).toEqual([false, false]);
  });

  it("has no control without an accessible name", async () => {
    mount();
    await box();
    const result = await axe.run(document.querySelector("main")!, {
      runOnly: ["button-name", "select-name", "label", "aria-input-field-name", "link-name", "summary-name", "input-button-name"],
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
  });

  it("the severity dropdown has a visible label, Severity", async () => {
    body = detail({ item: item({ stage: "REVIEW", blocked_reason: "merge_pending", change_ref: "41" }), commands: [cmd("verdict")], spec: null });
    mount();
    const select = await screen.findByRole("combobox", { name: "Severity" });
    const label = select.closest("label")!;
    expect(label.textContent).toContain("Severity");
    expect(select.getAttribute("aria-label")).toBeNull();
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

  it("shows the owner as you and a worker as worker N, each ID behind a details element", async () => {
    mount();
    await box();
    const timeline = screen.getByRole("region", { name: "Timeline" });
    const people = [...timeline.querySelectorAll("details > summary")].map((s) => s.textContent);
    expect(people).toContain("you");
    expect(people).toContain("a person");
    const runs = screen.getByRole("table", { name: "Runs" });
    const worker = runs.querySelector("details")!;
    expect(worker.querySelector("summary")!.textContent).toBe("worker 3");
    expect(worker.textContent).toContain("mac-mini:4242:3");
    // "Acting as" names the viewer as you too.
    expect(document.querySelector("[data-commands-actor] summary")!.textContent).toBe("you");
  });
});

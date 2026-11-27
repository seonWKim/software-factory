// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { fireEvent, screen, within, cleanup } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FACTORY_MSG, box, decideCmd as cmd, decideDetail as detail, decideState, installDecideFixtures, item, mountDecide as mount } from "./ui-shell-fixtures.js";

// The item page's DecisionCard (design 09-dashboard-item-commands): first on the page while the owner is next, the
// question (the reason), the evidence it is based on (the newest factory message, In short, a permission ask's
// paths), then one button per action the decision takes, each with data-action and its command. The page body has no
// command prose: the command help is behind ? and ⌘K. Every control has a name. The owner reads "you", a worker
// "worker N", their IDs in a tooltip.

installDecideFixtures();

describe("item page: DecisionCard", () => {
  const pause = (thread?: object[]) => detail({
    item: item({ stage: "QUEUED", blocked_on: null, blocked_reason: null, why: { code: "paused", reason_code: "paused_model_credential", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
    commands: ["verdict", "revise", "reject"].map(cmd), spec: null, ...(thread ? { thread } : {}),
  });
  const REFUSAL = { ...FACTORY_MSG, seq: 9, kind: "refused", anchor: "msg-9", body: "`/retry` was not applied: there is no failed run to retry." };

  it("during the model credential pause the card offers Add model credential, no Good, Bad or Feedback, and no empty Based on", async () => {
    decideState.body = pause();
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    const add = await within(decide).findByRole("button", { name: "Add model credential" });
    expect(within(decide).queryByRole("button", { name: "Good" })).toBeNull();
    expect(within(decide).queryByRole("button", { name: "Bad" })).toBeNull();
    expect(within(decide).queryByRole("button", { name: "Feedback" })).toBeNull();
    expect(within(decide).queryByText("Based on")).toBeNull();
    fireEvent.click(add);
    expect(await screen.findByRole("dialog", { name: "Add a model credential" })).toBeTruthy();
  });

  it("on a New item during the pause the card shows Add context and Attach, and no revise form opens", async () => {
    const p = pause();
    p.item = { ...p.item, stage: "NEW" };
    decideState.body = p;
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    const ctx = await within(decide).findByRole("button", { name: "Add context" });
    await vi.waitFor(() => expect((ctx as HTMLButtonElement).disabled).toBe(false));
    expect(within(decide).getByRole("button", { name: "Attach" })).toBeTruthy();
    expect(within(decide).queryByRole("button", { name: "Revise" })).toBeNull();
    fireEvent.click(ctx);
    const dialog = await screen.findByRole("dialog");
    for (const f of ["In short", "Scope", "Allowed paths"]) expect(within(dialog).queryByText(f)).toBeNull();
    expect(within(dialog).getAllByRole("textbox")).toHaveLength(1);
    expect(dialog.textContent).not.toContain("current");
  });

  it("with a spec Revise opens the five-section form; without one (not New) it opens one Add context textarea", async () => {
    mount();
    const decide = await box();
    fireEvent.click(within(decide).getByRole("button", { name: "Revise" }));
    const form = await screen.findByRole("dialog", { name: "Revise Check the scope in CI" });
    expect([...form.querySelectorAll("[data-revise-section]")].map((x) => x.getAttribute("data-revise-section"))).toEqual(["In short", "Problem", "Done when", "Scope", "Allowed paths"]);
    expect(form.textContent).toContain("The factory writes a new plan from your comments.");
    cleanup();
    decideState.body = detail({ spec: null });
    mount();
    const again = await box();
    expect(within(again).queryByRole("button", { name: "Attach" })).toBeNull();
    fireEvent.click(within(again).getByRole("button", { name: "Revise" }));
    const modal = await screen.findByRole("dialog", { name: "Add context Check the scope in CI" });
    expect(within(modal).getAllByRole("textbox")).toHaveLength(1);
    expect(modal.querySelector("[data-revise-section]")).toBeNull();
  });

  it("during the pause a refusal as the newest factory message is not shown under Based on", async () => {
    decideState.body = pause([REFUSAL]);
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    await within(decide).findByRole("button", { name: "Add model credential" });
    expect(within(decide).queryByRole("button", { name: "Good" })).toBeNull();
    expect(within(decide).queryByRole("button", { name: "Bad" })).toBeNull();
    expect(within(decide).queryByText("Based on")).toBeNull();
    expect(decide.querySelector("[data-decision-evidence]")).toBeNull();
    expect(decide.textContent).not.toContain("was not applied");
  });

  it("at merge_pending renders one card whose first button is Merge, then Good/Bad, Feedback and the menu, each action with data-action", async () => {
    decideState.body = detail({
      item: item({ stage: "MERGE_PENDING", blocked_reason: null, merge: { enabled: true, reason: null }, why: { code: "merge", reason_code: "person", params: { reason: "Ready to merge" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
      commands: ["verdict", "reject"].map(cmd), spec: null,
    });
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    expect(document.querySelectorAll("[data-decision-card]")).toHaveLength(1);
    await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "Merge" }) as HTMLButtonElement).disabled).toBe(false));
    const row = decide.querySelector("[data-decision-actions]")!;
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent)).toEqual(["Merge", "Good", "Bad", "Feedback", "⋯"]);
    expect(buttons.slice(0, -1).map((b) => b.dataset.action)).toEqual(["merge", "verdict", "verdict", "verdict"]);
    // The "…" menu's entries are actions too: Verdict and Reject, each with its command.
    fireEvent.click(within(decide).getByRole("button", { name: "More commands" }));
    expect(screen.getAllByRole("menuitem").map((m) => [m.textContent, m.dataset.action])).toEqual([["Verdict", "verdict"], ["Reject", "reject"]]);
    expect(decide.querySelectorAll("textarea")).toHaveLength(1);
  });

  it("shows the latest factory message above the note box, with a Show in thread link to its anchor", async () => {
    const older = { ...FACTORY_MSG, seq: 3, anchor: "msg-3", at: "2026-11-11T00:00:00.000Z", body: "An older message." };
    decideState.body = detail({ thread: [older, FACTORY_MSG] });
    mount();
    const decide = await box();
    const context = decide.querySelector("[data-decision-evidence] [data-decide-context]") as HTMLElement;
    expect(context.textContent).toContain("Spec ready for approval");
    expect(context.textContent).not.toContain("older");
    expect(within(context).getByRole("link", { name: "Show in thread" }).getAttribute("href")).toBe("#msg-7");
    expect(context.compareDocumentPosition(within(decide).getByRole("textbox", { name: "Note" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("at spec approval renders the card first: the question, its evidence, then Approve, Revise and Reject, each sending its command", async () => {
    mount();
    const decide = await box();
    // First: after the title, before the facts, the thread, the runs and the timeline.
    const title = screen.getByRole("heading", { name: "Check the scope in CI" });
    expect(title.compareDocumentPosition(decide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const later of [screen.getByText("Risk level"), screen.getByRole("region", { name: "Thread" }), screen.getByRole("region", { name: "Runs" }), screen.getByRole("region", { name: "Timeline" })]) {
      expect(decide.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // The question, then the evidence, then the buttons.
    const question = decide.querySelector("[data-decision-question]")!;
    const evidence = decide.querySelector("[data-decision-evidence]")!;
    const actions = decide.querySelector("[data-decision-actions]")!;
    expect(within(question as HTMLElement).getByTestId("why").textContent).toBe("Waiting for a person to approve the spec");
    expect(question.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(evidence.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(evidence as HTMLElement).getByRole("region", { name: "In short" }).textContent).toContain("TO-BE: CI checks the scope.");
    expect(within(decide).getByRole("radiogroup", { name: "1. Fail the job, or only warn?" })).toBeTruthy();
    expect((within(decide).getByRole("radio", { name: "Fail the job(default)" }) as HTMLInputElement).checked).toBe(true);
    expect((within(decide).getByRole("textbox", { name: "Answer 2" }) as HTMLInputElement).value).toBe("scope");
    // Approve and Revise, then Reject in the "…" menu; approve, the one the state asks for, is first and the one primary button.
    const buttons = [...actions.querySelectorAll<HTMLButtonElement>(":scope > span > button[data-action]")];
    expect(buttons.map((b) => [b.textContent, b.dataset.action])).toEqual([["Approve", "approve"], ["Revise", "revise"]]);
    expect(buttons[0]!.className).toContain("bg-accent");
    expect(buttons[1]!.className).not.toContain("bg-accent");
    // Reject sends its existing command through the item commands route, after its dialog.
    fireEvent.click(within(decide).getByRole("button", { name: "More commands" }));
    const reject = screen.getByRole("menuitem", { name: "Reject" });
    expect(reject.dataset.action).toBe("reject");
    fireEvent.click(reject);
    const dialog = screen.getByRole("dialog", { name: "Reject Check the scope in CI" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "duplicate" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Confirm reject" }));
    await vi.waitFor(() => expect(decideState.posts).toEqual([{ url: "/api/v1/items/wi_9f3c2a/commands", body: { command: "reject", note: "duplicate" } }]));
  });

  it("is absent when no person is needed, and a command the item API marks not allowed is disabled and sends nothing", async () => {
    decideState.body = detail({ commands: [{ ...cmd("approve"), allowed: false, reason: "not allowed (approve_spec)" }, cmd("revise")] });
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    await vi.waitFor(() => expect((within(decide).getByRole("button", { name: "Revise" }) as HTMLButtonElement).disabled).toBe(false));
    const approve = within(decide).getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.dataset.action).toBe("approve");
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    await new Promise((r) => setTimeout(r, 20));
    expect(decideState.posts).toEqual([]);
  });

  it("a permission ask shows the paths it asks for as evidence, and its button allows them with +paths", async () => {
    const paths = ["web/src/x.tsx", "docs/y.md"];
    decideState.body = detail({
      item: item({ stage: "RUNNING", blocked_reason: "agent_needs_human", why: { code: "human", reason_code: "person", params: { reason: "May I edit these paths?" }, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
      commands: [{ ...cmd("retry"), paths }, cmd("revise"), cmd("reject")], spec: null,
    });
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    const evidence = decide.querySelector<HTMLElement>("[data-decision-evidence]")!;
    expect([...evidence.querySelectorAll("[data-asked-paths] code")].map((c) => c.textContent)).toEqual(paths);
    const allow = within(decide).getByRole("button", { name: "Allow and retry" }) as HTMLButtonElement;
    expect(allow.dataset.action).toBe("retry");
    expect(within(decide).queryByRole("button", { name: "Retry" })).toBeNull();
    await vi.waitFor(() => expect(allow.disabled).toBe(false));
    fireEvent.click(allow);
    await vi.waitFor(() => expect(decideState.posts).toEqual([{ url: "/api/v1/items/wi_9f3c2a/commands", body: { command: "retry", note: "+paths web/src/x.tsx docs/y.md" } }]));
  });

  it("an out_of_scope resolve failure shows Allow and resolve, whose dialog lists the files; Cancel sends nothing, Confirm sends /resolve +paths with its notes", async () => {
    const reply = { ...FACTORY_MSG, kind: "run_failed", body: "Reply `/resolve +paths a/b.ts` to allow them and resolve again. Changed files outside the conflicts and allowed_paths: a/b.ts" };
    decideState.body = detail({
      item: item({ stage: "RUNNING", blocked_reason: "merge_conflict", why: { code: "human", reason_code: "merge_conflict", params: {}, alarms: [], holder_id: null, next_actor: "human", refs: [], ref_url: null } }),
      commands: [{ ...cmd("resolve"), paths: ["a/b.ts"], out_of_scope: true }, cmd("revise"), cmd("reject")], spec: null, thread: [reply],
    });
    mount();
    const decide = await screen.findByRole("region", { name: "What you need to decide" });
    const evidence = decide.querySelector<HTMLElement>("[data-decision-evidence]")!;
    expect(evidence.textContent).toContain("/resolve +paths a/b.ts");
    expect([...evidence.querySelectorAll("[data-asked-paths] code")].map((c) => c.textContent)).toContain("a/b.ts");
    const allow = within(decide).getByRole("button", { name: "Allow and resolve" }) as HTMLButtonElement;
    expect(allow.dataset.action).toBe("resolve");
    expect(allow.getAttribute("aria-haspopup")).toBe("dialog");
    await vi.waitFor(() => expect(allow.disabled).toBe(false));
    fireEvent.click(allow);
    const cancel = await screen.findByRole("dialog", { name: "Allow and resolve Check the scope in CI" });
    expect([...cancel.querySelectorAll("[data-allow-resolve] code")].map((c) => c.textContent)).toContain("a/b.ts");
    fireEvent.click(within(cancel).getByRole("button", { name: "Cancel" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(decideState.posts).toEqual([]);
    fireEvent.click(allow);
    const dialog = await screen.findByRole("dialog", { name: "Allow and resolve Check the scope in CI" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Notes for the resolve run (optional)" }), { target: { value: "Keep the moved file." } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Allow and resolve" }));
    await vi.waitFor(() => expect(decideState.posts).toEqual([{ url: "/api/v1/items/wi_9f3c2a/commands", body: { command: "resolve", note: "+paths a/b.ts\nKeep the moved file." } }]));
  });

});

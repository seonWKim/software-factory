// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applied, APPLIED, card, choose, dialog, off, openDetails, openDialog, proposalEntry, PUSHBACKS, reset, s, sent, show, SLOW, teardown, TOKEN, view, whyToggle } from "./ui-rules-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// The Rules page verdict tests: the Promote, Hold, Reject, Retire, Edit, Dismiss and Open evidence dialogs, their refusals, and the read-only views for a user who is not the owner. The shared stub is in tests/ui-rules-fixtures.ts.

describe("Rules page", () => {
  it("a verdict button asks for a reason before it sends; promote of a class sends the edited wording, default and exception", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Promote");
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(s.posts).toEqual([]);
    const wording = within(dialog()).getByRole("textbox", { name: "Rule wording" }) as HTMLTextAreaElement;
    expect(wording.value).toBe("Keep existing CLI flags.");
    fireEvent.change(wording, { target: { value: "Keep every existing CLI flag." } });
    const dflt = within(dialog()).getByRole("textbox", { name: "Default" }) as HTMLTextAreaElement;
    const exception = within(dialog()).getByRole("textbox", { name: "Exception" }) as HTMLTextAreaElement;
    expect([dflt.value, exception.value]).toEqual(["Keep every flag.", "a deprecated flag"]);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "seen twice" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.change(exception, { target: { value: " " } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(exception, { target: { value: "a flag marked deprecated" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/rules/verdict");
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
    expect(sent()).toEqual([{
      id: "C-012", verdict: "promote", reason: "seen twice", text: "Keep every existing CLI flag.", default: "Keep every flag.", exception: "a flag marked deprecated",
    }]);
  });

  it("hold and reject send only the reason; they ask for no wording and no applied-to file", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    for (const [label, reason] of [["Hold", "wait"], ["Reject", "not code"]] as const) {
      choose(card("P-0007"), label);
      for (const name of ["Rule wording", "Default", "Exception", "Applied to"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
      fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: reason } });
      fireEvent.click(within(dialog()).getByRole("button", { name: `Send ${label.toLowerCase()}` }));
      await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    }
    expect(sent()).toEqual([
      { id: "P-0007", verdict: "hold", reason: "wait" },
      { id: "P-0007", verdict: "reject", reason: "not code" },
    ]);
  });

  it("promote of a proposal shows its Now and Proposed lines, asks for no wording or file, and sends only the reason", async () => {
    s.current = view({
      entries: [{ id: "P-20261101-158e", title: "Quiet notify", state: "open", kind: "edit-asset", target: "private/bin/notify", judged: null, draft: null, draft_error: null }],
    });
    s.detail = (id) => ({ id, error: null, detail: { id, target: "private/bin/notify", current: "notify --loud", proposed: "notify --quiet" } });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-20261101-158e"), "Promote");
    for (const name of ["Rule wording", "Default", "Exception", "Applied to"]) expect(within(dialog()).queryByRole("textbox", { name })).toBeNull();
    await waitFor(() => expect(dialog().querySelector('[data-change="proposed"]')!.textContent).toBe("notify --quiet"), SLOW);
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting replaces the Now lines with the Proposed lines in the target file, then records the verdict. If the Now lines are not there exactly once, or the change is refused, nothing is written and the error shows here.",
    );
    expect(dialog().querySelector('[data-change="current"]')!.textContent).toBe("notify --loud");
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "good shape" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(sent()).toEqual([{ id: "P-20261101-158e", verdict: "promote", reason: "good shape" }]);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
  });

  it("a waiting proposal with a prose change is promoted from the page: its change shows, Send is on with a reason, the verdict is sent and the success message shows", async () => {
    s.current = view({
      entries: [{ id: "P-20261017-4c1d", title: "Review runs the tests", state: "open", kind: "edit-asset", target: "skills/review/SKILL.md", judged: null, draft: null, draft_error: null }],
    });
    s.detail = (id) => ({
      id, error: null,
      detail: { id, kind: "edit-asset", target: "skills/review/SKILL.md", change: "Run the changed tests before the verdict.", root_reason: "tests never ran", incidents: 2, evidence: [{ ref: "T-20261017-de7e" }, { ref: "T-20261017-9f3c" }] },
    });
    s.answer = { status: 200, body: { id: "P-20261017-4c1d", verdict: "promote" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-20261017-4c1d"), "Promote");
    await waitFor(() => expect(dialog().querySelector("[data-detail-change]")).not.toBeNull(), SLOW);
    const what = dialog().querySelector('[data-detail-part="what"]')!;
    expect(what.querySelector("h3")!.textContent).toBe("What to promote");
    expect(what.querySelector("[data-detail-change]")!.textContent).toBe("Run the changed tests before the verdict.");
    expect(dialog().querySelector('[data-detail-part="why"]')!.textContent).toContain("Root reason: tests never ran");
    expect([...dialog().querySelectorAll("[data-evidence]")].map((e) => (e as HTMLElement).dataset.evidence)).toEqual(["T-20261017-de7e", "T-20261017-9f3c"]);
    const consequence = dialog().querySelector("[data-dialog-consequence]")!.textContent!;
    expect(consequence).toBe("Promoting records the verdict and creates a task to build it.");
    expect(consequence).not.toMatch(/by hand|Now and Proposed/);
    expect(within(dialog()).queryByRole("alert")).toBeNull();
    const confirm = within(dialog()).getByRole("button", { name: "Send promote" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "applied it" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(s.posts).toHaveLength(1));
    expect(s.posts[0]!.url).toBe("/api/v1/rules/verdict");
    expect(sent()).toEqual([{ id: "P-20261017-4c1d", verdict: "promote", reason: "applied it" }]);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe("Promote sent for Review runs the tests.");
  });

  it("a waiting proposal with no target: Promote is off, the row says why, and no dialog opens", async () => {
    s.current = view({ entries: [{ id: "P-0010", title: "No file named", state: "open", kind: "edit-asset", judged: null, draft: null, draft_error: null }] });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const promote = within(card("P-0010")).getByRole("button", { name: "Promote" }) as HTMLButtonElement;
    expect(promote.disabled).toBe(true);
    fireEvent.click(promote);
    expect(document.querySelector("dialog[data-dialog]")).toBeNull();
    expect(card("P-0010").querySelector("[data-rule-gist]")!.textContent).toBe("Names no file to change");
    fireEvent.click(within(card("P-0010")).getByRole("button", { name: /^Decide:/ }));
    expect((within(card("P-0010")).getByRole("menuitem", { name: "Hold" }) as HTMLButtonElement).disabled).toBe(false);
    expect(card("P-0010").querySelector("[data-no-target]")!.textContent).toBe("Promote is off: this proposal names no file it changes.");
    expect(card("P-0007")).toBeNull();
  });

  it("a failed apply keeps the dialog open with the CLI's error", async () => {
    s.detail = (id) => ({ id, error: null, detail: { id, target: "prompts/review.md", current: "a", proposed: "b" } });
    s.answer = { status: 502, body: { error: "The ledger refused the verdict: evolve verdict exited 1: evolve: P-0007 was judged already" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("P-0007"), "Promote");
    await waitFor(() => expect(dialog().querySelector('[data-change="proposed"]')).not.toBeNull(), SLOW);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send promote" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("evolve: P-0007 was judged already");
  });

  it("promote of a class keeps its own help text and has no Applied to field", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Promote");
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toBe(
      "Promoting writes this rule into your rules, records the verdict and updates your agents' instructions; it is part of every run's prompt from the next run on.",
    );
    expect(within(dialog()).queryByRole("textbox", { name: "Applied to" })).toBeNull();
  });

  it("a refusal stays in the dialog", async () => {
    s.answer = { status: 403, body: { error: "Only the owner judges rules; you are local:alice." } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-012"), "Hold");
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "x" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Send hold" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
  });

  it("a user who is not the owner sees the entries read-only with the reason, and no verdict buttons", async () => {
    s.current = view({ judge: "Only the owner judges rules; you are local:alice." });
    await show();
    expect((await screen.findByRole("alert", {}, SLOW)).textContent).toContain("Only the owner");
    // Read-only: the detail opens, but no verdict button shows; the ⋯ menu holds Copy ID only.
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["⋯"]);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: /^Actions:/ }));
    expect(within(card("C-012")).getAllByRole("menuitem").map((i) => i.textContent)).toEqual(["Copy ID"]);
    expect(whyToggle("C-012")).not.toBeNull();
  });

  it("Retire opens a dialog with a required reason (not in the row) and sends the retire verdict with no rule fields", async () => {
    s.current = view({ applied: APPLIED });
    s.answer = { status: 200, body: { id: "C-001", verdict: "retire" } };
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    // No visible Retire button: Retire is the danger item of the row's ⋯ menu, at the right of the title line.
    expect(within(applied("C-001")).queryByRole("button", { name: "Retire" })).toBeNull();
    const more = within(applied("C-001")).getByRole("button", { name: "Actions: summary first" });
    expect(more.closest("[data-row-menu]")!.parentElement).toBe(applied("C-001"));
    fireEvent.click(more);
    const item = within(applied("C-001")).getByRole("menuitem", { name: "Retire" });
    expect(item.className).toContain("text-pill-bad-fg");
    fireEvent.click(item);
    expect(applied("C-001").querySelector("textarea, input")).toBeNull();
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe("Retire: summary first");
    const confirm = within(dialog()).getByRole("button", { name: "Send retire" }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Reason" }), { target: { value: "covered by C-002" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(sent()).toEqual([{ id: "C-001", verdict: "retire", reason: "covered by C-002" }]);
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("a user who is not the owner sees the menu's Edit and Retire disabled, with the owner-only tooltip; Open evidence stays on", async () => {
    s.current = view({ applied: APPLIED, judge: "Only the owner judges rules; you are local:alice." });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    for (const name of ["Edit", "Retire"]) {
      const item = within(applied("C-001")).getByRole("menuitem", { name }) as HTMLButtonElement;
      expect(item.disabled).toBe(true);
      fireEvent.click(item);
      expect(document.querySelector("dialog[data-dialog]")).toBeNull();
    }
    expect((within(applied("C-001")).getByRole("menuitem", { name: "Open evidence" }) as HTMLButtonElement).disabled).toBe(false);
    // The owner-only reason is the menu's tooltip.
    fireEvent.mouseEnter(applied("C-001").querySelector("[data-row-menu] span")!);
    expect(within(applied("C-001")).getByRole("tooltip").textContent).toBe("Only the owner edits or retires a rule.");
  });

  it("Edit opens the three-field dialog prefilled with the rule, asks for no reason, and posts the new text to /api/v1/rules/edit", async () => {
    const rule = { id: "C-001", name: "summary first", default: "Open with a summary.\nThen the detail.", exceptions: "a one-word reply", scope: null, incidents: ["T-1"], judged: null, raw: null };
    s.current = view({ applied: { rules: [rule], elsewhere: [] } });
    s.answer = { status: 200, body: { id: "C-001" } };
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Edit" }));
    const d = dialog();
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("Edit: summary first");
    const field = (name: string) => within(d).getByRole("textbox", { name }) as HTMLTextAreaElement;
    expect([field("Rule wording").value, field("Default").value, field("Exception").value]).toEqual(["summary first", "Open with a summary.\nThen the detail.", "a one-word reply"]);
    for (const name of ["Rule wording", "Default", "Exception"]) expect(field(name).maxLength).toBe(2000);
    expect(within(d).getAllByRole("textbox")).toHaveLength(3);
    expect(within(d).queryByRole("textbox", { name: "Reason" })).toBeNull();
    // The confirm is the one primary action, in the ButtonRow; an empty field turns it off.
    const save = within(d).getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(within(d).getAllByRole("button").filter((b) => b.className.includes("bg-accent"))).toEqual([save]);
    fireEvent.change(field("Exception"), { target: { value: " " } });
    expect(save.disabled).toBe(true);
    fireEvent.change(field("Exception"), { target: { value: "a yes or no" } });
    fireEvent.change(field("Rule wording"), { target: { value: "summary on top" } });
    fireEvent.click(save);
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(s.posts.map((p) => p.url)).toEqual(["/api/v1/rules/edit"]);
    expect(sent()).toEqual([{ id: "C-001", text: "summary on top", default: "Open with a summary.\nThen the detail.", exception: "a yes or no" }]);
    expect(new Headers(s.posts[0]!.init.headers).get("x-csrf-token")).toBe(TOKEN);
  });

  it("an edit the server refuses keeps the dialog open with its error", async () => {
    s.current = view({ applied: APPLIED });
    s.answer = { status: 502, body: { error: "The rule was saved, but sync-agents failed: locked" } };
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Edit" }));
    fireEvent.change(within(dialog()).getByRole("textbox", { name: "Exception" }), { target: { value: "none" } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Save" }));
    expect((await within(dialog()).findByRole("alert", {}, SLOW)).textContent).toBe("The rule was saved, but sync-agents failed: locked");
  });

  it("Open evidence opens a read-only dialog titled with the rule's name, with each incident's quote", async () => {
    s.current = view({ applied: APPLIED });
    s.detail = (id) => ({
      id, error: null, retire: [], detail: {
        id, incidents: 2, root_reason: "summaries buried the point", scope: "모든 문서",
        evidence: [{ ref: "T-1", date: "2026-11-03", quote: "lead with the answer" }, { ref: "T-2", quote: "한 줄 요약 먼저" }],
      },
    });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    fireEvent.click(within(applied("C-001")).getByRole("menuitem", { name: "Open evidence" }));
    const d = dialog();
    expect(within(d).getByRole("heading", { level: 2 }).textContent).toBe("Evidence: summary first");
    await waitFor(() => expect(d.querySelectorAll("[data-example-text]")).toHaveLength(2), SLOW);
    expect([...d.querySelectorAll("[data-example-text]")].map((q) => q.textContent)).toEqual(["lead with the answer", "한 줄 요약 먼저"]);
    expect([...d.querySelectorAll("[data-detail-part]")].map((p) => p.getAttribute("data-detail-part"))).toEqual(expect.arrayContaining(["why", "examples", "where"]));
    expect(s.gets).toContain("/api/v1/rules/entry?id=C-001");
    expect(within(d).queryAllByRole("textbox")).toEqual([]);
    fireEvent.click(within(d).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(s.posts).toEqual([]);
  });

  it("Dismiss opens a dialog that says it records the pushback as noise, posts its ID, and the list reloads without it", async () => {
    s.current = view({ applied: APPLIED, pushbacks: PUSHBACKS });
    s.answer = { status: 200, body: { id: "T-0201" } };
    await show();
    await openDetails();
    const list = await screen.findByRole("list", { name: "Pushbacks" }, SLOW);
    fireEvent.click(within(within(list).getAllByRole("listitem")[0]!).getByRole("button", { name: "Dismiss" }));
    expect(dialog().querySelector("[data-dialog-consequence]")!.textContent).toContain("noise");
    expect(s.posts).toEqual([]);
    s.current = view({ applied: APPLIED, pushbacks: { rows: [PUSHBACKS.rows[1]!], error: null } });
    fireEvent.click(within(dialog()).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(document.querySelector("dialog[data-dialog]")).toBeNull());
    expect(s.posts.map((p) => p.url)).toEqual(["/api/v1/rules/pushbacks/dismiss"]);
    expect(sent()).toEqual([{ id: "T-0201" }]);
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Pushbacks" })).getAllByRole("listitem")).toHaveLength(1));
  });

  it("a user who is not the owner sees Dismiss disabled with the owner-only tooltip", async () => {
    s.current = view({ applied: APPLIED, pushbacks: PUSHBACKS, judge: "Only the owner judges rules; you are local:alice." });
    await show();
    await openDetails();
    const list = await screen.findByRole("list", { name: "Pushbacks" }, SLOW);
    const row = within(list).getAllByRole("listitem")[0]!;
    const button = within(row).getByRole("button", { name: "Dismiss" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.mouseEnter(button.parentElement!);
    expect(within(row).getByRole("tooltip").textContent).toBe("Only the owner dismisses a pushback.");
  });

  it("the verdict dialog titles the verdict and the entry title, shows the title once and the detail above the fields, and labels the reason as it reads", async () => {
    const long = "A".repeat(80);
    s.current = view({ entries: [{ id: "C-037", title: long, state: "pending", judged: null, draft: { default: "d", exception: "e", incidents: ["T-1"], scope: "s" }, draft_error: null }] });
    s.detail = { id: "C-037", error: null, detail: { id: "C-037", incidents: 2, scope: "software" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    choose(card("C-037"), "Promote");
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Promote: ${long}`);
    expect(dialog().querySelector("h2")!.textContent).not.toContain("C-037");
    // The title shows once, in the heading: the body does not repeat it.
    expect(dialog().querySelector("[data-dialog-summary]")).toBeNull();
    await waitFor(() => expect(dialog().querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    // Outside the heading, the title shows only as the prefilled rule wording (a field), never as body text.
    const body = dialog().cloneNode(true) as HTMLElement;
    body.querySelectorAll("h2, textarea").forEach((n) => n.remove());
    expect(body.textContent).not.toContain(long);
    const all = dialog().innerHTML;
    expect(all.indexOf("data-detail-part")).toBeLessThan(all.indexOf("<textarea"));
    const reason = within(dialog()).getByRole("textbox", { name: "Reason" });
    expect(dialog().querySelector(`label[for="${reason.id}"]`)!.textContent).toBe("Reason");
    expect(reason.getAttribute("aria-label")).toBeNull();
  });

  it("a proposal's card links its task once the promote created it, and shows no task before", async () => {
    s.current = view({
      entries: [
        { id: "P-0009", title: "Build a subcommand", state: "open", kind: "new-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null, task: null },
        { id: "P-0010", title: "Built", state: "open", kind: "new-asset", target: "bin/evolve", judged: "promote", draft: null, draft_error: null, task: "tk_p-0010" },
      ],
    });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(card("P-0009").querySelector("[data-rule-task]")).toBeNull();
    expect(card("P-0009").textContent).not.toContain("tk_");
    const decided = (await openDetails()).querySelector<HTMLElement>("[data-decided]")!;
    const task = decided.querySelector<HTMLElement>('[data-rule="P-0010"] [data-rule-task]')!;
    expect(task.textContent).toBe("Task to build it: tk_p-0010");
    expect(within(task).getByRole("link", { name: "tk_p-0010" }).getAttribute("href")).toBe("/app/tasks");
  });

  it("the Reject dialog shows the full title in its heading; the evidence shows 3 and the rest behind Show all N", async () => {
    const long = "B".repeat(90);
    s.current = view({ entries: proposalEntry(long) });
    const evidence = ["2026-11-01", "2026-11-05", "2026-11-03", "2026-11-04", "2026-11-02"].map((date, i) => ({ ref: `E-${i}`, date, quote: `q${i}` }));
    s.detail = { id: "P-20261103-34e9", error: null, detail: { id: "P-20261103-34e9", evidence } };
    await openDialog("Reject");
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Reject: ${long}`);
    expect(dialog().querySelector("[data-dialog-summary]")).toBeNull();
    const shown = () => [...dialog().querySelectorAll<HTMLElement>("[data-evidence]")].map((i) => i.dataset.evidence);
    expect(shown()).toEqual(["E-0", "E-1", "E-2"]);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show all 5" }));
    expect(shown()).toEqual(["E-0", "E-1", "E-2", "E-3", "E-4"]);
    expect(within(dialog()).queryByRole("button", { name: /Show all/ })).toBeNull();
  });
});

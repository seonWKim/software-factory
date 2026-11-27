// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RuleEntryView, RulesView } from "../web/src/api.js";
import { applied, APPLIED, card, dialog, json, openDialog, proposalEntry, reset, s, show, SLOW, teardown, view, whyToggle } from "./ui-rules-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// The Rules page detail tests: Why and where, examples, status, related and the long fields. The shared stub is in tests/ui-rules-fixtures.ts.

describe("Rules page", () => {
  it("opening a card reads its detail on demand and shows what to promote, why, examples and where in that order", async () => {
    s.detail = {
      id: "C-012", error: null,
      detail: {
        id: "C-012", default: "Keep every existing CLI flag.", exceptions: "a deprecated flag", incidents: 3, evidence: [{ ref: "T-1", quote: "keep --json" }],
        root_reason: "renames skip callers", scope: "software, CLI",
      },
    };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const toggle = whyToggle("C-012");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    await waitFor(() => expect(card("C-012").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(s.gets.filter((u) => u.includes("/rules/entry"))).toEqual(["/api/v1/rules/entry?id=C-012"]);
    const parts = [...card("C-012").querySelectorAll<HTMLElement>("[data-detail-part]")];
    expect(parts.map((p) => p.dataset.detailPart)).toEqual(["what", "why", "examples", "where"]);
    expect(parts.map((p) => p.querySelector("h3")!.textContent)).toEqual(["What to promote", "Why", "Examples", "Where it applies"]);
    expect(parts[0]!.textContent).toContain("Rule: Keep every existing CLI flag.");
    expect(parts[0]!.textContent).toContain("Except: a deprecated flag");
    const why = parts[1]!.textContent!;
    expect(why.indexOf("Came up 3 times.")).toBeLessThan(why.indexOf("Root reason: renames skip callers"));
    expect(parts[2]!.querySelector("[data-example-text]")!.textContent).toBe("keep --json");
    expect(parts[3]!.textContent).toContain("software, CLI");
  });

  it("a proposal's detail shows its kind and target; Why and Where it applies are left out when the ledger gives nothing, with no \"not given\"", async () => {
    s.detail = { id: "P-0007", error: null, detail: { id: "P-0007" } };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    fireEvent.click(whyToggle("P-0007"));
    await waitFor(() => expect(card("P-0007").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    const part = (name: string) => card("P-0007").querySelector(`[data-detail-part="${name}"]`);
    expect(part("what")!.textContent).toContain("Changes review.md");
    expect(part("what")!.textContent).toContain("Path: prompts/review.md");
    for (const name of ["why", "where", "examples", "status", "related"]) expect(part(name)).toBeNull();
    expect(card("P-0007").querySelector("[data-detail-long]")).toBeNull();
    expect(card("P-0007").querySelector("[data-rule-detail]")!.textContent).not.toContain("not given");
    expect(card("P-0007").querySelector("[data-detail-description]")).toBeNull();
  });

  for (const [name, answerWith] of [
    ["returns nothing", { id: "C-012", detail: null, error: null }],
    ["fails in the ledger", { id: "C-012", detail: null, error: "The detail could not be read: evolve show exited 5" }],
    ["fails over HTTP", 502],
  ] as const) {
    it(`a show that ${name}: the card keeps its title and says the detail could not be read`, async () => {
      s.detail = answerWith;
      await show();
      await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
      fireEvent.click(whyToggle("C-012"));
      await waitFor(() => expect(card("C-012").querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
      expect(card("C-012").querySelector("[data-rule-detail]")!.textContent).toBe("The detail could not be read.");
      expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    });
  }

  it("a waiting proposal's row shows its change line and gist only; its before and after lines are behind Why and where; one without lines shows no excerpt", async () => {
    s.current = view({
      entries: [
        { id: "P-20261103-34e9", title: "Quiet notify", state: "open", kind: "edit-asset", target: "bin/evolve", gist: "notify at 8am", judged: null, draft: null, draft_error: null },
        { id: "P-0007", title: "Split the review prompt", state: "held", kind: "edit-asset", target: "prompts/review.md", judged: null, draft: null, draft_error: null },
      ],
      excerpts: { "P-20261103-34e9": { before: "notify every hour", after: "notify at 8am" } },
    } as Partial<RulesView>);
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const row = card("P-20261103-34e9");
    expect(row.querySelector("[data-rule-gist]")!.textContent).toBe("Changes evolve: notify at 8am");
    expect(row.querySelector("[data-rule-excerpt]")).toBeNull();
    expect(row.textContent).not.toContain("notify every hour");
    fireEvent.click(whyToggle("P-20261103-34e9"));
    await waitFor(() => expect(row.querySelector("details [data-rule-excerpt]")).not.toBeNull(), SLOW);
    expect(row.querySelector('[data-excerpt="before"]')!.textContent).toBe("Beforenotify every hour");
    expect(row.querySelector('[data-excerpt="after"]')!.textContent).toBe("Afternotify at 8am");
    expect(row.querySelector("[data-rule-gist]")!.textContent).not.toContain("bin/");
    fireEvent.click(whyToggle("P-0007"));
    await waitFor(() => expect(card("P-0007").querySelector("[data-rule-detail]")).not.toBeNull(), SLOW);
    expect(card("P-0007").querySelector("[data-rule-excerpt]")).toBeNull();
  });

  /** A proposal linked to two incidents, each with a date, the agent's proposal, the owner's quote and a root reason, newest first. */
  const TWO_INCIDENTS: RuleEntryView = {
    id: "P-20261103-34e9", error: null,
    detail: {
      id: "P-20261103-34e9", description: "Quiet evolve's notices at night.", kind: "edit-asset", target: "bin/evolve", incidents: 2,
      evidence: [
        { ref: "T-20261104-b2", date: "2026-11-04", proposal: "notify every hour", quote: "stop at 3am", root_reason: "no quiet hours" },
        { ref: "L-0042", date: "2026-11-01", proposal: "keep notifying", quote: "too loud" },
      ],
    },
  };

  it("the card and the Promote dialog share one reading order: what, why, examples, status; each example's one line falls back from quote to proposal to root reason", async () => {
    s.current = view({ entries: proposalEntry() });
    const reason = "Notices wake the owner at night. They also hide the real alerts among the noise.";
    s.detail = {
      id: "P-20261103-34e9", error: null, cited: { "P-0003": "promote", "T-1": "hold" },
      detail: {
        id: "P-20261103-34e9", description: "Add quiet hours to evolve.", kind: "new-asset", target: "bin/evolve", root_reason: reason, incidents: 3,
        evidence: [
          { ref: "T-1", date: "2026-11-05", quote: "stop at 3am", proposal: "notify always", root_reason: "no quiet hours" },
          { ref: "L-0042", date: "2026-11-03", proposal: "keep notifying", root_reason: "no quiet hours" },
          { ref: "E-7", date: "2026-11-02", root_reason: "alerts drown" },
          { ref: "P-0003", date: "2026-11-01", quote: "see the earlier proposal" },
        ],
      },
    };
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const order = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>("[data-detail-part]")].map((p) => p.dataset.detailPart);
    fireEvent.click(whyToggle("P-20261103-34e9"));
    await waitFor(() => expect(card("P-20261103-34e9").querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    expect(order(card("P-20261103-34e9"))).toEqual(["what", "why", "examples", "status"]);
    fireEvent.click(within(card("P-20261103-34e9")).getByRole("button", { name: "Promote" }));
    await waitFor(() => expect(dialog().querySelector("[data-detail-part]")).not.toBeNull(), SLOW);
    expect(order(dialog())).toEqual(["what", "why", "examples", "status"]);
    const part = (name: string) => dialog().querySelector<HTMLElement>(`[data-detail-part="${name}"]`)!;
    expect(part("what").textContent).toContain("Add quiet hours to evolve.");
    expect(part("what").textContent).toContain("Path: bin/evolve");
    // Why is the root reason's first sentence; the whole rationale waits in the Disclosure.
    expect(part("why").textContent).toContain("Root reason: Notices wake the owner at night.");
    expect(part("why").textContent).not.toContain("real alerts");
    const long = dialog().querySelector<HTMLElement>("[data-detail-long]")!;
    expect(long.querySelector("summary")!.getAttribute("aria-expanded")).toBe("false");
    expect(long.querySelector("[data-rationale]")!.textContent).toBe(`Rationale: ${reason}`);
    fireEvent.click(within(dialog()).getByRole("button", { name: "Show all 4" }));
    const examples = [...part("examples").querySelectorAll<HTMLElement>("[data-evidence]")].map((e) => [
      e.dataset.evidence, e.querySelector("[data-evidence-date]")!.textContent, e.querySelector("[data-example-text]")!.textContent,
    ]);
    expect(examples).toEqual([
      ["T-1", "2026-11-05", "stop at 3am"],
      ["L-0042", "2026-11-03", "keep notifying"],
      ["E-7", "2026-11-02", "alerts drown"],
      ["P-0003", "2026-11-01", "see the earlier proposal"],
    ]);
    // Only a cited ID with a recorded verdict shows one, in the evidence's order.
    expect([...part("status").querySelectorAll<HTMLElement>("[data-cited]")].map((c) => c.textContent)).toEqual(["T-1: hold", "P-0003: promote"]);
  });

  it("no status part when no cited ID has a recorded verdict", async () => {
    s.current = view({ entries: proposalEntry() });
    s.detail = { ...TWO_INCIDENTS, cited: {} };
    await openDialog("Promote");
    expect(dialog().querySelector('[data-detail-part="status"]')).toBeNull();
    expect(dialog().querySelector('[data-detail-part="examples"]')).not.toBeNull();
  });

  it("the Promote dialog of a proposal linked to two incidents shows both quotes and dates, newest first, above the inputs", async () => {
    s.current = view({ entries: proposalEntry() });
    s.detail = TWO_INCIDENTS;
    await openDialog("Promote");
    const items = [...dialog().querySelectorAll<HTMLElement>("[data-evidence]")];
    expect(items.map((i) => i.dataset.evidence)).toEqual(["T-20261104-b2", "L-0042"]);
    expect(items.map((i) => i.querySelector("[data-evidence-date]")!.textContent)).toEqual(["2026-11-04", "2026-11-01"]);
    // One line each: the owner's quote wins over the agent's proposal and the root reason.
    expect(items.map((i) => i.querySelector("[data-example-text]")!.textContent)).toEqual(["stop at 3am", "too loud"]);
    expect(items[0]!.textContent).not.toContain("notify every hour");
    expect(dialog().querySelector("[data-detail-description]")!.textContent).toBe("Quiet evolve's notices at night.");
    const all = dialog().innerHTML;
    expect(all.indexOf("data-evidence")).toBeLessThan(all.indexOf("<textarea"));
    expect(dialog().querySelector("[data-rule-detail]")!.textContent).not.toContain("not given");
  });

  it("the Disclosure of long fields shows a proposal's current and proposed lines only when the ledger carries them", async () => {
    s.current = view({ entries: proposalEntry() });
    s.detail = { ...TWO_INCIDENTS, detail: { ...TWO_INCIDENTS.detail!, current: "notify always", proposed: "notify 08:00-22:00" } };
    await openDialog("Promote");
    expect(dialog().querySelector('[data-change="current"]')!.textContent).toBe("notify always");
    expect(dialog().querySelector('[data-change="proposed"]')!.textContent).toBe("notify 08:00-22:00");
    cleanup();
    s.detail = TWO_INCIDENTS;
    await openDialog("Promote");
    expect(dialog().querySelector("[data-change]")).toBeNull();
    expect(dialog().querySelector("[data-detail-long]")).toBeNull();
  });

  it("Related lists the applied rules that share an incident ID or name the target file, and is left out when none match", async () => {
    s.current = view({
      entries: proposalEntry(),
      applied: {
        rules: [
          { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: null, incidents: ["L-0042"], judged: null, raw: null },
          { id: "C-002", name: "quiet hours", default: "Keep bin/evolve quiet at night.", exceptions: null, scope: null, incidents: ["T-9"], judged: null, raw: null },
          { id: "C-003", name: "flags", default: "Keep every flag.", exceptions: null, scope: "CLI", incidents: ["T-1"], judged: null, raw: null },
        ],
        elsewhere: [],
      },
    });
    s.detail = TWO_INCIDENTS;
    await openDialog("Promote");
    expect([...dialog().querySelectorAll<HTMLElement>("[data-related]")].map((r) => r.dataset.related)).toEqual(["C-001", "C-002"]);
    cleanup();
    s.current = view({ entries: proposalEntry(), applied: { rules: [APPLIED!.rules[1]!], elsewhere: [] } });
    await openDialog("Promote");
    expect(dialog().querySelector('[data-detail-part="related"]')).toBeNull();
  });

  it("a long Korean title stays in the heading and long Korean quotes wrap in the dialog instead of overflowing it", async () => {
    const title = "프로모트할 때 근거와 맥락을 보여주어 소유자가 무엇을 근거로 한 제안인지 판단할 수 있게 한다".repeat(3);
    const said = "새벽 세 시에 알림이 계속 와서 잠을 못 잤으니 야간에는 알림을 보내지 않도록 바꿔 달라고 여러 번 말했다".repeat(4);
    s.current = view({ entries: proposalEntry(title) });
    s.detail = { ...TWO_INCIDENTS, detail: { ...TWO_INCIDENTS.detail!, evidence: TWO_INCIDENTS.detail!.evidence!.map((e) => ({ ...e, quote: said })) } };
    await openDialog("Promote");
    // The title is the heading's (the dialog's own wrapping); every example's line breaks inside the dialog's width.
    expect(within(dialog()).getByRole("heading", { level: 2 }).textContent).toBe(`Promote: ${title}`);
    for (const el of dialog().querySelectorAll<HTMLElement>("[data-example-text]")) {
      expect(el.className).toContain("break-words");
      expect(el.className).not.toMatch(/\b(truncate|whitespace-nowrap)\b/);
    }
    expect(dialog().querySelectorAll("[data-example-text]")).toHaveLength(2);
    expect(dialog().querySelector("[data-rule-detail]")!.className).toContain("min-w-0");
  });

  it("kinds read as plain sentences with the file name, several files as the first and \"and N more\", in the row and in the detail; the full target stays in Why and where", async () => {
    s.current = view({
      entries: [
        { id: "P-1", title: "Many files", state: "open", kind: "edit-asset", target: "prompts/a.md, prompts/b.md, bin/evolve, docs/c.md", judged: null, draft: null, draft_error: null },
        { id: "P-2", title: "Learning", state: "open", kind: "promote-learning", target: "skills/git/learnings.md", judged: null, draft: null, draft_error: null },
        { id: "P-3", title: "New", state: "open", kind: "new-asset", target: "skills/new/SKILL.md", judged: null, draft: null, draft_error: null },
        { id: "P-4", title: "Other", state: "open", kind: "rename-thing", target: "x.md", judged: null, draft: null, draft_error: null },
      ],
    });
    s.detail = (id) => ({ id, error: null, detail: { id } });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const what = (id: string) => card(id).querySelector("[data-rule-gist]")!.textContent;
    expect(["P-1", "P-2", "P-3", "P-4"].map(what)).toEqual([
      "Changes a.md and 3 more", "Turns a learning into a rule in learnings.md", "Adds SKILL.md", "Changes x.md",
    ]);
    for (const raw of ["edit-asset", "promote-learning", "new-asset", "rename-thing"]) expect(document.body.textContent).not.toContain(raw);
    fireEvent.click(within(card("P-1")).getByText("Why and where").closest("summary")!);
    const part = await waitFor(() => {
      const el = card("P-1").querySelector<HTMLElement>('[data-detail-part="what"]');
      if (!el) throw new Error("the detail is not open yet");
      return el;
    }, SLOW);
    expect(part.textContent).toContain("Changes a.md and 3 more");
    expect(part.textContent).toContain("Path: prompts/a.md, prompts/b.md, bin/evolve, docs/c.md");
    expect(part.textContent).not.toContain("edit-asset");
  });
});

// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applied, APPLIED, card, json, openDetails, PUSHBACKS, reset, s, section, show, SLOW, teardown, view } from "./ui-rules-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// The Rules page In effect tests: applied rows, the seen line, Suggest, Pushbacks and Retired. The shared stub is in tests/ui-rules-fixtures.ts.

describe("Rules page", () => {
  it("In effect lists each applied rule's sentence; its parts, \"not given\" for a missing one, and an unreadable block's raw text sit behind Details; the elsewhere lines follow", async () => {
    s.current = view({
      applied: {
        rules: [
          { id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: "모든 문서", incidents: ["T-20261017-de7e", "T-20261019-5000"], judged: "2026-11-13", raw: null },
          { id: null, name: null, default: null, exceptions: null, scope: null, incidents: null, judged: null, raw: "## Notes\njust words" },
        ],
        elsewhere: ["- C-009 → CLAUDE.md"],
      },
    });
    await show();
    const applied = await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(applied.closest("section")!.getAttribute("aria-label")).toBe("In effect");
    const row = applied.querySelector<HTMLElement>('[data-applied="C-001"]')!;
    const c = row.textContent!;
    expect(c).not.toContain("C-001");
    // The row's sentence is the rule's name; its date and parts are behind Details, not on the row.
    expect(row.querySelector("p")!.textContent).toBe("summary first");
    // The row is two lines: the name, then one muted line "<scope> · Seen N times (date)"; the Details stay collapsed under it.
    expect(row.querySelector("[data-rule-meta]")!.textContent).toBe("모든 문서 · Seen 2 times (Oct 19)");
    expect(row.querySelector("details")!.getAttribute("open")).toBeNull();
    // No blank switch column: the row's text starts at its left edge (2026-11-27).
    expect(row.querySelector("[data-row-leading]")).toBeNull();
    for (const part of ["summary first", "모든 문서", "2026-11-13", "Open with a summary.", "not given"]) expect(c).toContain(part);
    // Details are a label/value list; the incident IDs are not one of its parts (they sit in the seen line's tooltip).
    expect([...applied.querySelectorAll('[data-applied="C-001"] dt')].map((d) => d.textContent)).toEqual(["Default", "Exception", "Judged"]);
    expect(c).not.toContain("T-2026");
    // An unreadable block says so; its raw text is behind Details.
    const raw = applied.querySelector<HTMLElement>("[data-applied-raw]")!;
    expect(raw.matches("[data-list-row]")).toBe(true);
    expect(raw.querySelector("p")!.textContent).toBe("A rule this page could not read");
    expect(raw.querySelector("details pre, details [data-value-block], details")!.textContent).toContain("## Notes\njust words");
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("Encoded elsewhere");
    // The elsewhere lines go through Markdown: a list item, no raw "- ".
    expect(document.querySelector("[data-elsewhere]")!.textContent).toContain("C-009 → CLAUDE.md");
    expect(document.querySelector("[data-elsewhere] li")!.textContent).toBe("C-009 → CLAUDE.md");
    // The raw block has no action; the class has one ⋯ menu (Retire is in it) and no visible Retire button or edit.
    expect(screen.getAllByRole("button", { name: /^Actions:/ })).toHaveLength(1);
    expect(screen.queryAllByRole("button", { name: "Retire" })).toEqual([]);
    expect(screen.queryAllByRole("button", { name: /edit/i })).toEqual([]);
  });

  // wi_d4201038's last criterion: an applied rule says how often it was seen and when last; its incident IDs only in a tooltip.
  const seenRow = async (incidents: string[] | null) => {
    s.current = view({ applied: { rules: [{ id: "C-001", name: "summary first", default: "Open with a summary.", exceptions: null, scope: null, incidents, judged: null, raw: null }], elsewhere: [] } });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    return document.querySelector<HTMLElement>('[data-applied="C-001"]')!;
  };

  it("an applied rule with one incident T-20261017 shows \"Seen 1 time (Oct 17)\"; the ID is only in its tooltip", async () => {
    const row = await seenRow(["T-20261017"]);
    const seen = row.querySelector<HTMLElement>("[data-seen]")!;
    expect(seen.textContent).toBe("Seen 1 time (Oct 17)");
    expect(row.textContent).not.toContain("T-20261017");
    fireEvent.mouseEnter(seen.querySelector("button")!.parentElement!);
    expect(within(row).getByRole("tooltip").textContent).toBe("T-20261017");
  });

  it("the seen line counts each incident and dates the latest day, not the first or the last listed; the tooltip lists the IDs", async () => {
    const row = await seenRow(["T-20261017-de7e", "T-20261107-aa11", "T-20261019-5000"]);
    const seen = row.querySelector<HTMLElement>("[data-seen]")!;
    expect(seen.textContent).toBe("Seen 3 times (Nov 7)");
    expect(row.textContent).not.toMatch(/T-2026/);
    fireEvent.mouseEnter(seen.querySelector("button")!.parentElement!);
    expect(within(row).getByRole("tooltip").textContent).toBe("T-20261017-de7e, T-20261107-aa11, T-20261019-5000");
  });

  it("an incident listed twice counts once, in the line and in the tooltip", async () => {
    const seen = (await seenRow(["T-20261107-aa11", "T-20261017-de7e", "T-20261107-aa11"])).querySelector<HTMLElement>("[data-seen]")!;
    expect(seen.textContent).toBe("Seen 2 times (Nov 7)");
    fireEvent.mouseEnter(seen.querySelector("button")!.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toBe("T-20261107-aa11, T-20261017-de7e");
  });

  it("an applied rule with no incidents shows no seen line; IDs with no day read \"Seen N times\" with no date", async () => {
    expect((await seenRow(null)).querySelector("[data-seen]")).toBeNull();
    cleanup();
    expect((await seenRow([])).querySelector("[data-seen]")).toBeNull();
    cleanup();
    expect((await seenRow(["T-1", "T-2"])).querySelector("[data-seen]")!.textContent).toBe("Seen 2 times");
  });

  it("Suggest reads each applied class's suggestions on demand; a suggested rule shows the badge with its reasons, the others none", async () => {
    s.current = view({ applied: APPLIED });
    s.detail = (id) => ({ id, error: null, detail: null, retire: id === "C-001" ? ["no new incident for 44 days since judged on 2026-10-01", "covered by C-002"] : [] });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    // Nothing is suggested, and no entry read, before the press.
    expect(s.gets.filter((u) => u.includes("/rules/entry"))).toEqual([]);
    expect(screen.queryByText("Suggested to retire")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    expect((await within(applied("C-001")).findByText("Suggested to retire", {}, SLOW)).textContent).toBe("Suggested to retire");
    expect([...applied("C-001").querySelectorAll("[data-suggested] li")].map((li) => li.textContent)).toEqual([
      "no new incident for 44 days since judged on 2026-10-01", "covered by C-002",
    ]);
    await waitFor(() => expect(s.gets.filter((u) => u.includes("/rules/entry")).sort()).toEqual(["/api/v1/rules/entry?id=C-001", "/api/v1/rules/entry?id=C-002"]));
    expect(within(applied("C-002")).queryByText("Suggested to retire")).toBeNull();
    // A suggestion writes nothing.
    expect(s.posts).toEqual([]);
    // The next press reads again.
    fireEvent.click(screen.getByRole("button", { name: "Suggest" }));
    await waitFor(() => expect(s.gets.filter((u) => u.includes("/rules/entry"))).toHaveLength(4));
  });

  it("each applied class's ⋯ menu holds Edit, Open evidence and Retire in that order; a raw block has no menu", async () => {
    s.current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(screen.getAllByRole("button", { name: /^Actions:/ })).toHaveLength(2);
    expect(document.querySelector("[data-applied-raw] [data-row-menu]")).toBeNull();
    fireEvent.click(within(applied("C-001")).getByRole("button", { name: "Actions: summary first" }));
    const items = within(applied("C-001")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Edit", "Open evidence", "Copy ID", "Retire"]);
    expect(items.map((i) => i.className.includes("text-pill-bad-fg"))).toEqual([false, false, false, true]);
  });

  it("In effect titles wrap whole, never cut to one line: an applied rule's name and a standing rule's sentence (390px cut them mid-word)", async () => {
    s.current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    const title = applied("C-001").querySelector<HTMLElement>("[data-applied-title]")!;
    expect(title.textContent).toBe("summary first");
    // Plain text, not a one-line ID button: the old title was an IdDetails in a `truncate` line.
    expect(title.querySelector("button")).toBeNull();
    expect(title.className).not.toMatch(/\btruncate\b/);
    expect(title.className).toContain("wrap-anywhere");
  });

  it("a rule with two default lines shows each on its own line in its Details", async () => {
    s.current = view({ applied: { rules: [{ ...APPLIED!.rules[0]!, default: "Open with a summary.\nKeep it to one line." }], elsewhere: [] } });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    const lines = applied("C-001").querySelectorAll("[data-lines] > [data-markdown]");
    expect([...lines].map((l) => l.textContent)).toEqual(["Open with a summary.", "Keep it to one line."]);
  });

  it("Pushbacks sits under the page's Details with its count: each row the owner's words and date, no ID, and one secondary sm Dismiss", async () => {
    s.current = view({ applied: APPLIED, pushbacks: PUSHBACKS });
    await show();
    const details = await openDetails();
    const list = await within(details).findByRole("list", { name: "Pushbacks" }, SLOW);
    expect(list.closest("details[data-page-details]")).toBe(details);
    expect(screen.getByRole("region", { name: "Pushbacks" }).textContent).toContain("2");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("[data-pushback-words]")!.textContent)).toEqual(["keep the --json flag", "요약 먼저"]);
    expect(rows[0]!.querySelector("[data-details]")!.textContent).toBe("2026-11-20");
    expect(rows[1]!.querySelector("[data-details]")).toBeNull();
    for (const r of rows) {
      expect(r.textContent).not.toMatch(/\b[PT]-\d/);
      const buttons = within(r).getAllByRole("button");
      expect(buttons.map((b) => b.textContent)).toEqual(["Dismiss"]);
      expect(buttons[0]!.className).toContain("min-h-7");
      expect(buttons[0]!.className).toContain("border-border-strong");
    }
  });

  it("no Pushbacks card with the ledger giving none; an unreadable list is a Notice and the rest of the page loads", async () => {
    s.current = view({ applied: APPLIED });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    expect(screen.queryByRole("region", { name: "Pushbacks" })).toBeNull();
    cleanup();
    s.current = view({ applied: APPLIED, pushbacks: { rows: [], error: "The pushbacks could not be read: boom" } });
    await show();
    await openDetails();
    const card = await screen.findByRole("region", { name: "Pushbacks" }, SLOW);
    expect(card.textContent).toContain("The pushbacks could not be read.");
    expect(screen.getByRole("list", { name: "In effect" })).toBeTruthy();
  });

  it("Retired sits under the page's Details: each rule's reason and date; a line when the ledger has none", async () => {
    s.current = view({ applied: APPLIED, retired: [{ id: "C-007", reason: "covered by C-001", date: "2026-11-14" }] });
    await show();
    const details = await openDetails();
    const list = within(details).getByRole("list", { name: "Retired" });
    expect(list.querySelector('[data-retired-rule="C-007"]')!.textContent).toBe("Retired ruleRetired 2026-11-14: covered by C-001");
    expect(list.querySelector('[data-retired-rule="C-007"]')!.matches("[data-list-row]")).toBe(true);
    expect(screen.queryByRole("region", { name: "Retired" })).toBeNull();
    cleanup();
    s.current = view({ applied: APPLIED, retired: [] });
    await show();
    expect(within(await openDetails()).getByText("No rule has been retired.")).not.toBeNull();
  });
});

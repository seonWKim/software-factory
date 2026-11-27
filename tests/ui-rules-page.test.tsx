// @vitest-environment jsdom
/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RulesView } from "../web/src/api.js";
import { applied, APPLIED, AT, card, h1s, off, openDetails, reset, s, section, show, SLOW, teardown, TOKEN, view, whyToggle } from "./ui-rules-fixtures.js";

beforeEach(reset);
afterEach(teardown);

// The Rules page (issue #571): the pending entries in two groups, rule candidates (C-) and structure proposals (P-),
// each under its line on what promoting one does; each card with its title, state, ID and one line of what it would
// change, and its detail in one reading order shared with the verdict dialog (what to promote, why, examples, status
// of what it cites, where, related; an empty part left out; the long fields in a Disclosure) read from GET
// /api/v1/rules/entry only when the card opens. Promote, Hold and Reject ask for a
// reason in a dialog before they send; Promote of a class (C-) sends the owner's wording, default and exception (the
// last two prefilled from its draft), Promote of a proposal (P-) shows its Now and Proposed lines (or its prose change,
// recorded as applied to its target, and a task created to build it, which the card then links to) and sends only the
// reason; with no target it is off, with its reason on the row. A judged entry shows its decision and no
// verdict buttons; a class whose draft could not be read offers no Promote. With the ledger off (design 08-settings): a
// picker over the known agents homes shows the chosen one's check, and one primary Turn on, when the home in use is
// found, writes the `integrations` entry through POST /api/v1/settings and loads the rules with no reload.
// The Rules page tests that cover the page itself: header and intro, the two sections, the waiting rows and groups, judged entries, empty states and search. The other topics are in tests/ui-rules-*.test.tsx; the shared stub is in tests/ui-rules-fixtures.ts.

describe("Rules page", () => {
  it("Waiting for you groups candidates then proposals, their lines behind How promoting works; each row shows its whole title (ID in ⋯ Copy ID), a pill only when held, and its gist", async () => {
    await show();
    const waiting = await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    const classes = within(waiting).getByRole("list", { name: "Rule candidates" });
    const proposals = within(waiting).getByRole("list", { name: "Structure proposals" });
    expect(within(classes).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["C-012"]);
    expect(within(proposals).getAllByRole("listitem").map((li) => li.dataset.rule)).toEqual(["P-0007"]);
    // The groups' lines on what promoting does sit in one closed disclosure at the end of the card, candidates first.
    const how = waiting.querySelector<HTMLDetailsElement>("details[data-how-promoting]")!;
    expect(how.open).toBe(false);
    expect(how.querySelector("summary")!.textContent).toBe("How promoting works");
    expect([...how.querySelectorAll("[data-group-line]")].map((l) => l.textContent)).toEqual([
      "Promoting a candidate adds its rule to every run's prompt from the next run on.",
      "Promoting a proposal shows its before and after, then applies it to the target file once you confirm; one with no lines to apply gets a task to build it.",
    ]);
    // One count: the header's "N waiting"; the card and its groups print none beside their titles.
    expect(waiting.querySelectorAll("h2 + span, h3 + span")).toHaveLength(0);
    expect(card("C-012").querySelector("[data-rule-title]")!.textContent).toBe("Keep existing CLI flags.");
    // A pending candidate waits, which its section says: no pill.
    expect(card("C-012").querySelector("[data-status]")).toBeNull();
    // The ID is not printed; Copy ID is the last item of the row's ⋯ menu.
    expect(card("C-012").textContent).not.toContain("C-012");
    fireEvent.click(within(card("C-012")).getByRole("button", { name: /^Decide:/ }));
    expect(within(card("C-012")).getAllByRole("menuitem").at(-1)!.textContent).toBe("Copy ID");
    // The title is the whole text, wrapped: never cut to one line beside Promote and ⋯ (a phone read a dozen characters).
    expect(card("C-012").querySelector("[data-rule-title]")!.className).not.toMatch(/\btruncate\b/);
    // A candidate's gist is its draft rule, when it says more than the title; one that repeats the title gets none.
    expect(card("C-012").querySelector("[data-rule-gist]")!.textContent).toBe("Rule: Keep every flag.");
    expect(card("C-012").matches("[data-list-row]")).toBe(true);
    // A held proposal says Held; its change line names its file in plain words.
    expect(card("P-0007").querySelector("[data-status='held']")!.textContent).toBe("Held");
    expect(card("P-0007").querySelector("[data-rule-title]")!.textContent).toBe("Split the review prompt");
    expect(card("P-0007").querySelector("[data-rule-gist]")!.textContent).toBe("Changes review.md");
    // No detail is read on page load.
    expect(s.gets.filter((u) => u.includes("/rules/entry"))).toEqual([]);
    expect(document.querySelector("[data-rule-detail]")).toBeNull();
  });

  it("an open proposal waiting for a verdict shows no Running pill, and its gist line names its file and what it adds", async () => {
    s.current = view({
      entries: [{ id: "P-0010", title: "리뷰 결과에 폭을 적는다", state: "open", kind: "promote-learning", target: "agent-skills/review/SKILL.md", gist: "깨진 규칙마다 페이지와 화면 폭을 함께 적는다.", judged: null, draft: null, draft_error: null }],
    });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    // Nothing runs until the owner decides: the old state table mapped `open` to "Running".
    expect(card("P-0010").textContent).not.toContain("Running");
    expect(card("P-0010").querySelector("[data-status]")).toBeNull();
    const gist = card("P-0010").querySelector<HTMLElement>("[data-rule-gist]")!;
    expect(gist.textContent).toBe("Turns a learning into a rule in SKILL.md: 깨진 규칙마다 페이지와 화면 폭을 함께 적는다.");
    // The full path is in its tooltip.
    expect(gist.title).toContain("agent-skills/review/SKILL.md");
  });

  it("a judged entry shows its decision and no verdict buttons; a class with no draft offers no Promote", async () => {
    s.current = view({
      entries: [
        { id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: "promote", draft: null, draft_error: null },
        { id: "C-013", title: "Summary first.", state: "pending", judged: null, draft: null, draft_error: "evolve show exited 1: no class" },
      ],
    });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(card("C-012").querySelector("[data-judged]")!.textContent).toBe("Judged: promote");
    expect(card("C-012").querySelector("[data-status]")).toBeNull();
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["⋯"]);
    expect(whyToggle("C-012")).not.toBeNull();
    expect(card("C-013").querySelector("[data-draft-error]")!.textContent).toContain("evolve show exited 1");
    expect(within(card("C-012")).queryByRole("button", { name: /^Decide:/ })).toBeNull();
    fireEvent.click(within(card("C-013")).getByRole("button", { name: /^Decide:/ }));
    expect((within(card("C-013")).getByRole("button", { name: "Promote" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(card("C-013")).getByRole("menuitem", { name: "Hold" }) as HTMLButtonElement).disabled).toBe(false);
  });

  const judgedEntries = (): RulesView["entries"] => [
    { id: "C-012", title: "Keep existing CLI flags.", state: "pending", judged: "promote", draft: null, draft_error: null },
    { id: "P-0007", title: "Split the review prompt", state: "held", judged: "reject", draft: null, draft_error: null },
  ];

  it("with every entry judged: 0 waiting, an empty state with its next step, and one \"N decided\" line", async () => {
    s.current = view({ entries: judgedEntries() });
    await show();
    await screen.findByText("Nothing waits for a verdict", {}, SLOW);
    expect(document.querySelector("[data-waiting]")!.textContent).toBe("0 waiting");
    expect(section("Waiting for you").querySelector("li[data-rule]")).toBeNull();
    // The decided entries sit under the page's Details, under an "N decided" heading.
    const details = await openDetails();
    expect(details.querySelector("[data-decided] h3")!.textContent).toBe("2 decided");
    expect(within(details).getByRole("list", { name: "Decided" }).contains(card("P-0007"))).toBe(true);
    expect(card("P-0007").textContent).toContain("Judged: reject");
  });

  it("the waiting count and the section count exclude judged entries; one PageHeader names the page; How this works is under Details", async () => {
    s.current = view({ entries: [...judgedEntries(), ...view().entries] });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(document.querySelector("[data-waiting]")!.textContent).toBe("2 waiting");
    expect(section("Waiting for you").querySelectorAll("li[data-rule]")).toHaveLength(2);
    expect(h1s()).toEqual(["Rules"]);
    const details = document.querySelector<HTMLDetailsElement>("details[data-page-details]")!;
    expect(details.open).toBe(false);
    expect(details.querySelector("[data-how] h3")!.textContent).toBe("How this works");
  });

  it("two sections, Waiting for you then In effect, and one Details at the end; no tabs; every row in both is a ListRow", async () => {
    const report = { window_start: AT, window_end: AT, created_at: AT, runs: 0, patterns: 0, groups: [] };
    s.current = view({ applied: APPLIED, improve: { report, run_now: false, csrf_token: null } });
    s.standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: true, set_by: "github:1", created_at: AT, updated_at: AT, last_fired_at: null, recent: [] }],
      proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: AT }],
    };
    await show();
    await waitFor(() => expect(document.querySelector('[data-proposal="sp_1"]')).not.toBeNull(), SLOW);
    // Exactly two regions, in this order; no tablist.
    expect(screen.getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Waiting for you", "In effect"]);
    // Suggest sits in the In effect card's title line, not on a line of its own under it.
    const suggest = within(section("In effect")).getByRole("button", { name: "Suggest" });
    expect(suggest.closest("section")!.querySelector("h2")!.parentElement!.contains(suggest)).toBe(true);
    expect(screen.queryByRole("tablist")).toBeNull();
    // In effect: the standing rule that is on, then the applied rules.
    const effect = within(section("In effect")).getByRole("list", { name: "In effect" });
    const rows = [...effect.querySelectorAll<HTMLElement>(":scope > li")];
    expect(rows.map((r) => r.dataset.rule ?? r.dataset.applied ?? "raw")).toEqual(["spec-t1", "C-001", "C-002", "raw"]);
    expect(rows.every((r) => r.matches("[data-list-row]"))).toBe(true);
    expect(within(section("In effect")).getByText("Approves risk level 1 plans for you")).not.toBeNull();
    // Waiting for you: the standing proposal, then candidates, then structure proposals, each group a list of its own.
    const waiting = section("Waiting for you");
    expect([...waiting.querySelectorAll("ul")].map((u) => u.getAttribute("aria-label"))).toEqual(["Turn on auto-approve", "Rule candidates", "Structure proposals"]);
    const wrows = [...waiting.querySelectorAll<HTMLElement>("ul > li")];
    expect(wrows.map((r) => r.dataset.proposal ?? r.dataset.rule)).toEqual(["sp_1", "C-012", "P-0007"]);
    expect(wrows.every((r) => r.matches("[data-list-row]"))).toBe(true);
    // The waiting count is a Badge beside the title, counting the standing proposal too.
    const badge = document.querySelector<HTMLElement>("[data-waiting]")!;
    expect(badge.querySelector("[data-level]")!.textContent).toBe("3 waiting");
    expect(badge.parentElement!.querySelector("h1")!.textContent).toBe("Rules");
    // One Details disclosure, the page's last element, holding the improve link, Retired and How this works.
    const all = document.querySelectorAll("details[data-page-details]");
    expect(all).toHaveLength(1);
    const details = all[0]!;
    expect(details.querySelector("summary")!.textContent).toBe("Details");
    expect(details.parentElement!.lastElementChild).toBe(details);
    const link = details.querySelector<HTMLAnchorElement>("[data-improve-link] a")!;
    expect([link.textContent, link.getAttribute("href")]).toEqual(["See the improve report on the Health page", "/app/health?tab=improve"]);
    for (const part of ["[data-retired-part]", "[data-how]"]) expect(details.querySelector(part)).not.toBeNull();
    // No improve report on the page itself.
    expect(screen.queryByText("Improve report")).toBeNull();
  });

  it("Details has no improve report link when the improve view carries no report, or none at all", async () => {
    s.current = view({ applied: APPLIED, improve: { report: null, run_now: true, csrf_token: TOKEN } });
    await show();
    const details = await openDetails();
    expect(details.querySelector("[data-how]")).not.toBeNull();
    expect(details.querySelector("[data-improve-link]")).toBeNull();
    expect(within(details).queryByRole("link", { name: "See the improve report on the Health page" })).toBeNull();
    cleanup();
    s.current = view({ applied: APPLIED });
    await show();
    expect((await openDetails()).querySelector("[data-improve-link]")).toBeNull();
  });

  it("a standing rule that is off sits under Details, with its switch; In effect says so when nothing is on", async () => {
    s.standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: false, set_by: null, created_at: null, updated_at: null, last_fired_at: null, recent: [] }],
      proposals: [],
    };
    await show();
    const details = await openDetails();
    await waitFor(() => expect(details.querySelector('[data-standing-off] [data-rule="spec-t1"]')).not.toBeNull(), SLOW);
    expect(within(details).getByRole("switch", { name: "Approves risk level 1 plans for you" })).not.toBeNull();
    expect(section("In effect").querySelector('[data-rule="spec-t1"]')).toBeNull();
    expect(section("In effect").querySelector("[data-in-effect-empty]")!.textContent).toBe("No rule is in effect yet.");
  });

  it("the search filters Applied rows case-insensitively over ID, name, default and scope; evidence is counted once per incident", async () => {
    s.current = view({
      entries: [],
      applied: {
        rules: [
          { id: "C-001", name: "Summary first", default: "Open with a summary.", exceptions: null, scope: "docs", incidents: ["T-1", "T-1", "T-2"], judged: "2026-10-01", raw: null },
          { id: "C-002", name: "flags", default: "Keep every flag.", exceptions: null, scope: "CLI", incidents: ["T-2"], judged: "2026-11-13", raw: null },
        ],
        elsewhere: [],
      },
    });
    await show();
    await screen.findByRole("list", { name: "In effect" }, SLOW);
    const ids = () => [...document.querySelectorAll<HTMLElement>("[data-applied]")].map((e) => e.dataset.applied);
    expect(ids()).toEqual(["C-001", "C-002"]);
    expect(applied("C-001").querySelector("[data-seen]")!.textContent).toBe("Seen 2 times");
    const search = screen.getByRole("searchbox", { name: /search/i });
    // The search is a page filter: in the PageToolbar under the title, not inside the In effect card.
    expect(search.closest("[data-page-toolbar]")).not.toBeNull();
    expect(search.closest("section")).toBeNull();
    for (const [term, want] of [["SUMMARY", ["C-001"]], ["c-002", ["C-002"]], ["keep every", ["C-002"]], ["cli", ["C-002"]], ["", ["C-001", "C-002"]], ["zzz", []]] as const) {
      fireEvent.change(search, { target: { value: term } });
      expect(ids()).toEqual(want);
    }
    expect(screen.getByText("No applied rule matches.")).not.toBeNull();
  });

  it("Promote is the row's visible action, in its trailing slot beside the ⋯ menu, which lists Hold then Reject in the danger tone; a disabled Promote says why in the row", async () => {
    s.current = view({ entries: [{ id: "C-013", title: "Summary first.", state: "pending", judged: null, draft: null, draft_error: "x" }, ...view().entries] });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(within(card("C-012")).getAllByRole("button").map((b) => b.textContent)).toEqual(["Promote", "⋯"]);
    // Promote is a secondary button, not the view's primary action.
    expect(within(card("C-012")).getByRole("button", { name: "Promote" }).className).not.toContain("bg-accent");
    // Promote and ⋯ are the row's trailing slots, after the title's column, not a ButtonRow under it (2026-11-27; below
    // `sm` CSS moves Promote to a line of its own).
    const trailing = [...card("C-012").children].slice(1).map((c) => [c.getAttribute("data-row-action") !== null ? "action" : c.getAttribute("data-row-menu") !== null ? "menu" : "?", c.textContent]);
    expect(trailing).toEqual([["action", "Promote"], ["menu", "⋯"]]);
    fireEvent.click(within(card("C-012")).getByRole("button", { name: /^Decide:/ }));
    const items = within(card("C-012")).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Hold", "Reject", "Copy ID"]);
    expect(items[1]!.className).toContain("text-pill-bad-fg");
    expect((within(card("C-013")).getByRole("button", { name: "Promote" }) as HTMLButtonElement).disabled).toBe(true);
    expect(card("C-013").querySelector("[data-draft-error]")!.textContent).toContain("Promote is off");
  });

  it("each waiting row's ⋯ menu sits at the right end of its title line, not on a line of its own", async () => {
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    for (const id of ["C-012", "P-0007"]) {
      const menu = card(id).querySelector<HTMLElement>("[data-row-menu]")!;
      // The menu is the row's last child, after Promote and the column that holds the title, in the same flex row.
      expect(menu.parentElement).toBe(card(id));
      expect(menu.previousElementSibling!.hasAttribute("data-row-action")).toBe(true);
      expect(menu.previousElementSibling!.previousElementSibling!.querySelector("[data-rule-title]")).not.toBeNull();
      expect(card(id).className).toContain("flex");
      expect(within(menu).getByRole("button", { name: /^Decide:/ })).toBeTruthy();
    }
  });

  it("no rules string names a tool, the ledger or a CLI path", async () => {
    const { rules } = await import("../web/src/i18n/en/rules.js");
    const { standing } = await import("../web/src/i18n/en/standing.js");
    for (const [key, text] of Object.entries({ ...rules, ...standing })) expect([key, text]).not.toEqual([key, expect.stringMatching(/evolve|tacit|sync-agents|ledger|bin\//i)]);
  });

  it("the intro says what the page is for in plain words, and no raw rule ID, provider ID, ISO time or kind shows outside Details", async () => {
    s.current = view({ entries: [...view().entries, { id: "P-0009", title: "Quiet notify", state: "open", kind: "edit-asset", target: "bin/evolve", judged: null, draft: null, draft_error: null }] });
    s.standing = {
      as_of: AT, csrf_token: TOKEN,
      rules: [{ rule: "spec-t1", gate: "spec", tier: 1, threshold: 3, enabled: true, set_by: "github:123", created_at: "2026-11-19T12:41:45.603Z", updated_at: AT, last_fired_at: null, recent: [] }],
      proposals: [{ id: "sp_1", rule: "spec-t1", run_length: 3, threshold: 3, created_at: "2026-11-19T12:41:45.603Z" }],
    };
    await show();
    await waitFor(() => expect(document.querySelector('[data-proposal="sp_1"]')).not.toBeNull(), SLOW);
    expect(document.querySelector("header p")!.textContent).toBe("When you correct the agents, the factory suggests rules. Approve, hold, or reject them here.");
    const copy = document.body.cloneNode(true) as HTMLElement;
    // Outside every Details disclosure (closed or not) and the tooltips.
    copy.querySelectorAll("details, [data-raw], [role=tooltip]").forEach((n) => n.remove());
    const text = copy.textContent!;
    for (const raw of ["spec-t1", "github:", "2026-11-19T", "edit-asset"]) expect(text).not.toContain(raw);
    expect(text).toContain("Approves risk level 1 plans for you");
    const how = document.querySelector<HTMLElement>("[data-how]")!.textContent!;
    for (const word of [/pushback/i, /ledger/i, /agents home/i]) expect(how).not.toMatch(word);
  });

  it("In effect says nothing is in effect when the file holds nothing and no standing rule is on", async () => {
    s.current = view({ applied: { rules: [], elsewhere: [] } });
    await show();
    await screen.findByRole("region", { name: "Waiting for you" }, SLOW);
    expect(screen.queryByRole("region", { name: "Applied" })).toBeNull();
    expect(section("In effect").querySelector("[data-in-effect-empty]")!.textContent).toBe("No rule is in effect yet.");
  });
});

// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AT, base, DONE, FILES, found, installItemPageFixtures, mountItem as mount, src } from "./ui-shell-fixtures.js";

// The item page (design §9, issue #313): phases and parent, the timeline spec, links and runs, the Interactive badge, and the timeline and Runs in plain words.

installItemPageFixtures();

describe("item page: phases and parent", () => {
  it("a split parent lists its phases as links to their pages, and a phase links back to its parent", async () => {
    mount("/app/items/wi_parent");
    const phases = await screen.findByRole("list", { name: "Phases" });
    const links = within(phases).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["First phase", "/app/items/wi_p1"],
      ["o/r#13", "/app/items/wi_p2"],
    ]);
    fireEvent.click(links[0]!);
    const parent = await screen.findByTestId("parent");
    expect(parent.textContent).toContain("Phase 1");
    expect(within(parent).getByRole("link").getAttribute("href")).toBe("/app/items/wi_parent");
  });
});

describe("item page: timeline spec", () => {
  it("shows the spec collapsed behind 'spec written (show)' and renders it as markdown when opened, never escaped JSON", async () => {
    mount("/app/items/wi_parent");
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    // Short changes read as words, not JSON text, and only behind Details.
    const raw = [...timeline.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n");
    expect(raw).toContain("stage: NEW → READY");
    expect(raw).toContain("stage: – → NEW");
    const visible = timeline.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    expect(visible.textContent).not.toContain("NEW → READY");
    expect(visible.textContent).toContain("Created by the factory");
    const toggle = within(timeline).getByRole("button", { name: "spec written (show)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(timeline.textContent).not.toContain("The page prints");
    fireEvent.click(toggle);
    expect(toggle.textContent).toBe("spec written (hide)");
    const spec = timeline.querySelector<HTMLElement>("[data-spec]")!;
    for (const label of ["Problem", "Done criteria", "Files to change", "Scope"]) expect(within(spec).getAllByText(label).length).toBeGreaterThan(0);
    // The heading and the blank line render as a heading and paragraphs.
    expect(within(spec).getByRole("heading", { name: "Problem", level: 3 })).toBeTruthy();
    expect(within(spec).getByText("JSON").tagName).toBe("CODE");
    expect([...spec.querySelectorAll("li")].map((l) => l.textContent)).toEqual([...DONE, ...FILES]);
    // No escaped newline, no quote-wrapped JSON string or array, no HTML from the text.
    expect(timeline.textContent).not.toContain("\\n");
    expect(timeline.textContent).not.toContain('["');
    expect(timeline.textContent).not.toContain('"## Problem');
    expect(spec.querySelector("b")).toBeNull();
    expect(spec.textContent).toContain("<b>raw html</b>");
  });
});

describe("item page: links and runs", () => {
  it("links the spec comment and PR when the URL is http(s)", async () => {
    mount("/app/items/wi_parent");
    expect((await screen.findByRole("link", { name: "Open the posted plan" })).getAttribute("href")).toBe("https://github.com/o/r/issues/10#issuecomment-5");
    expect(screen.getByRole("link", { name: "#12" }).getAttribute("href")).toBe("https://github.com/o/r/pull/12");
  });

  it("a closed item shows one status line with what closed it and a link to the reason, no commands sentence, and only facts with a value (issue #76)", async () => {
    mount("/app/items/wi_closed");
    const line = await waitFor(() => {
      const el = document.querySelector("[data-closed-status]");
      expect(el).toBeTruthy();
      return el!;
    });
    expect(line.textContent).toMatch(/^Closed: a person rejected the plan · /);
    expect(within(line as HTMLElement).getByRole("link", { name: "Read the reason" }).getAttribute("href")).toBe("#msg-7");
    expect(document.querySelector("[data-commands-none]")).toBeNull();
    expect(screen.queryByText(/^Closed: rejected$/)).toBeNull();
    const facts = [...document.querySelectorAll("[data-item-facts] dt")].map((d) => d.textContent);
    expect(facts).toEqual(["State", "Source", "Updated"]);
    expect(document.querySelector("[data-item-facts]")!.textContent).not.toContain("–");
  });

  it("an open item shows only the facts with a value: no dash, no zero", async () => {
    mount("/app/items/wi_live");
    const facts = await waitFor(() => {
      const dts = [...document.querySelectorAll("[data-item-facts] dt")].map((d) => d.textContent);
      expect(dts.length).toBeGreaterThan(0);
      return dts;
    });
    expect(facts).toContain("State");
    expect(facts).toContain("Updated");
    const dds = [...document.querySelectorAll("[data-item-facts] dd")].map((d) => d.textContent);
    expect(dds).not.toContain("–");
    expect(dds).not.toContain("0");
    expect(document.querySelector("[data-closed-status]")).toBeNull();
  });

  it("shows any other spec comment or PR URL as plain text", async () => {
    mount("/app/items/wi_p1");
    await screen.findByTestId("parent");
    expect(screen.queryByRole("link", { name: /posted plan/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /#14/ })).toBeNull();
    expect(screen.getByText(/Open the posted plan \(\[withheld: github_token\]\)/)).toBeTruthy();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it("the Runs table shows each run as an ItemRow: its status, then its kind and attempt as the title, its ID only behind Copy ID", async () => {
    mount("/app/items/wi_parent");
    const table = await screen.findByRole("table", { name: "Runs" });
    const run = table.querySelector<HTMLElement>('tr[data-run="run_triage_1"]')!;
    const cells = [...run.querySelectorAll("td")].map((c) => c.textContent);
    expect(cells[0]).toBe("Done");
    expect(cells[1]).toBe("Triage #2");
    expect(run.dataset.itemId).toBe("wi_parent");
    expect(run.textContent).not.toMatch(/run_|wi_/);
    fireEvent.click(within(run).getByRole("button", { name: "More actions: Triage #2" }));
    expect(within(run).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Copy ID"]);
  });
});

describe("item page: Interactive task badge", () => {
  it("a running interactive run shows the badge in the header and the label as the run's kind", async () => {
    mount("/app/items/wi_live");
    const table = await screen.findByRole("table", { name: "Runs" });
    const heading = screen.getByRole("heading", { level: 1 });
    expect(within(heading.parentElement!.parentElement!).getByText("Interactive task")).toBeTruthy();
    const cell = table.querySelector<HTMLElement>('tr[data-run="run_i_1"] [data-cell-title]')!;
    expect(cell.textContent).toContain("Interactive task");
    expect(cell.textContent).not.toMatch(/\binteractive\b/);
  });

  it("a finished interactive run shows no header badge, only the kind label in the table", async () => {
    mount("/app/items/wi_done");
    const table = await screen.findByRole("table", { name: "Runs" });
    // No header badge: the run's title is the only text that names it.
    expect(screen.queryAllByText("Interactive task")).toHaveLength(0);
    expect(table.querySelector('tr[data-run="run_i_2"] [data-cell-title]')!.textContent).toBe("Interactive task #1");
  });
});

describe("item page: timeline and Runs in plain words", () => {
  const ME = "local:me";
  const entry = (version: number, reason: string, actor: { kind: string; id: string }, changes = {}) => ({ version, at: AT, actor, reason, changes, detail: null });
  const run = (id: string, kind: string, status: string, attempt: number, error = null) => ({ id, kind, status, attempt, started_at: AT, finished_at: AT, created_at: AT, tokens: 5, error });

  /** Every reason literal the controller's units write, but the two that are not timeline reasons (a redeem-code refusal, a run attempt's). */
  function controllerReasons(): string[] {
    const dir = join(import.meta.dirname, "..", "src", "controller", "units");
    const files = readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith(".unit.ts"));
    return [...new Set(files.flatMap((f) => [...readFileSync(join(dir, String(f)), "utf8").matchAll(/\breason: "([a-z_]+)"/g)].map((m) => m[1]!)))];
  }

  /** The item page with a timeline and runs, the viewer being `ME`; the page's element once its timeline shows. */
  async function serveWords(timeline: unknown[], runs: unknown[]) {
    const detail = { as_of: AT, item: base("wi_w", 40, "Words"), timeline, runs, commands: [], replies: [] };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = url.split("?")[0]!;
      const body = path === "/api/v1/items/wi_w" ? detail : path === "/api/v1/session" ? { as_of: AT, csrf_token: "t", commands_enabled: true, actor: ME, actor_source: "environment" } : path === "/api/v1/overview" ? { as_of: AT, stages: {}, needs_you: 0, running: 0, queued: 0, last_24h: { succeeded: 0, failed: 0, tokens: 0 } } : undefined;
      if (body === undefined) return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
    mount("/app/items/wi_w");
    return screen.findByRole("region", { name: "Timeline" });
  }

  /** A section's text without its Details. */
  const visible = (el: HTMLElement) => {
    const copy = el.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("[data-raw]").forEach((n) => n.remove());
    return copy.textContent ?? "";
  };

  it("has a sentence for every reason the controller writes, and shows no snake_case word outside Details", async () => {
    const { en } = await import("../web/src/i18n/en.js");
    const reasons = [...new Set([...controllerReasons().filter((r) => r !== "invalid" && r !== "lease_expired"), "intake", "interactive_takeover"])];
    expect(reasons.filter((r) => !(`timeline.${r}` in en))).toEqual([]);
    const timeline = await serveWords(reasons.map((r, i) => entry(i + 1, r, { kind: "user", id: ME })), []);
    const rows = [...timeline.querySelectorAll("li")].filter((li) => li.parentElement?.tagName === "OL");
    expect(rows).toHaveLength(reasons.length);
    for (const row of rows) expect(visible(row)).not.toMatch(/[a-z]+_[a-z_]+/);
  });

  it("reads the viewer's actions as 'You …' and another person's as 'A person …', and an unknown reason as Changed", async () => {
    const timeline = await serveWords([
      entry(1, "retry_requested", { kind: "user", id: ME }, { blocked_on: { from: '"human"', to: '"none"' } }),
      entry(2, "interactive_takeover", { kind: "user", id: ME }),
      entry(3, "intake", { kind: "user", id: ME }),
      entry(4, "retry_requested", { kind: "user", id: "github:77", name: "Dana Smith" }),
      entry(5, "brand_new_reason", { kind: "system", id: "system" }),
    ], []);
    const text = visible(timeline);
    for (const s of ["You asked for a retry", "You took over in a terminal", "Created by you", "A person asked for a retry", "Changed"]) expect(text).toContain(s);
    expect(text).not.toContain("Dana");
    expect(text).not.toContain("brand_new_reason");
    expect(text).not.toContain("blocked_on");
    const raw = [...timeline.querySelectorAll("[data-raw]")].map((d) => d.textContent).join("\n");
    expect(raw).toContain("blocked_on: human → none");
    expect(raw).toContain("brand_new_reason");
  });

  it("the Runs rows read Status / Run / Detail, fold consecutive cancelled tries, and show one error line", async () => {
    await serveWords([], [
      run("run_a", "implement", "canceled", 0),
      run("run_b", "implement", "canceled", 0),
      run("run_c", "implement", "canceled", 0),
      run("run_d", "implement", "failed", 1, { code: "schedule_to_close", detail: "run run_d passed its schedule_to_close deadline 2026-11-16T22:39:21.171Z" }),
      run("run_e", "implement", "failed", 2, { code: "some_unlisted_code", detail: "long text" }),
    ]);
    const table = await screen.findByRole("table", { name: "Runs" });
    expect(within(table).getAllByRole("columnheader").slice(0, 3).map((h) => h.textContent)).toEqual(["Status", "Run", "Detail"]);
    const rows = [...table.querySelectorAll<HTMLElement>("tr[data-run]")];
    expect(rows.map((r) => r.getAttribute("data-run"))).toEqual(["run_e", "run_d", "run_c"]);
    const folded = rows[2]!;
    expect(folded.querySelectorAll("td")[0]!.textContent).toBe("Stopped");
    expect(folded.textContent).toContain("3 tries");
    expect(folded.textContent).not.toMatch(/run_/);
    const timedOut = rows[1]!;
    expect(visible(timedOut)).toContain("Timed out before it started");
    expect(visible(timedOut)).not.toMatch(/2026-11-16|schedule_to_close/);
    expect(timedOut.querySelector("[data-raw]")?.textContent).toContain("2026-11-16T22:39:21.171Z");
    expect(rows[0]!.querySelector("[data-row-second]")!.textContent).toContain("Failed");
    expect(visible(rows[0]!)).not.toContain("some_unlisted_code");
  });

});

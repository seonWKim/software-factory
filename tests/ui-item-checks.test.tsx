// @vitest-environment jsdom
// @ts-nocheck -- tsconfig.test.json has no DOM or JSX; like the other ui tests this file typechecks under the web config.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ItemAbout } from "../web/src/views/item-about.js";

// The item page's done-when checks (design 09-dashboard-item, RFC 0024 WP3 phase 3): About lists each done-when line
// with its check in plain words and a Badge (Pass, Fail, Manual, Not run); a failed line's output tail sits behind a
// closed Disclosure; an item with no checks shows About as before.

const SPEC = { problem: "The page shows no checks.", desired_output: null, done_criteria: ["The lint passes", "The page test passes", "It reads well", "The build passes"] };
const ROWS = [
  { line: "The lint passes", check: { kind: "command", text: "npm run lint" }, result: "fail", output_tail: "src/a.ts:3 error: unused import" },
  { line: "The page test passes", check: { kind: "test", text: "tests/ui-item-checks.test.tsx" }, result: "pass", output_tail: null },
  { line: "It reads well", check: { kind: "manual", text: "wording is a judgement" }, result: "manual", output_tail: null },
  { line: "The build passes", check: { kind: "command", text: "npm run build" }, result: "not_run", output_tail: null },
];

afterEach(cleanup);

const list = () => screen.getByRole("list", { name: "Done when" });
const rows = () => within(list()).getAllByRole("listitem");

describe("item page: done-when checks", () => {
  it("lists each line in order with its result badge and its check in plain words, without opening the spec", () => {
    render(<ItemAbout item={{ request: "Show the checks", spec: SPEC, checks: ROWS }} />);
    const about = screen.getByRole("region", { name: "About" });
    expect(about.querySelector("details[data-about-spec]")!.open).toBe(false);
    expect(rows().map((li) => li.querySelector("[data-check-badge]")!.textContent)).toEqual(["Fail", "Pass", "Manual", "Not run"]);
    expect(rows().map((li) => li.querySelector("p")!.textContent)).toEqual(SPEC.done_criteria);
    expect(rows().map((li) => li.querySelectorAll("p")[1]!.textContent)).toEqual([
      "Checked by running npm run lint",
      "Checked by the tests in tests/ui-item-checks.test.tsx",
      "A person checks it: wording is a judgement",
      "Checked by running npm run build",
    ]);
    // Each result has its own colour: fail red, pass green, manual info, not run neutral (no level).
    expect(rows().map((li) => li.querySelector("[data-level]")?.getAttribute("data-level") ?? null)).toEqual(["needs_you", "ready_to_merge", "running", null]);
  });

  it("a failed line's output sits behind a closed disclosure that opens to the tail; other lines have none", () => {
    render(<ItemAbout item={{ request: null, spec: SPEC, checks: ROWS }} />);
    const [fail, ...others] = rows();
    for (const li of others) expect(li.querySelector("[data-check-output]")).toBeNull();
    const out = fail!.querySelector("details[data-check-output]")!;
    expect(out.open).toBe(false);
    expect(out.querySelector("summary")!.textContent).toBe("What the check printed");
    fireEvent.click(out.querySelector("summary")!);
    expect(out.open).toBe(true);
    expect(out.querySelector("pre")!.textContent).toBe("src/a.ts:3 error: unused import");
  });

  it("a failed line with no kept output, or a withheld one, shows no empty block", () => {
    const noTail = [{ ...ROWS[0], output_tail: null }, { ...ROWS[0], line: "Second", output_tail: "[withheld: github_token]" }];
    render(<ItemAbout item={{ request: null, spec: SPEC, checks: noTail }} />);
    for (const li of rows()) {
      expect(li.getAttribute("data-check")).toBe("fail");
      expect(li.querySelector("[data-check-output]")).toBeNull();
    }
  });

  it("the spec does not repeat the done-when list while checks show it", () => {
    render(<ItemAbout item={{ request: null, spec: SPEC, checks: ROWS }} />);
    fireEvent.click(screen.getByRole("region", { name: "About" }).querySelector("details[data-about-spec] summary")!);
    expect(screen.queryByRole("list", { name: "Done criteria" })).toBeNull();
    expect(screen.getByText("The page shows no checks.")).toBeTruthy();
  });

  it("an item with no checks shows About as before: no checks list, the spec keeps its done criteria", () => {
    render(<ItemAbout item={{ request: "Old item", spec: SPEC, checks: null }} />);
    expect(screen.queryByRole("list", { name: "Done when" })).toBeNull();
    fireEvent.click(screen.getByRole("region", { name: "About" }).querySelector("summary")!);
    expect(within(screen.getByRole("list", { name: "Done criteria" })).getAllByRole("listitem")).toHaveLength(4);
  });

  it("a withheld line or check shows the withheld note, never the marker, and no IDs show", () => {
    const leaky = [{ line: "[withheld: github_token]", check: { kind: "manual", text: "[withheld: github_token]" }, result: "manual", output_tail: null }];
    render(<ItemAbout item={{ request: null, spec: null, checks: leaky }} />);
    const about = screen.getByRole("region", { name: "About" });
    expect(about.textContent).not.toContain("[withheld");
    expect(about.textContent).toContain("Withheld: the egress scan flagged this text.");
    expect(about.textContent).not.toMatch(/wi_|run_|not_run|manual:/);
  });
});

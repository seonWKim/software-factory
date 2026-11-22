import { describe, expect, it } from "vitest";
import { statusLines } from "../src/cli/handlers/status/lines.js";

const row = (id: string, title: string, label: string, reason: string | null) =>
  ({ item: { id, title, blocked_reason: reason }, label }) as unknown as Parameters<typeof statusLines>[0][number];

describe("factory status lines", () => {
  it("prints one line per item: short id, title, state words, and the blocked reason in words", () => {
    const lines = statusLines([row("wi_c86970ff1234", "Add dark mode", "Needs you", "spec_conflict"), row("wi_0123abcd9999", "Fix login", "Running", null)]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("c86970ff  Add dark mode  Needs you: spec conflict");
    expect(lines[1]).toBe("0123abcd  Fix login  Running");
    for (const l of lines) expect(l).not.toContain("wi_");
  });

  it("says so when there is no item", () => {
    expect(statusLines([])).toEqual(["no work items"]);
  });
});

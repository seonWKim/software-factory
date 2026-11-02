import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// These tests check the instruction text only. They cannot prove a model's reply starts with the section.

const HEADING = "In short (AS-IS → TO-BE)";

function prompt(name: string): string {
  return readFileSync(join(import.meta.dirname, "..", "prompts", `${name}.md`), "utf8");
}

/** The text of the top-level bullet that starts with `- <field>:`, up to the next top-level bullet or blank line. */
function bullet(text: string, field: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`- ${field}:`));
  if (start < 0) return "";
  const out = [lines[start]!];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("- ") || l.trim() === "") break;
    out.push(l);
  }
  return out.join("\n");
}

describe("prompts/triage.md", () => {
  const text = prompt("triage");
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks for in_short as the first field, before the problem and any file-level field", () => {
    expect(text).toContain("Produce:");
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields[0]).toBe("in_short");
    expect(fields).toContain("problem");
    expect(fields).toContain("allowed_paths");
  });

  it("describes AS-IS and TO-BE in plain sentences with no file-level detail", () => {
    const b = bullet(produce, "in_short");
    expect(b).toContain(HEADING);
    expect(b).toContain("AS-IS");
    expect(b).toContain("TO-BE");
    expect(b).toMatch(/one plain sentence or two/i);
    expect(b).toMatch(/no file paths/i);
  });

  it("asks for the size estimate and says when and how to split (design 2026-11-01)", () => {
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(expect.arrayContaining(["estimated_lines", "estimated_files", "phases"]));
    const p = bullet(produce, "phases");
    expect(p).toContain("85%");
    expect(p).toMatch(/2 to 4 phases/);
    expect(p).toMatch(/mergeable on its own/);
    expect(p).toMatch(/its own done criteria/);
  });
});

describe.each([
  ["implement", "PR description"],
  ["resolve", "resolution summary"],
])("prompts/%s.md", (name, what) => {
  const text = prompt(name);
  const b = bullet(text, "summary");

  it(`says the ${what} starts with the In short section`, () => {
    expect(b).toContain(HEADING);
    expect(b).toMatch(/starts? with/);
    expect(b).toContain("AS-IS");
    expect(b).toContain("TO-BE");
  });

  it("puts the In short section before any file-level detail", () => {
    const inShort = b.indexOf(HEADING);
    const fileLevel = b.search(/file-level|each (conflicting )?file|files/);
    expect(inShort).toBeGreaterThanOrEqual(0);
    expect(fileLevel).toBeGreaterThan(inShort);
  });
});

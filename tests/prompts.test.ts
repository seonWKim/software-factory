import { readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_COMMANDS_PLACEHOLDER, fillPrompt } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";

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

  it("allows every store's migration paths for a store schema change, naming no repo path (issues #229, #335)", () => {
    expect(text).toContain("store schema change");
    expect(text).toMatch(/migration for every store the repository\s+ships/);
    expect(text).not.toContain("migrations/mysql/");
  });

  it("its output example uses neutral paths (issue #335)", () => {
    expect(text).toContain('"allowed_paths": ["src/example/"]');
  });
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks which other files a change to these paths requires (issue #224)", () => {
    expect(text).toContain("Which other files does a change to these paths require?");
  });

  it("names the topic files as the documentation targets, not the index (issue #224)", () => {
    const b = bullet(produce, "files_to_change");
    expect(b).toMatch(/topic files the change touches/);
    expect(b).not.toMatch(/Name an index only when/);
    expect(b).toMatch(/not the index/i);
  });

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

describe("prompts/improve.md (issue #307)", () => {
  const text = prompt("improve");
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks for cause, fix and touches", () => {
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(expect.arrayContaining(["cause", "fix", "touches"]));
    expect(bullet(produce, "touches")).toMatch(/paths/);
  });

  it("grants no tools and names none", () => {
    expect(text).toMatch(/You have no tools/);
    expect(text).not.toMatch(/\b(Bash|Edit|Write|Read|Grep|Glob|WebFetch|tool_grants)\b/);
  });

  it("is loaded by compose as the improve prompt", async () => {
    const { loadConfig } = await import("../src/compose.js");
    const { prompts } = await loadConfig(join(import.meta.dirname, ".."));
    expect(prompts.improve).toBe(text);
  });
});

// The core prompts serve every project the factory works on (issue #335): no npm or repo-specific paths, and the
// configured checks filled in at load.
const CORE = ["triage", "implement", "review", "resolve"] as const;
const repo = (over: Partial<FactoryConfig["repo"]>): FactoryConfig["repo"] =>
  ({ owner: "o", name: "n", path: ".", base_branch: "main", install_command: ["make", "deps"], test_command: ["make", "unit"], ...over }) as FactoryConfig["repo"];

describe.each(CORE)("prompts/%s.md is project-neutral", (name) => {
  const text = prompt(name);

  it("names no npm, doc index or src/core/ path", () => {
    for (const s of ["npm", "docs/design.md", "docs/plugins.md", "src/core/"]) expect(text, s).not.toContain(s);
  });

  it("renders for non-npm checks with no npm, no docs/design.md and no unfilled placeholder", () => {
    const out = fillPrompt(text, repo({ check_commands: [["make", "check"], ["make", "test"]] }));
    expect(out).not.toContain("npm");
    expect(out).not.toContain("docs/design.md");
    expect(out).not.toContain("{{");
  });
});

describe.each(["implement", "review"])("prompts/%s.md names the configured checks", (name) => {
  const text = prompt(name);

  it("has the placeholder", () => {
    expect(text).toContain(CHECK_COMMANDS_PLACEHOLDER);
  });

  it("puts each check_commands entry in the text, in order", () => {
    const out = fillPrompt(text, repo({ check_commands: [["make", "check"], ["make", "test"]] }));
    expect(out).toContain("`make check`");
    expect(out).toContain("`make test`");
    expect(out.indexOf("`make check`")).toBeLessThan(out.indexOf("`make test`"));
    expect(out).toMatch(/project's own scripts, never the test runner directly/);
  });

  it("falls back to test_command when check_commands is absent", () => {
    const out = fillPrompt(text, repo({}));
    expect(out).toContain("`make unit`");
    expect(out).not.toContain("{{");
  });
});

describe("on this repo", () => {
  const root = join(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(join(root, "factory.config.json"), "utf8")) as FactoryConfig;

  it.each(["implement", "review"])("prompts/%s.md renders with npm run typecheck and npm test", (name) => {
    const out = fillPrompt(prompt(name), config.repo);
    expect(out).toContain("`npm run typecheck`");
    expect(out).toContain("`npm test`");
  });

  it("CLAUDE.md links to AGENTS.md, which holds the moved test-running rule", () => {
    expect(readlinkSync(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    const rule = readFileSync(join(root, "AGENTS.md"), "utf8").split("\n").find((l) => l.startsWith("- Tests:"));
    expect(rule, "the test-running rule").toBeDefined();
    expect(rule).toMatch(/through the project's scripts/);
    expect(rule).toContain("never the test runner directly (`npx vitest ...`)");
    expect(rule).toMatch(/never run `npm install`, `npm ci`, or `npx`/);
  });
});

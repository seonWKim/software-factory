import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";

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

  it("allows every store's migration paths for a store schema change (issue #229)", () => {
    expect(text).toContain("store schema change");
    expect(text).toContain("`migrations/mysql/`");
    expect(text).toContain("`src/impl/store/mysql/migrations.ts`");
  });
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks which other files a change to these paths requires (issue #224)", () => {
    expect(text).toContain("Which other files does a change to these paths require?");
  });

  it("names the topic files as the documentation targets, not the index (issue #224)", () => {
    const b = bullet(produce, "files_to_change");
    expect(b).toContain("`docs/design/<topic>.md`");
    expect(b).toContain("`docs/plugins/<interface>.md`");
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

describe("owner defaults (issue #315)", () => {
  const text = prompt("triage");
  const defaults = prompt("owner-defaults");
  const CLAUDE = readFileSync(join(import.meta.dirname, "..", "CLAUDE.md"), "utf8");

  it("the triage prompt applies owner defaults, lists them, and asks only what no default covers", () => {
    expect(text).toMatch(/CLAUDE\.md already decides is not a decision/);
    expect(text).toMatch(/owner defaults/i);
    const b = bullet(text.slice(text.indexOf("Produce:")), "applied_defaults");
    expect(b).toMatch(/each owner default you applied/i);
    expect(b).toMatch(/rule/);
    expect(bullet(text.slice(text.indexOf("Produce:")), "decisions")).toMatch(/changes? behaviou?r and no owner default covers/);
  });

  it("the defaults file has one rule per line, each with its source issue, none repeating CLAUDE.md", () => {
    const rules = defaults.split("\n").filter((l) => l.startsWith("- "));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).toMatch(/\(issue #\d+\)$/);
      expect(CLAUDE).not.toContain(r.slice(2).replace(/\s*\(issue #\d+\)$/, ""));
    }
    expect(defaults).toMatch(/in-process state is fine only when no other replica needs it/i);
  });

  describe("loading at startup", () => {
    afterEach(() => vi.unstubAllEnvs());
    const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const root = (ownerDefaults?: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "sf-defaults-"));
      mkdirSync(join(dir, "prompts"));
      for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
      if (ownerDefaults !== undefined) writeFileSync(join(dir, "prompts", "owner-defaults.md"), ownerDefaults);
      writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" } }));
      mkdirSync(join(dir, "secrets"));
      writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
      vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
      return dir;
    };

    it("appends the file to the triage prompt when it exists", async () => {
      const loaded = await loadConfig(root("- a rule (issue #1)\n"));
      expect(loaded.prompts.triage.startsWith("triage")).toBe(true);
      expect(loaded.prompts.triage).toContain("- a rule (issue #1)");
      expect(loaded.prompts.implement).toBe("implement");
    });

    it("a missing file means no defaults and no error", async () => {
      const loaded = await loadConfig(root());
      expect(loaded.prompts.triage).toBe("triage");
    });
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

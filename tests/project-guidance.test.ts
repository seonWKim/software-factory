import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDANCE_MAX, PackGuidance, learningEntries } from "../src/impl/capability/project-guidance.js";
import type { Pack } from "../src/packs/packs.js";

/** A throwaway layer folder holding `files` (layer-relative path → content). */
function layer(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-guidance-"));
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  return dir;
}

const LEARNINGS = [
  "# Learnings",
  "",
  "Intro text that is not an entry.",
  "",
  "## Run tests through npm scripts",
  "status: active",
  "The sandbox needs the flags in the scripts.",
  "",
  "## Old advice about yarn",
  "status: retired",
  "Use yarn for everything.",
  "",
].join("\n");

describe("project guidance: rules and learnings of every layer", () => {
  it("puts every rules/*.md in full, then the unretired learnings, layer by layer", async () => {
    const base = layer({ "rules/b.md": "# Rule B\n\nAlways B.\n", "rules/a.md": "# Rule A\n\nAlways A.\n", "rules/notes.txt": "not a rule", "learnings.md": LEARNINGS });
    const org = layer({ "rules/org.md": "# Org rule\n\nNo force pushes.\n" });
    const g = await new PackGuidance([{ layer: "base", dir: base }, { layer: "org", dir: org }]).collect();
    expect(g.dropped).toBe(0);
    const t = g.text;
    expect(t.startsWith("## Rules and learnings\n\n")).toBe(true);
    const order = ["### Rule: `rules/a.md`", "# Rule A\n\nAlways A.", "### Rule: `rules/b.md`", `### Rule: \`${join(org, "rules", "org.md")}\``, "No force pushes.", "### Learnings", "## Run tests through npm scripts\nstatus: active\nThe sandbox needs the flags in the scripts."];
    const at = order.map((s) => t.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(t).not.toContain("yarn");
    expect(t).not.toContain("Intro text");
    expect(t).not.toContain("not a rule");
  });

  it("no layer folder, no rules and no learnings: empty text", async () => {
    const g = await new PackGuidance([{ layer: "base", dir: layer({}) }, { layer: "learned", dir: join(layer({}), "absent") }]).collect();
    expect(g).toEqual({ text: "", dropped: 0 });
  });

  it("only retired learnings: empty text", async () => {
    const g = await new PackGuidance([{ layer: "base", dir: layer({ "learnings.md": "## Old\nstatus: retired\nx\n" }) }]).collect();
    expect(g).toEqual({ text: "", dropped: 0 });
  });

  it("caps rules and learnings together at 8000 characters; the rest is dropped and counted", async () => {
    expect(GUIDANCE_MAX).toBe(8000);
    const rule = `# Big\n\n${"r".repeat(6000)}`;
    const entry = `## Late learning\n${"l".repeat(3000)}`;
    const dir = layer({ "rules/big.md": rule, "learnings.md": entry, "rules/zz.md": "# Last rule\n" });
    const packs: Pack[] = [{ layer: "base", dir }];
    const g = await new PackGuidance(packs).collect();
    // Rules first: big (6000) and zz (12) in full, then 1988 characters of the learning.
    expect(g.text).toContain(rule);
    expect(g.text).toContain("# Last rule");
    const kept = GUIDANCE_MAX - rule.length - "# Last rule".length;
    expect(g.text).toContain(entry.slice(0, kept));
    expect(g.text).not.toContain(entry.slice(0, kept + 1));
    expect(g.dropped).toBe(entry.length - kept);
  });

  it("a rule past the cap is left out with its heading", async () => {
    const dir = layer({ "rules/a.md": "a".repeat(GUIDANCE_MAX), "rules/b.md": "bbb" });
    const g = await new PackGuidance([{ layer: "base", dir }]).collect();
    expect(g.text).not.toContain("rules/b.md");
    expect(g.dropped).toBe(3);
  });

  it("collect(): a read failure other than a missing file rejects", async () => {
    const dir = layer({ "rules/a.md": "x" });
    mkdirSync(join(dir, "learnings.md")); // a folder where the file should be: EISDIR
    await expect(new PackGuidance([{ layer: "base", dir }]).collect()).rejects.toThrow();
    const locked = layer({ "rules/a.md": "x" });
    chmodSync(join(locked, "rules", "a.md"), 0o000);
    await expect(new PackGuidance([{ layer: "base", dir: locked }]).collect()).rejects.toThrow();
  });
});

describe("project guidance: best effort", () => {
  const recording = () => {
    const warnings: string[] = [];
    return { warnings, info: () => {}, warn: (msg: string) => warnings.push(msg), error: () => {} };
  };

  it("read() logs a failed read and gives no section instead of rejecting", async () => {
    const dir = layer({ "rules/a.md": "x" });
    mkdirSync(join(dir, "learnings.md"));
    const log = recording();
    expect(await new PackGuidance([{ layer: "base", dir }]).read(log)).toBe("");
    expect(log.warnings).toEqual(["rules and learnings could not be read; none in the prompt"]);
  });

  it("read() logs a warning when text is dropped at the cap, and none under it", async () => {
    const log = recording();
    const over = await new PackGuidance([{ layer: "base", dir: layer({ "rules/a.md": "a".repeat(GUIDANCE_MAX + 1) }) }]).read(log);
    expect(over).toContain("a".repeat(GUIDANCE_MAX));
    expect(log.warnings).toEqual(["rules and learnings over their cap; the rest was dropped"]);
    const quiet = recording();
    await new PackGuidance([{ layer: "base", dir: layer({ "rules/a.md": "a" }) }]).read(quiet);
    expect(quiet.warnings).toEqual([]);
  });
});

describe("learningEntries", () => {
  it("cuts at ## headings outside code fences and drops retired entries", () => {
    const text = "## One\nstatus: active\n```\n## not a heading\n```\n\n## Two\n  Status: Retired  \n\n## Three\nplain\n";
    expect(learningEntries(text)).toEqual(["## One\nstatus: active\n```\n## not a heading\n```", "## Three\nplain"]);
  });
});

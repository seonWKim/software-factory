import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GUIDANCE_MAX, PackGuidance, learningEntries } from "../src/impl/capability/project-guidance.js";

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

  it("keeps each entry whole under the 8000-character cap, leaves out the rest and says how many", async () => {
    expect(GUIDANCE_MAX).toBe(8000);
    const rule = `# Big\n\n${"r".repeat(6000)}`;
    const first = `## Early learning\n${"e".repeat(500)}`;
    const late = `## Late learning\n${"l".repeat(3000)}`;
    const after = "## After\nshort";
    const dir = layer({ "rules/big.md": rule, "learnings.md": [first, late, after].join("\n\n"), "rules/zz.md": "# Last rule\n" });
    const g = await new PackGuidance([{ layer: "base", dir }]).collect();
    // Rules first: big and zz whole, then the early learning; the late one does not fit, so it and the short one after it are left out.
    const kept = [rule, "# Last rule", first];
    for (const k of kept) expect(g.text).toContain(k);
    expect([...kept.map((k) => g.text.indexOf(k))].sort((x, y) => x - y)).toEqual(kept.map((k) => g.text.indexOf(k)));
    expect(g.text).not.toContain("## Late learning");
    expect(g.text).not.toContain("## After");
    expect(g.dropped).toBe(2);
    expect(g.text.endsWith(`\n\n${first}\n\n2 more rule or learning entries were left out because of the 8000-character cap.`)).toBe(true);
  });

  it("a long entry that does not fit leaves out every later entry, even a short one", async () => {
    const dir = layer({ "rules/a.md": "a".repeat(GUIDANCE_MAX + 1), "rules/b.md": "bbb", "learnings.md": "## Tiny\nx" });
    const g = await new PackGuidance([{ layer: "base", dir }]).collect();
    expect(g.text).not.toContain("rules/a.md");
    expect(g.text).not.toContain("rules/b.md");
    expect(g.text).not.toContain("## Tiny");
    expect(g.dropped).toBe(3);
    expect(g.text).toBe(
      [
        "## Rules and learnings",
        "Rules and learnings from the factory's packs. Follow them unless the work item says otherwise.",
        "3 more rule or learning entries were left out because of the 8000-character cap.",
      ].join("\n\n"),
    );
  });

  it("a rule exactly at the cap is kept whole; the next entry is left out", async () => {
    const dir = layer({ "rules/a.md": "a".repeat(GUIDANCE_MAX), "rules/b.md": "bbb" });
    const g = await new PackGuidance([{ layer: "base", dir }]).collect();
    expect(g.text).toContain(`### Rule: \`rules/a.md\`\n\n${"a".repeat(GUIDANCE_MAX)}\n\n1 more rule`);
    expect(g.text).not.toContain("rules/b.md");
    expect(g.dropped).toBe(1);
  });

  it("under the cap the section is exactly the source, with no note line", async () => {
    const base = layer({ "rules/a.md": "# Rule A\n\nAlways A.\n", "learnings.md": LEARNINGS });
    const org = layer({ "rules/org.md": "# Org rule\n\nNo force pushes.\n", "learnings.md": "## Org learning\nKeep it short.\n" });
    const g = await new PackGuidance([{ layer: "base", dir: base }, { layer: "org", dir: org }]).collect();
    expect(g.dropped).toBe(0);
    expect(g.text).toBe(
      [
        "## Rules and learnings",
        "Rules and learnings from the factory's packs. Follow them unless the work item says otherwise.",
        "### Rule: `rules/a.md`",
        "# Rule A\n\nAlways A.",
        `### Rule: \`${join(org, "rules", "org.md")}\``,
        "# Org rule\n\nNo force pushes.",
        "### Learnings",
        "## Run tests through npm scripts\nstatus: active\nThe sandbox needs the flags in the scripts.",
        "## Org learning\nKeep it short.",
      ].join("\n\n"),
    );
  });

  it("collect(): a read failure other than a missing file rejects", async () => {
    const dir = layer({ "rules/a.md": "x" });
    mkdirSync(join(dir, "learnings.md")); // a folder where the file should be: EISDIR
    await expect(new PackGuidance([{ layer: "base", dir }]).collect()).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)("collect(): an unreadable file rejects (skipped as root: root reads any file)", async () => {
    const locked = layer({ "rules/a.md": "x" });
    chmodSync(join(locked, "rules", "a.md"), 0o000);
    await expect(new PackGuidance([{ layer: "base", dir: locked }]).collect()).rejects.toThrow();
  });
});

describe("project guidance: best effort", () => {
  const recording = () => {
    const warnings: string[] = [];
    const fields: unknown[] = [];
    return { warnings, fields, info: () => {}, warn: (msg: string, f?: unknown) => (warnings.push(msg), fields.push(f)), error: () => {} };
  };

  it("read() logs a failed read and gives no section instead of rejecting", async () => {
    const dir = layer({ "rules/a.md": "x" });
    mkdirSync(join(dir, "learnings.md"));
    const log = recording();
    expect(await new PackGuidance([{ layer: "base", dir }]).read(log)).toBe("");
    expect(log.warnings).toEqual(["rules and learnings could not be read; none in the prompt"]);
  });

  it("read() logs a warning with the entries left out at the cap, and none under it", async () => {
    const log = recording();
    const over = await new PackGuidance([{ layer: "base", dir: layer({ "rules/a.md": "a".repeat(GUIDANCE_MAX + 1), "rules/b.md": "b" }) }]).read(log);
    expect(over).not.toContain("a".repeat(GUIDANCE_MAX));
    expect(over).toContain("2 more rule or learning entries were left out because of the 8000-character cap.");
    expect(log.warnings).toEqual(["rules and learnings over their cap; the rest was dropped"]);
    expect(log.fields).toEqual([{ dropped_entries: 2, cap: GUIDANCE_MAX }]);
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

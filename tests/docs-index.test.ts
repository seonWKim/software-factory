// The design and plugin docs are indexes that link to topic files (issue #121). Agents read the index first
// and open only the topics their change touches, so the indexes must stay small, every link must work, every
// topic must be reachable, and old decisions ("before: ...") belong in a topic's History section, never in an index.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The size limit for an index file, in bytes. */
const MAX_INDEX_BYTES = 8000;

/** Relative link targets in markdown text: `[text](target)`, without any `#anchor`; URLs and pure anchors skipped. */
const relativeLinks = (text: string): string[] =>
  [...text.matchAll(/\]\(([^)\s]+)\)/g)]
    .map((m) => m[1]!)
    .filter((t) => !/^[a-z][a-z0-9+.-]*:/i.test(t) && !t.startsWith("#"))
    .map((t) => t.split("#")[0]!);

/**
 * Every problem with one index and its topic folder, one line each; empty when the index is fine.
 * `index` is the index file, `topics` the folder of topic files it must link.
 */
function indexProblems(index: string, topics: string): string[] {
  const problems: string[] = [];
  const text = readFileSync(index, "utf8");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_INDEX_BYTES) problems.push(`${index}: ${bytes} bytes, over the ${MAX_INDEX_BYTES}-byte limit`);
  if (/before:/i.test(text)) problems.push(`${index}: contains "before:" (history belongs in a topic file)`);
  const linked = new Set<string>();
  for (const target of relativeLinks(text)) {
    const path = resolve(dirname(index), target);
    if (!existsSync(path)) problems.push(`${index}: broken link ${target}`);
    linked.add(path);
  }
  const files = existsSync(topics) ? readdirSync(topics).filter((f) => f.endsWith(".md")) : [];
  if (files.length === 0) problems.push(`${topics}: no topic files`);
  for (const f of files.sort()) {
    const path = resolve(topics, f);
    if (!linked.has(path)) problems.push(`${index}: topic ${f} is not linked`);
    problems.push(...topicProblems(path));
  }
  return problems;
}

/** A topic file states its current decision first and keeps its history under one `## History` heading at the bottom. */
function topicProblems(path: string): string[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const h2 = lines.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("## "));
  const history = h2.filter(([l]) => l.trim() === "## History");
  if (history.length !== 1) return [`${path}: needs exactly one "## History" heading, found ${history.length}`];
  const at = history[0]![1];
  if (h2.some(([, i]) => i > at)) return [`${path}: a heading follows "## History"; history must be at the bottom`];
  if (!lines.slice(0, at).some((l) => l.trim() !== "" && !l.startsWith("#"))) return [`${path}: no current decision before "## History"`];
  return [];
}

describe("the real indexes", () => {
  for (const [index, topics] of [
    ["docs/design.md", "docs/design"],
    ["docs/plugins.md", "docs/plugins"],
  ] as const) {
    it(`${index} is small, links every topic in ${topics}/, has no broken link and no history`, () => {
      expect(indexProblems(join(REPO_ROOT, index), join(REPO_ROOT, topics))).toEqual([]);
    });
  }

  it("the design index has one line per topic, each saying what it decides", () => {
    const text = readFileSync(join(REPO_ROOT, "docs/design.md"), "utf8");
    const lines = text.split("\n").filter((l) => /\]\(design\//.test(l));
    expect(lines.length).toBe(readdirSync(join(REPO_ROOT, "docs/design")).filter((f) => f.endsWith(".md")).length);
    for (const l of lines) expect(l, l).toMatch(/^- \[[^\]]+\]\(design\/[^)]+\.md\): \S.*\.$/);
  });

  it("the plugin index has one table row per topic: interface, plugin names, link", () => {
    const text = readFileSync(join(REPO_ROOT, "docs/plugins.md"), "utf8");
    const rows = text.split("\n").filter((l) => /\]\(plugins\//.test(l));
    expect(rows.length).toBe(readdirSync(join(REPO_ROOT, "docs/plugins")).filter((f) => f.endsWith(".md")).length);
    for (const r of rows) expect(r, r).toMatch(/^\| [^|]+ \| [^|]+ \| \[[^\]]+\]\(plugins\/[^)]+\.md\) \|$/);
    expect(rows.some((r) => r.startsWith("| How selection works |"))).toBe(true);
  });

  it("SET_UP.md links the updater topic file", () => {
    const text = readFileSync(join(REPO_ROOT, "SET_UP.md"), "utf8");
    expect(text).toContain("(docs/plugins/updater.md)");
    expect(text).not.toContain("docs/plugins.md#updater");
  });
});

describe("agents are told to read the index first and edit topic files", () => {
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), "utf8");

  it("AGENTS.md: index first, then only the topics the change touches; design changes name the topic file", () => {
    const text = read("AGENTS.md");
    expect(text).toMatch(/index first/i);
    expect(text).toMatch(/only the topic files/i);
    const rule = text.split("\n").find((l) => l.startsWith("- Design changes:"));
    expect(rule, "the design-change rule").toBeDefined();
    expect(rule).toContain("docs/design/");
    expect(rule).toMatch(/topic file/);
    expect(rule).toMatch(/History/);
    expect(text).toContain("docs/plugins/<interface>.md");
  });

  it("prompts/triage.md names topic files, not the index, in files_to_change", () => {
    const text = read("prompts/triage.md");
    expect(text).toMatch(/topic files?/);
    expect(text).toContain("docs/design/");
    expect(text).toMatch(/not the index/);
  });

  it("prompts/implement.md updates the topic files, not the index", () => {
    const text = read("prompts/implement.md");
    expect(text).toMatch(/index first/i);
    expect(text).toMatch(/topic file/);
    expect(text).toMatch(/topic files, never the index/);
    expect(text).toMatch(/History/);
  });

  it("prompts/review.md checks the topic files were updated and the index holds no decision text", () => {
    const text = read("prompts/review.md");
    expect(text).toMatch(/topic files?/);
    expect(text).toMatch(/no decision text/);
  });
});

describe("index checks, on small fixtures", () => {
  /** A fixture: `index.md` plus a `topics/` folder, from a map of relative path → content. */
  const fixture = (files: Record<string, string>): { index: string; topics: string } => {
    const dir = mkdtempSync(join(tmpdir(), "sf-docs-index-"));
    mkdirSync(join(dir, "topics"));
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
    return { index: join(dir, "index.md"), topics: join(dir, "topics") };
  };
  const topic = "# A\n\nThe current decision.\n\n## History\n\n- 2026-11-01: before: the old one.\n";
  const good = { "index.md": "# Index\n\n- [a.md](topics/a.md): what a decides.\n", "topics/a.md": topic };
  const problems = (files: Record<string, string>): string[] => {
    const { index, topics } = fixture(files);
    return indexProblems(index, topics);
  };

  it("passes a good fixture (history text inside a topic file is fine)", () => {
    expect(problems(good)).toEqual([]);
  });

  it("fails an index over 8,000 bytes", () => {
    const big = good["index.md"] + "x".repeat(MAX_INDEX_BYTES);
    expect(problems({ ...good, "index.md": big }).join("\n")).toMatch(/over the 8000-byte limit/);
    const exact = good["index.md"] + "x".repeat(MAX_INDEX_BYTES - Buffer.byteLength(good["index.md"]));
    expect(problems({ ...good, "index.md": exact })).toEqual([]);
  });

  it("fails a broken link", () => {
    const out = problems({ ...good, "index.md": good["index.md"] + "- [gone.md](topics/gone.md): missing.\n" });
    expect(out.join("\n")).toMatch(/broken link topics\/gone\.md/);
  });

  it("ignores URLs and anchors, and checks the file part of a link with an anchor", () => {
    const extra = "See [x](https://example.com/a), [y](#top), [z](topics/a.md#current).\n";
    expect(problems({ ...good, "index.md": good["index.md"] + extra })).toEqual([]);
    expect(problems({ ...good, "index.md": good["index.md"] + "[w](topics/b.md#x)\n" }).join("\n")).toMatch(/broken link topics\/b\.md/);
  });

  it("fails a topic file that is not linked", () => {
    expect(problems({ ...good, "topics/b.md": topic }).join("\n")).toMatch(/topic b\.md is not linked/);
  });

  it("fails an index that contains 'before:'", () => {
    const out = problems({ ...good, "index.md": good["index.md"] + "Old: (changed 2026-11-01; before: x).\n" });
    expect(out.join("\n")).toMatch(/contains "before:"/);
  });

  it("fails a topic file without History at the bottom", () => {
    expect(problems({ ...good, "topics/a.md": "# A\n\nThe decision.\n" }).join("\n")).toMatch(/exactly one "## History"/);
    const after = "# A\n\nThe decision.\n\n## History\n\n- old\n\n## More\n\ntext\n";
    expect(problems({ ...good, "topics/a.md": after }).join("\n")).toMatch(/history must be at the bottom/);
    expect(problems({ ...good, "topics/a.md": "# A\n\n## History\n\n- old\n" }).join("\n")).toMatch(/no current decision/);
  });
});

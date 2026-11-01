import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { Bm25CapabilitySearch, SNIPPET_MAX } from "../src/impl/capability/bm25-capability-search.js";

/** A throwaway code root holding `files` (repo-relative path → content). */
function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-bm25-"));
  for (const [p, content] of Object.entries(files)) write(dir, p, content);
  return dir;
}

function write(root: string, p: string, content: string): void {
  mkdirSync(dirname(join(root, p)), { recursive: true });
  writeFileSync(join(root, p), content);
}

const ids = async (s: Bm25CapabilitySearch, q: string, limit = 50) => (await s.search(q, limit)).map((c) => c.id);

describe("bm25: what is indexed", () => {
  it("indexes only *.md under docs/ and skills/, skipping prompts/, node_modules/, dot-directories and other roots", async () => {
    const outside = tree({ "docs/outside.md": "# Outside\n\nzebra\n" });
    const root = tree({
      "docs/a.md": "# A\n\nzebra in docs\n",
      "docs/nested/b.md": "# B\n\nzebra nested\n",
      "docs/notes.txt": "zebra but not markdown\n",
      "docs/.hidden/c.md": "# C\n\nzebra hidden\n",
      "docs/node_modules/d.md": "# D\n\nzebra in node_modules\n",
      "docs/prompts/e.md": "# E\n\nzebra in a prompts dir\n",
      "skills/s/SKILL.md": "# Skill S\n\nzebra skill\n",
      "skills/.git/f.md": "# F\n\nzebra in dot dir\n",
      "prompts/triage.md": "# Triage\n\nzebra prompt\n",
      "node_modules/pkg/README.md": "# Pkg\n\nzebra package\n",
      ".github/g.md": "# G\n\nzebra dot root\n",
      "README.md": "# Readme\n\nzebra at root\n",
      "src/x.md": "# X\n\nzebra in src\n",
    });
    symlinkSync(join(outside, "docs"), join(root, "docs", "linked"));
    const s = new Bm25CapabilitySearch(root);
    expect((await ids(s, "zebra")).sort()).toEqual(["docs/a.md", "docs/nested/b.md", "skills/s/SKILL.md"]);
  });

  it("uses kind skill under skills/ and doc under docs/, and the repo-relative path as id", async () => {
    const s = new Bm25CapabilitySearch(tree({ "docs/a.md": "# A\n\nzebra\n", "skills/b.md": "# B\n\nzebra\n" }));
    const r = await s.search("zebra", 10);
    expect(r.find((c) => c.id === "docs/a.md")?.kind).toBe("doc");
    expect(r.find((c) => c.id === "skills/b.md")?.kind).toBe("skill");
  });

  it("finds nothing when neither root exists", async () => {
    expect(await new Bm25CapabilitySearch(tree({ "README.md": "zebra" })).search("zebra", 8)).toEqual([]);
  });

  it("name is the first # heading, else the file name", async () => {
    const s = new Bm25CapabilitySearch(
      tree({ "docs/titled.md": "Intro line\n\n# The Title\n\nzebra\n", "docs/untitled.md": "zebra with no heading\n" }),
    );
    const r = await s.search("zebra", 10);
    expect(r.find((c) => c.id === "docs/titled.md")?.name).toBe("The Title");
    expect(r.find((c) => c.id === "docs/untitled.md")?.name).toBe("untitled");
  });

  it("stores headings, first paragraph and full body for each entry", () => {
    const s = new Bm25CapabilitySearch(tree({ "docs/a.md": "# A\n\nFirst para\nline two.\n\n## Part one\n\nbody text\n" }));
    const [e] = s.entries();
    expect(e).toMatchObject({ id: "docs/a.md", name: "A", headings: ["Part one"], firstParagraph: "First para line two." });
    expect(e!.body).toContain("body text");
  });
});

describe("bm25: ranking", () => {
  const corpus = () =>
    tree({
      "docs/plugins.md": "# Plugins\n\nEvery interface has named plugins chosen in config.\n\n## Registry\n\nThe registry builds each plugin.\n",
      "docs/setup.md": "# Setup\n\nOne-time setup of secrets and the database.\n\n## Secrets\n\nWhere the secret file lives.\n",
      "docs/retries.md": "# Leases\n\nHow runs are claimed.\n\n## Retries\n\nA failed run waits and goes again.\n",
      "docs/backoff.md": "# Backoff\n\nHow runs are claimed.\n\nA failed run retries and goes again.\n",
    });

  it("puts the expected document first", async () => {
    const s = new Bm25CapabilitySearch(corpus());
    expect((await ids(s, "where do secrets live"))[0]).toBe("docs/setup.md");
    expect((await ids(s, "plugin registry"))[0]).toBe("docs/plugins.md");
  });

  it("a term only in a heading ranks above the same term only in body text", async () => {
    const s = new Bm25CapabilitySearch(corpus());
    expect(await ids(s, "retries")).toEqual(["docs/retries.md", "docs/backoff.md"]);
  });

  it("returns [] when no query term matches, and for an empty query", async () => {
    const s = new Bm25CapabilitySearch(corpus());
    expect(await s.search("kubernetes helm", 8)).toEqual([]);
    expect(await s.search("  !! ", 8)).toEqual([]);
  });

  it("returns at most limit results", async () => {
    const s = new Bm25CapabilitySearch(corpus());
    expect(await s.search("how runs the", 2)).toHaveLength(2);
    expect(await s.search("how runs the", 0)).toEqual([]);
  });

  it("tokenizes case-insensitively on alphanumerics", async () => {
    const s = new Bm25CapabilitySearch(corpus());
    expect((await ids(s, "SECRETS!!"))[0]).toBe("docs/setup.md");
  });
});

describe("bm25: snippet", () => {
  it("is the first paragraph after the title on one line, capped at 200 characters with an ellipsis", async () => {
    const long = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
    const s = new Bm25CapabilitySearch(
      tree({ "docs/long.md": `# Long\n\n${long.slice(0, 150)}\n${long.slice(150)}\n\n## Next\n\nzebra\n`, "docs/short.md": "# Short\n\nA short\nsnippet.\n\nzebra\n" }),
    );
    const r = await s.search("zebra", 10);
    const longSummary = r.find((c) => c.id === "docs/long.md")!.summary;
    expect(long.length).toBeGreaterThan(SNIPPET_MAX);
    expect(SNIPPET_MAX).toBe(200);
    expect(longSummary).toHaveLength(200);
    expect(longSummary.endsWith("…")).toBe(true);
    expect(longSummary).not.toContain("\n");
    expect(longSummary.startsWith("word0 word1")).toBe(true);
    expect(r.find((c) => c.id === "docs/short.md")!.summary).toBe("A short snippet.");
  });
});

describe("bm25: rebuild on change", () => {
  it("sees an edited, an added and a removed file without restarting", async () => {
    const root = tree({ "docs/a.md": "# A\n\nalpha\n", "docs/b.md": "# B\n\nbeta\n" });
    const s = new Bm25CapabilitySearch(root);
    expect(await ids(s, "gamma")).toEqual([]);

    write(root, "docs/a.md", "# A\n\ngamma now\n");
    const later = new Date(Date.now() + 5000);
    utimesSync(join(root, "docs/a.md"), later, later);
    expect(await ids(s, "gamma")).toEqual(["docs/a.md"]);
    expect(await ids(s, "alpha")).toEqual([]);

    write(root, "skills/new.md", "# New\n\ndelta\n");
    expect(await ids(s, "delta")).toEqual(["skills/new.md"]);

    rmSync(join(root, "docs/b.md"));
    expect(await ids(s, "beta")).toEqual([]);
  });

  it("notices a same-mtime edit that changes the size", async () => {
    const root = tree({ "docs/a.md": "# A\n\nalpha\n" });
    const s = new Bm25CapabilitySearch(root);
    const t = new Date(2026, 0, 1);
    utimesSync(join(root, "docs/a.md"), t, t);
    await s.search("alpha", 1);
    write(root, "docs/a.md", "# A\n\nepsilon longer\n");
    utimesSync(join(root, "docs/a.md"), t, t);
    expect(await ids(s, "epsilon")).toEqual(["docs/a.md"]);
  });
});

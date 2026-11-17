// Design topic files stay small enough for an agent to read whole: a replaced decision moves to
// docs/design/history/<topic>.md, which has no cap. Files still over the cap sit on a ratchet list that can only shrink.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The size cap for a top-level topic file in docs/design/, in bytes (owner answer: 30 KB). */
const MAX_TOPIC_BYTES = 30_000;

/** Topic files over the cap today. Remove a file once it is at or under the cap; never add one. */
const OVER_CAP = new Set<string>();

/** Every size problem in `sizes` (file name → bytes) against `ratchet`, one line each; empty when fine. */
function sizeProblems(sizes: ReadonlyMap<string, number>, ratchet: ReadonlySet<string>): string[] {
  const problems: string[] = [];
  for (const [name, bytes] of [...sizes].sort(([a], [b]) => a.localeCompare(b))) {
    const listed = ratchet.has(name);
    if (bytes > MAX_TOPIC_BYTES && !listed) problems.push(`${name}: ${bytes} bytes, over the ${MAX_TOPIC_BYTES}-byte cap; move its History to history/${name}`);
    if (bytes <= MAX_TOPIC_BYTES && listed) problems.push(`${name}: ${bytes} bytes, at or under the cap; remove it from the ratchet list`);
  }
  for (const name of [...ratchet].sort()) if (!sizes.has(name)) problems.push(`${name}: on the ratchet list but not a topic file`);
  return problems;
}

/** Sizes of the top-level `*.md` files in `dir`; subfolders such as `history/` are not read. */
function topicSizes(dir: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    if (f.endsWith(".md") && statSync(path).isFile()) sizes.set(f, Buffer.byteLength(readFileSync(path)));
  }
  return sizes;
}

describe("docs/design topic size", () => {
  it("every top-level topic file is at or under 30,000 bytes or on the ratchet list, and every listed file is still over", () => {
    expect(sizeProblems(topicSizes(join(REPO_ROOT, "docs/design")), OVER_CAP)).toEqual([]);
  });
});

describe("size checks, on small fixtures", () => {
  const over = MAX_TOPIC_BYTES + 1;

  it("reads top-level topic files only, not history/", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-docs-size-"));
    mkdirSync(join(dir, "history"));
    writeFileSync(join(dir, "a.md"), "x".repeat(MAX_TOPIC_BYTES));
    writeFileSync(join(dir, "history", "a.md"), "x".repeat(over));
    expect([...topicSizes(dir)]).toEqual([["a.md", MAX_TOPIC_BYTES]]);
  });

  it("passes files at the cap and listed files over it", () => {
    expect(sizeProblems(new Map([["a.md", MAX_TOPIC_BYTES], ["b.md", over]]), new Set(["b.md"]))).toEqual([]);
  });

  it("fails an unlisted file over the cap", () => {
    expect(sizeProblems(new Map([["a.md", over]]), new Set()).join("\n")).toMatch(/a\.md: 30001 bytes, over the 30000-byte cap/);
  });

  it("fails a listed file at or under the cap, so the list only shrinks", () => {
    expect(sizeProblems(new Map([["a.md", MAX_TOPIC_BYTES]]), new Set(["a.md"])).join("\n")).toMatch(/remove it from the ratchet list/);
  });

  it("fails a listed file that does not exist", () => {
    expect(sizeProblems(new Map(), new Set(["gone.md"])).join("\n")).toMatch(/gone\.md: on the ratchet list but not a topic file/);
  });
});

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// A change ref is the forge's to read (Forge.parseLinks, docs/plugins/forge.md): core, the dashboard and the
// interfaces carry no `#<digits>` form of their own. This scan (what `rg '#\d' src/core src/ui src/interfaces` finds,
// plus the regex and template forms that make one) fails on any such line in code outside the allowlist. Comment
// lines are skipped. Each allowlisted file is a current match, named with why; removing those is a follow-up.

const SRC = join(import.meta.dirname, "..", "src");
const DIRS = ["core", "ui", "interfaces"];

/** `#` then digits: written out (`#42`), in a regex (`#(\d+)`, `#\d`) or from a template (`#${n}`). */
const HASH_NUMBER = /#(?:\d|\(\\d|\\d|\$\{)/;

const ALLOWED: Readonly<Record<string, string>> = {
  "core/budget.ts": "the budget report names an item's PR as `PR #N`",
  "core/change-ref.ts": "issueNumber reads the forge issue number from an `owner/repo#N` source id",
  "core/command-table.ts": "a command's help names the issue that will allow it in chat",
  "core/coordination.ts": "dependency refs `#N` and `owner/repo#N` in an item's text",
  "core/pr-body.ts": "the PR body's `Closes #N`",
  "core/resolve.ts": "the resolve prompt names the PR as `PR #N`",
  "core/session.ts": "session messages name issues and PRs as `#N`, and its PR body's `Closes #N`",
  "ui/api.ts": "an issue item's number from its `owner/repo#N` source id, and an issue number in a code comment",
  "ui/filters.ts": "the `#N` search key of an issue item",
  "ui/html.ts": "CSS colours (`#1f2328`) and HTML entities (`&#39;`), not change refs",
  "ui/list.ts": "an issue item's number from its source id",
  "ui/need.ts": "the item's change shown as `PR #N`",
  "ui/pages.ts": "the item's change shown as `PR #N`, and an issue item's `#N`",
  "ui/priority.ts": "an item waiting on another, as `#N`",
  "ui/why.ts": "dependency refs `#N` in an item's text, and the phase it waits on",
};

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

/** Every `path:line: text` of `sources` (paths relative to src/) with `#<digits>` in code: comment lines skipped. */
function hashNumberLines(sources: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    let inBlock = false;
    text.split("\n").forEach((line, i) => {
      const t = line.trim();
      const comment = inBlock || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
      if (inBlock || t.startsWith("/*")) inBlock = !t.includes("*/");
      if (!comment && HASH_NUMBER.test(line)) out.push(`${path}:${i + 1}: ${t}`);
    });
  }
  return out;
}

function sources(): { path: string; text: string }[] {
  return DIRS.flatMap((d) => files(join(SRC, d)).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") })));
}

describe("no `#<digits>` change-ref form in core, ui or interfaces", () => {
  it("every match is in an allowlisted file", () => {
    expect(hashNumberLines(sources()).filter((l) => !(l.split(":")[0]! in ALLOWED))).toEqual([]);
  });

  it("every allowlisted file still has a match and a reason; the links module has none", () => {
    const matched = new Set(hashNumberLines(sources()).map((l) => l.split(":")[0]!));
    expect(Object.keys(ALLOWED).filter((f) => !matched.has(f))).toEqual([]);
    expect(Object.entries(ALLOWED).filter(([, why]) => why.trim() === "")).toEqual([]);
    expect(matched.has("core/links.ts")).toBe(false);
  });

  it("fails on each form in code and skips comment lines, block comments included", () => {
    const text = [
      'const a = "Fixes #12";',
      "const b = /#(\\d+)/;",
      "const c = /#\\d/;",
      "const d = `PR #${n}`;",
      "// see #12",
      " * names #12",
      "/* #12",
      "#13 inside the block",
      "*/",
      'const e = "#x";',
    ].join("\n");
    expect(hashNumberLines([{ path: "core/fixture.ts", text }]).map((l) => l.split(": ")[0])).toEqual([
      "core/fixture.ts:1",
      "core/fixture.ts:2",
      "core/fixture.ts:3",
      "core/fixture.ts:4",
    ]);
  });
});

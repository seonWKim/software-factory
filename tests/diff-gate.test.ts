import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { diffLimits, loadConfig } from "../src/compose.js";
import { DIFF_LIMIT_DEFAULTS, diffStat, floorHits, overSizeLimit, requiredTier, sizeDetail } from "../src/core/diff-gate.js";

const limits = { max_diff_lines: 1500, max_diff_files: 40 };
/** numstat -z text for plain entries [added, deleted, path]. */
const z = (...entries: [number | "-", number | "-", string][]) => entries.map(([a, d, p]) => `${a}\t${d}\t${p}\0`).join("");
/** numstat -z text for a rename. */
const renamed = (a: number, d: number, from: string, to: string) => `${a}\t${d}\t\0${from}\0${to}\0`;
const files = (n: number) => Array.from({ length: n }, (_, i): [number, number, string] => [1, 0, `src/f${i}.ts`]);

describe("diffStat (pure)", () => {
  it("adds added plus deleted lines and counts files", () => {
    expect(diffStat(z([10, 2, "a.ts"], [0, 5, "b.ts"]))).toEqual({ lines: 17, files: 2, paths: ["a.ts", "b.ts"] });
    expect(diffStat("")).toEqual({ lines: 0, files: 0, paths: [] });
  });

  it("a binary file counts as one changed file and zero lines", () => {
    expect(diffStat(z(["-", "-", "img.png"], [3, 1, "a.ts"]))).toEqual({ lines: 4, files: 2, paths: ["a.ts", "img.png"] });
  });

  it("a rename is one file with both its old and new path", () => {
    const s = diffStat(renamed(1, 1, "src/old.ts", "src/impl/broker/new.ts") + z([2, 0, "x.ts"]));
    expect(s).toEqual({ lines: 4, files: 2, paths: ["src/impl/broker/new.ts", "src/old.ts", "x.ts"] });
  });

  it("rejects text that is not numstat output", () => {
    expect(() => diffStat("garbage\0")).toThrow(/numstat/);
    expect(() => diffStat("1\t1\t\0only-old\0")).toThrow(/rename/);
  });
});

describe("size limit (pure)", () => {
  it("exactly max_diff_lines passes and one more line fails", () => {
    expect(overSizeLimit(diffStat(z([1000, 500, "a.ts"])), limits)).toBe(false);
    expect(overSizeLimit(diffStat(z([1000, 501, "a.ts"])), limits)).toBe(true);
  });

  it("exactly max_diff_files passes and 41 files fails", () => {
    expect(overSizeLimit(diffStat(z(...files(40))), limits)).toBe(false);
    expect(overSizeLimit(diffStat(z(...files(41))), limits)).toBe(true);
  });

  it("41 binary files fail on the file count alone", () => {
    const bins = Array.from({ length: 41 }, (_, i): ["-", "-", string] => ["-", "-", `b${i}.png`]);
    const s = diffStat(z(...bins));
    expect(s.lines).toBe(0);
    expect(overSizeLimit(s, limits)).toBe(true);
  });

  it("the detail names the line count, file count and both limits", () => {
    const d = sizeDetail({ lines: 1501, files: 3 }, limits);
    expect(d).toContain("1501 lines");
    expect(d).toContain("max_diff_lines = 1500");
    expect(d).toContain("3 files");
    expect(d).toContain("max_diff_files = 40");
  });
});

describe("floor check (pure)", () => {
  const floors = [
    { prefix: "src/core/", tier: 3 as const },
    { prefix: "src/impl/broker/", tier: 4 as const },
    { prefix: "factory.config.json", tier: 3 as const },
  ];

  it("returns each changed floor path above the item's tier with the tier it needs", () => {
    const hits = floorHits(["src/impl/broker/x.ts", "README.md", "src/core/worker.ts"], floors, 2);
    expect(hits).toEqual([
      { path: "src/core/worker.ts", tier: 3 },
      { path: "src/impl/broker/x.ts", tier: 4 },
    ]);
    expect(requiredTier(hits)).toBe(4);
  });

  it("passes floor paths at or below the item's tier, and paths under no floor", () => {
    expect(floorHits(["src/core/worker.ts", "factory.config.json"], floors, 3)).toEqual([]);
    expect(floorHits(["src/coreX/a.ts", "docs/x.md"], floors, 1)).toEqual([]);
    expect(requiredTier([])).toBeNull();
  });

  it("a rename out of a floor still hits through its old path", () => {
    const s = diffStat(renamed(0, 0, "src/impl/broker/tool.ts", "src/tool.ts"));
    expect(floorHits(s.paths, floors, 2)).toEqual([{ path: "src/impl/broker/tool.ts", tier: 4 }]);
  });
});

describe("diffStat on real git output", () => {
  let dir = "";
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("parses `git diff --numstat -z -M` with an edit, a binary file and a rename", () => {
    dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "diff-gate-"));
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });
    const write = (p: string, body: string | Buffer) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    };
    git("init", "-q", "-b", "main");
    write("src/impl/broker/tool.ts", "export const line = 1;\n".repeat(30));
    write("a.ts", "one\ntwo\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "feature");
    write("a.ts", "one\nTWO\nthree\n");
    write("img.bin", Buffer.from([0, 1, 2, 0, 255, 0]));
    git("mv", "src/impl/broker/tool.ts", "src/tool.ts");
    git("add", "-A");
    git("commit", "-q", "-m", "change");

    const s = diffStat(git("diff", "--numstat", "-z", "-M", "main...HEAD"));
    expect(s.files).toBe(3);
    expect(s.lines).toBe(3); // a.ts: +2 -1; the binary and the pure rename add none
    expect(s.paths).toEqual(["a.ts", "img.bin", "src/impl/broker/tool.ts", "src/tool.ts"]);
  });
});

describe("diff limit config keys", () => {
  it("defaults: max_diff_lines 1500, max_diff_files 40", () => {
    expect(diffLimits({})).toEqual({ max_diff_lines: 1500, max_diff_files: 40 });
    expect(DIFF_LIMIT_DEFAULTS).toEqual({ max_diff_lines: 1500, max_diff_files: 40 });
    expect(diffLimits({ max_diff_lines: 10 })).toEqual({ max_diff_lines: 10, max_diff_files: 40 });
  });

  it("a zero or non-integer value fails", () => {
    expect(() => diffLimits({ max_diff_lines: 0 })).toThrow(/max_diff_lines must be a positive integer/);
    expect(() => diffLimits({ max_diff_files: 0 })).toThrow(/max_diff_files must be a positive integer/);
    expect(() => diffLimits({ max_diff_lines: 1.5 })).toThrow(/max_diff_lines/);
    expect(() => diffLimits({ max_diff_files: "40" as unknown as number })).toThrow(/max_diff_files/);
  });

  it("factory.config.json sets both, and loadConfig carries them into FactoryConfig", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const file = JSON.parse(readFileSync(`${root}factory.config.json`, "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ max_diff_lines: 1500, max_diff_files: 40 });
    const { config } = await loadConfig(root);
    expect(config).toMatchObject({ max_diff_lines: 1500, max_diff_files: 40 });
  });
});

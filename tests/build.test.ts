// scripts/build.mjs stamps dist/ with the revision it built (docs/design/08-self-update.md, "server revision = build
// stamp in dist/"): the UI server reports that stamp as server_rev, never the checkout's git HEAD.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { build } from "../scripts/build.mjs";
import { REVISION_STAMP, serverRevision } from "../src/ui/system-actions.js";

const REPO = join(import.meta.dirname, "..");

/** A git checkout with one commit and the real node_modules linked in; returns its root and a git runner. */
function checkout(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "sf-stamp-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: root, encoding: "utf8" }).trim();
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  copyFileSync(join(REPO, "package.json"), join(root, "package.json"));
  mkdirSync(join(root, "web"), { recursive: true });
  copyFileSync(join(REPO, "web", "vite.config.ts"), join(root, "web", "vite.config.ts"));
  writeFileSync(join(root, "web", "index.html"), "<!doctype html><title>t</title><p>t</p>\n");
  writeFileSync(join(root, ".gitignore"), "node_modules\ndist\nweb/dist\n.vite-cache\n");
  symlinkSync(dirname(dirname(createRequire(import.meta.url).resolve("vite/package.json"))), join(root, "node_modules"));
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  return { root, git };
}

const TSCONFIG = JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", rootDir: "src", outDir: "dist", types: [] }, include: ["src"] });

describe("build script: the revision stamp", () => {
  it("a build stamps the dist/ it swaps in with the revision it was built from", async () => {
    const { root, git } = checkout({ "tsconfig.json": TSCONFIG, "src/main.ts": "export const a = 1;\n" });
    try {
      build(root);
      expect(readdirSync(join(root, "dist")).sort()).toEqual(["main.js", REVISION_STAMP].sort());
      expect(await serverRevision(root)).toBe(git("rev-parse", "HEAD"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("a failed build leaves the previous stamp in place", async () => {
    const { root } = checkout({ "tsconfig.json": TSCONFIG, "src/main.ts": "export const a: number = \"not a number\";\n" });
    const old = "c".repeat(40);
    try {
      mkdirSync(join(root, "dist"));
      writeFileSync(join(root, "dist", REVISION_STAMP), `${old}\n`);
      expect(() => build(root)).toThrow(/build step failed/);
      expect(await serverRevision(root)).toBe(old);
      expect(readdirSync(root).filter((n) => n.startsWith("dist"))).toEqual(["dist"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("build script: step output", () => {
  /** Runs `fn` and returns everything it wrote to this process's stdout and stderr. */
  function captured(fn: () => void): { out: string; err: string; threw: boolean } {
    let out = "";
    let err = "";
    const o = vi.spyOn(process.stdout, "write").mockImplementation((c) => ((out += String(c)), true));
    const e = vi.spyOn(process.stderr, "write").mockImplementation((c) => ((err += String(c)), true));
    let threw = false;
    try {
      fn();
    } catch {
      threw = true;
    } finally {
      o.mockRestore();
      e.mockRestore();
    }
    return { out, err, threw };
  }

  it("a successful build prints nothing, not even Vite's chunk size warning", () => {
    const big = `export const big = ${JSON.stringify("x".repeat(700_000))};\nconsole.log(big);\n`;
    const { root } = checkout({ "tsconfig.json": TSCONFIG, "src/main.ts": "export const a = 1;\n", "web/big.js": big });
    writeFileSync(join(root, "web", "index.html"), '<!doctype html><title>t</title><script type="module" src="./big.js"></script>\n');
    try {
      const r = captured(() => build(root));
      expect(r).toEqual({ out: "", err: "", threw: false });
      expect(readdirSync(join(root, "web", "dist")).length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("a failed step prints its captured output to stderr and the build fails", () => {
    const { root } = checkout({ "tsconfig.json": TSCONFIG, "src/main.ts": "export const a: number = \"not a number\";\n" });
    try {
      const r = captured(() => build(root));
      expect(r.threw).toBe(true);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/src\/main\.ts.*TS2322/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

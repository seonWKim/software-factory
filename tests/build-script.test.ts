// scripts/build.mjs (docs/design/08-self-update.md, "Build in place"): a build swaps finished folders in with
// renames, never deletes the live one first, and concurrent swaps of the same target leave one complete folder.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { stagingPath, swapIn, sweep, withLock } from "../scripts/build.mjs";

const SCRIPT = join(import.meta.dirname, "..", "scripts", "build.mjs");

function folder(path: string, files: Record<string, string>): void {
  mkdirSync(path, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(path, name), text);
}

describe("build script: swap", () => {
  it("replaces the target with the staged folder and removes the old one", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-"));
    const target = join(root, "dist");
    folder(target, { "main.js": "old", "gone.plugin.js": "stale" });
    const staged = stagingPath(target);
    folder(staged, { "main.js": "new" });
    swapIn(staged, target);
    expect(readdirSync(target)).toEqual(["main.js"]);
    expect(readFileSync(join(target, "main.js"), "utf8")).toBe("new");
    expect(readdirSync(root)).toEqual(["dist"]);
  });

  it("a first build (no target yet) just moves the staged folder into place", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-"));
    const staged = stagingPath(join(root, "dist"));
    folder(staged, { "main.js": "new" });
    swapIn(staged, join(root, "dist"));
    expect(readdirSync(root)).toEqual(["dist"]);
  });

  it("sweep removes staging and old folders of dead builds only", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-"));
    const target = join(root, "dist");
    folder(target, {});
    folder(`${target}.build-999999999-1`, {});
    folder(`${target}.old-999999999-1`, {});
    folder(`${target}.build-${process.pid}-1`, {});
    sweep(target);
    expect(readdirSync(root).sort()).toEqual(["dist", `dist.build-${process.pid}-1`]);
  });

  it("a lock left by a dead process is taken over and released after", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-"));
    folder(join(root, "dist.swap-lock"), { pid: "999999999" });
    expect(withLock(root, () => 7)).toBe(7);
    expect(existsSync(join(root, "dist.swap-lock"))).toBe(false);
  });

  it("concurrent builds swapping the same target end with one complete folder and no leftovers", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-"));
    const target = join(root, "dist");
    const child = (tag: string) =>
      new Promise<number | null>((done) => {
        const code = `
          import { mkdirSync, writeFileSync } from "node:fs";
          import { join } from "node:path";
          import { stagingPath, swapIn, withLock } from ${JSON.stringify(pathToFileURL(SCRIPT).href)};
          const target = ${JSON.stringify(target)};
          for (let i = 0; i < 30; i++) {
            const s = stagingPath(target);
            mkdirSync(s);
            writeFileSync(join(s, "a"), "${tag}");
            writeFileSync(join(s, "b"), "${tag}");
            withLock(${JSON.stringify(root)}, () => swapIn(s, target));
          }`;
        spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" }).on("exit", done);
      });
    expect(await Promise.all([child("x"), child("y"), child("z")])).toEqual([0, 0, 0]);
    expect(readdirSync(root)).toEqual(["dist"]);
    const a = readFileSync(join(target, "a"), "utf8");
    expect(readFileSync(join(target, "b"), "utf8")).toBe(a);
  }, 20_000);
});

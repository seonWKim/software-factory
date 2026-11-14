// scripts/build.mjs (docs/design/08-self-update.md, "Build in place"): a build swaps finished folders in with
// renames, never deletes the live one first, and concurrent swaps of the same target leave one complete folder;
// with --if-stale (the factory CLI) it skips when no build input changed since the last successful build.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { stagingPath, swapIn, sweep, viteBuildArgs, withLock } from "../scripts/build.mjs";

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
          import { dirname, join } from "node:path";
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

describe("build script: the app build with a read-only node_modules", () => {
  // A factory run folder's node_modules is shared and read-only (docs/plugins/sandbox.md). With Vite's default
  // `bundle` config loader the build writes web/vite.config.ts, bundled, to node_modules/.vite-temp and fails there.
  it("builds the app writing nothing under node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "sf-build-ro-"));
    const repo = join(import.meta.dirname, "..");
    // The real config (an ES module through package.json, the case Vite bundles to a temp file) and a minimal page.
    copyFileSync(join(repo, "package.json"), join(root, "package.json"));
    mkdirSync(join(root, "web"));
    copyFileSync(join(repo, "web", "vite.config.ts"), join(root, "web", "vite.config.ts"));
    writeFileSync(join(root, "web", "index.html"), "<!doctype html><title>t</title><p>t</p>\n");
    // node_modules as a folder of links to the real packages, so its top level can be made read-only without
    // touching the real one. It already has a `.vite-temp`, as a shared node_modules that has run Vite once does.
    const real = dirname(dirname(createRequire(import.meta.url).resolve("vite/package.json")));
    const nm = join(root, "node_modules");
    const viteTemp = join(nm, ".vite-temp");
    mkdirSync(viteTemp, { recursive: true });
    for (const e of readdirSync(real).filter((n) => !n.startsWith("."))) symlinkSync(join(real, e), join(nm, e));
    const before = readdirSync(nm).sort();
    const out = join(root, "web", "out");
    chmodSync(viteTemp, 0o555);
    chmodSync(nm, 0o555);
    try {
      const r = spawnSync(process.execPath, [join(real, "vite", "bin", "vite.js"), ...viteBuildArgs(root, out)], { cwd: root, encoding: "utf8" });
      expect(r.stderr + r.stdout).not.toMatch(/EACCES|EPERM/);
      expect(r.status).toBe(0);
      expect(existsSync(join(out, "index.html"))).toBe(true);
      expect(readdirSync(nm).filter((n) => !before.includes(n))).toEqual([]);
      expect(readdirSync(viteTemp)).toEqual([]);
    } finally {
      chmodSync(nm, 0o755);
      chmodSync(viteTemp, 0o755);
    }
  }, 30_000);
});

describe("build script: --if-stale (the factory CLI's build)", () => {
  // A fake checkout: the real script, the build inputs, and stub `tsc` and `vite` that log each run to steps.log
  // and write a file into their --outDir. A `fail-<step>` file makes that step print an error and exit 1.
  const stub = (step: string) => `
    const { appendFileSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
    const { join } = require("node:path");
    appendFileSync("steps.log", "${step}\\n");
    if (existsSync("fail-${step}")) { console.error("${step}: broken input"); process.exit(1); }
    const out = process.argv[process.argv.indexOf("--outDir") + 1];
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "${step}.out"), "built");
  `;
  const PAST = new Date(Date.now() - 3_600_000);

  function checkout(): string {
    // The real path: the script runs its build only when argv[1] is its own (resolved) path, and tmpdir() is a link on macOS.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-stale-")));
    folder(join(root, "scripts"), {});
    copyFileSync(SCRIPT, join(root, "scripts", "build.mjs"));
    folder(root, { "package.json": "{}", "tsconfig.json": "{}" });
    folder(join(root, "src", "core"), { "a.ts": "export {};" });
    folder(join(root, "web", "src"), { "main.tsx": "export {};" });
    folder(join(root, "web"), { "vite.config.ts": "export default {};", "index.html": "<p>t</p>" });
    folder(join(root, "node_modules", "typescript", "bin"), { tsc: stub("tsc") });
    folder(join(root, "node_modules", "typescript"), { "package.json": '{"name":"typescript"}' });
    folder(join(root, "node_modules", "vite", "bin"), { "vite.js": stub("vite") });
    folder(join(root, "node_modules", "vite"), { "package.json": '{"name":"vite"}' });
    // Every input older than any build, so only what a test changes afterwards is newer than the marker.
    for (const p of ["src", "src/core", "src/core/a.ts", "web", "web/src", "web/src/main.tsx", "web/vite.config.ts", "web/index.html", "package.json", "tsconfig.json"])
      utimesSync(join(root, p), PAST, PAST);
    return root;
  }
  function factoryBuild(root: string) {
    return spawnSync(process.execPath, [join(root, "scripts", "build.mjs"), "--if-stale"], { cwd: root, encoding: "utf8" });
  }
  function steps(root: string): string[] {
    return existsSync(join(root, "steps.log")) ? readFileSync(join(root, "steps.log"), "utf8").split("\n").filter(Boolean) : [];
  }
  /** Builds once (both steps run), then clears the log so the next run's steps are its own. */
  function built(): string {
    const root = checkout();
    expect(factoryBuild(root).status).toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
    rmSync(join(root, "steps.log"));
    return root;
  }

  it("the factory script builds with --if-stale; build, check:responsive, migrate and setup build every time", () => {
    const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).scripts as Record<string, string>;
    expect(scripts.factory).toMatch(/^npm run --silent build -- --if-stale && node .* dist\/main\.js$/);
    expect(scripts.build).toBe("node scripts/build.mjs");
    for (const name of ["check:responsive", "migrate", "setup"]) {
      expect(scripts[name]).toContain("npm run --silent build &&");
      expect(scripts[name]).not.toContain("--if-stale");
    }
  });

  it("a second run with no source change starts no tsc and no vite", () => {
    const root = built();
    const r = factoryBuild(root);
    expect(r.status).toBe(0);
    expect(r.stdout + r.stderr).toBe("");
    expect(steps(root)).toEqual([]);
    expect(readdirSync(join(root, "dist"))).toEqual(["tsc.out"]);
  });

  it("without --if-stale the build runs every time", () => {
    const root = built();
    expect(spawnSync(process.execPath, [join(root, "scripts", "build.mjs")], { cwd: root }).status).toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
  });

  it.each(["src/core/a.ts", "web/src/main.tsx", "package.json", "tsconfig.json", "web/vite.config.ts", "web/index.html"])(
    "a change to %s builds again, once",
    (input) => {
      const root = built();
      writeFileSync(join(root, input), input.endsWith(".json") ? "{ }" : "changed");
      expect(factoryBuild(root).status).toBe(0);
      expect(steps(root)).toEqual(["tsc", "vite"]);
      expect(factoryBuild(root).status).toBe(0);
      expect(steps(root)).toEqual(["tsc", "vite"]);
    },
  );

  it.each<[string, (root: string) => void]>([
    ["adding a file", (root) => writeFileSync(join(root, "src", "core", "b.ts"), "export {};")],
    ["removing a file", (root) => rmSync(join(root, "src", "core", "a.ts"))],
    ["adding a folder", (root) => mkdirSync(join(root, "web", "src", "pages"))],
    ["removing a folder", (root) => rmSync(join(root, "src", "core"), { recursive: true })],
    ["removing a config file", (root) => rmSync(join(root, "web", "index.html"))],
  ])("%s under the build inputs builds again", (_, change) => {
    const root = built();
    change(root);
    expect(factoryBuild(root).status).toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
  });

  it.each(["dist", "web/dist"])("a missing %s builds again", (out) => {
    const root = built();
    rmSync(join(root, out), { recursive: true });
    expect(factoryBuild(root).status).toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
  });

  it.each(["tsc", "vite"])("a failed %s step exits non-zero, prints its output, swaps nothing and writes no marker", (step) => {
    const root = checkout();
    writeFileSync(join(root, `fail-${step}`), "");
    const r = factoryBuild(root);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`${step}: broken input`);
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(existsSync(join(root, "web", "dist"))).toBe(false);
    // The next run tries again, and once the step is fixed it builds and the run after skips.
    rmSync(join(root, `fail-${step}`));
    rmSync(join(root, "steps.log"));
    expect(factoryBuild(root).status).toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
    expect(existsSync(join(root, "dist.fresh"))).toBe(true);
    expect(existsSync(join(root, "web", "dist", "vite.out"))).toBe(true);
  });

  it("a failed rebuild keeps the previous output and its marker, and the next run builds again", () => {
    const root = built();
    writeFileSync(join(root, "src", "core", "a.ts"), "changed");
    writeFileSync(join(root, "fail-vite"), "");
    const marker = readFileSync(join(root, "dist.fresh"), "utf8");
    expect(factoryBuild(root).status).not.toBe(0);
    expect(readFileSync(join(root, "dist.fresh"), "utf8")).toBe(marker);
    rmSync(join(root, "steps.log"));
    expect(factoryBuild(root).status).not.toBe(0);
    expect(steps(root)).toEqual(["tsc", "vite"]);
  });
});

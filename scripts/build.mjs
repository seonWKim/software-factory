// `npm run build`: builds dist/ (server and migrations) and web/dist/ (the app) without ever taking them away from a
// running process (docs/design/08-self-update.md, "Build in place"). Each build compiles into its own empty staging
// folders beside the targets (`dist.build-<pid>-<n>`, `web/dist.build-<pid>-<n>`, same depth so source map paths
// stay right), then swaps each in with two renames under a short lock: the old folder moves aside, the staged one
// takes its name, and the old one is deleted after. Concurrent builds compile side by side; the last swap wins.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAGE = ".build-";
const OLD = ".old-";
const LOCK = "dist.swap-lock";

/** True while a process with this pid exists (EPERM: it exists but belongs to someone else). */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Removes `<target>.build-<pid>-*` and `<target>.old-<pid>-*` siblings whose pid is dead (a build that crashed). */
export function sweep(target) {
  const dir = dirname(target);
  const name = basename(target);
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const m = new RegExp(`^${name.replace(/\./g, "\\.")}(?:\\.build-|\\.old-)(\\d+)-`).exec(e);
    if (m && !alive(Number(m[1]))) rmSync(join(dir, e), { recursive: true, force: true });
  }
}

let seq = 0;
/** A fresh staging path beside `target`, unique to this process. */
export function stagingPath(target) {
  return `${target}${STAGE}${process.pid}-${Date.now()}${seq++}`;
}

/**
 * Takes the swap lock (a directory: mkdir is atomic) in `dir`, runs `fn`, releases it. A lock whose holder pid is
 * dead is taken over. The lock is held only for the renames, so waiting is short.
 */
export function withLock(dir, fn) {
  const lock = join(dir, LOCK);
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, "pid"), String(process.pid));
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let holder = NaN;
      try {
        holder = Number(readFileSync(join(lock, "pid"), "utf8"));
      } catch {
        // The holder has made the folder but not yet written its pid: wait.
      }
      if (Number.isInteger(holder) && holder > 0 && !alive(holder)) rmSync(lock, { recursive: true, force: true });
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Puts the finished `staged` folder at `target`: `target` (if any) is renamed aside, `staged` is renamed to
 * `target`, then the old folder is deleted. `target` is absent only between the two renames. Call under the lock.
 */
export function swapIn(staged, target) {
  const old = `${target}${OLD}${process.pid}-${Date.now()}${seq++}`;
  let moved = true;
  try {
    renameSync(target, old);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    moved = false;
  }
  renameSync(staged, target);
  if (moved) rmSync(old, { recursive: true, force: true });
}

function run(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`build step failed (exit ${r.status ?? r.signal}): ${args.slice(0, 3).join(" ")}`);
}

/**
 * The `vite` arguments that build the app of the checkout at `root` into `outDir`. `--configLoader runner`: Vite's
 * default `bundle` loader writes the bundled config to node_modules/.vite-temp, which fails where node_modules is
 * shared and read-only, as in a factory run folder (docs/plugins/sandbox.md).
 */
export function viteBuildArgs(root, outDir) {
  return ["build", "--configLoader", "runner", "--config", join(root, "web", "vite.config.ts"), "--logLevel", "warn", "--outDir", outDir, "--emptyOutDir"];
}

/** Builds the checkout at `root` into staging folders and swaps them in. */
export function build(root) {
  const require = createRequire(join(root, "package.json"));
  const tsc = require.resolve("typescript/bin/tsc");
  const vite = join(dirname(require.resolve("vite/package.json")), "bin", "vite.js");
  const dist = join(root, "dist");
  const webDist = join(root, "web", "dist");
  sweep(dist);
  sweep(webDist);
  const stagedDist = stagingPath(dist);
  const stagedWeb = stagingPath(webDist);
  try {
    run([tsc, "-p", join(root, "tsconfig.json"), "--outDir", stagedDist], root);
    run([tsc, "-p", join(root, "tsconfig.migrations.json"), "--outDir", stagedDist], root);
    run([vite, ...viteBuildArgs(root, stagedWeb)], root);
    withLock(root, () => {
      swapIn(stagedDist, dist);
      swapIn(stagedWeb, webDist);
    });
  } finally {
    rmSync(stagedDist, { recursive: true, force: true });
    rmSync(stagedWeb, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    build(join(dirname(fileURLToPath(import.meta.url)), ".."));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

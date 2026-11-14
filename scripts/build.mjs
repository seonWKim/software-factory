// `npm run build`: builds dist/ (the server) and web/dist/ (the app) without ever taking them away from a
// running process (docs/design/08-self-update.md, "Build in place"). Each build compiles into its own empty staging
// folders beside the targets (`dist.build-<pid>-<n>`, `web/dist.build-<pid>-<n>`, same depth so source map paths
// stay right), then swaps each in with two renames under a short lock: the old folder moves aside, the staged one
// takes its name, and the old one is deleted after. Concurrent builds compile side by side; the last swap wins.
// `--if-stale` (the `factory` script only): skip the build when no build input is newer than the freshness marker
// the last successful build wrote beside dist/ (docs/design/08-self-update.md, "Skip the CLI build when nothing changed").
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STAGE = ".build-";
const OLD = ".old-";
const LOCK = "dist.swap-lock";
/** The build stamp in dist/: the revision this build was made from (src/ui/system-actions.ts REVISION_STAMP). */
const REVISION_STAMP = "revision";
/**
 * The build-time environment variable that holds the google-calendar default client's secret on a release build
 * (docs/setup.md): set outside the repository, never in src/ or git. Unset or blank: no default client.
 */
const DEFAULT_CLIENT_SECRET_ENV = "SF_GOOGLE_DEFAULT_CLIENT_SECRET";
/** Where the generated module goes in dist/: beside default-client.js, which imports it (src/calendar/plugins/google-calendar/default-client.ts). */
const DEFAULT_CLIENT_SECRET_MODULE = join("calendar", "plugins", "google-calendar", "default-client-secret.js");
/**
 * The freshness marker beside dist/ (git-ignored like the staging folders): the start time (ms) of the last successful
 * build, written after both swaps. Beside, not inside, so dist/ holds only the build's own output.
 */
const MARKER = "dist.fresh";
/** What the build reads, relative to the checkout: folders are walked, and a folder's own time counts (add/remove). */
const BUILD_INPUTS = ["src", join("web", "src"), "package.json", "tsconfig.json", join("web", "vite.config.ts"), join("web", "index.html")];

/** True when any entry at or under `path` was changed at or after `since` (ms). A missing input counts as changed. */
function changedSince(path, since) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return true;
  }
  if (st.mtimeMs >= since) return true;
  if (!st.isDirectory()) return false;
  return readdirSync(path).some((e) => changedSince(join(path, e), since));
}

/**
 * True when the checkout at `root` needs a build: no marker or output, or a build input (file or folder) changed, was
 * added or removed since the last successful build started. Adding or removing an entry changes its folder's time.
 */
function stale(root) {
  let since;
  try {
    since = Number(readFileSync(join(root, MARKER), "utf8"));
  } catch {
    return true;
  }
  if (!Number.isFinite(since) || !existsSync(join(root, "dist")) || !existsSync(join(root, "web", "dist"))) return true;
  return BUILD_INPUTS.some((p) => changedSince(join(root, p), since));
}

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

/** Runs one build step with its output captured: silent on success (Vite's size warning), printed to stderr on failure. */
function run(args, cwd) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ""}${r.stderr ?? ""}`);
    throw new Error(`build step failed (exit ${r.status ?? r.signal}): ${args.slice(0, 3).join(" ")}`);
  }
}

/**
 * The `vite` arguments that build the app of the checkout at `root` into `outDir`. `--configLoader runner`: Vite's
 * default `bundle` loader writes the bundled config to node_modules/.vite-temp, which fails where node_modules is
 * shared and read-only, as in a factory run folder (docs/plugins/sandbox.md).
 */
export function viteBuildArgs(root, outDir) {
  return ["build", "--configLoader", "runner", "--config", join(root, "web", "vite.config.ts"), "--logLevel", "warn", "--outDir", outDir, "--emptyOutDir"];
}

/**
 * Writes the revision of the checkout at `root` (its git HEAD, the one web/vite.config.ts builds into the app) into
 * the staged `outDir`, so the UI server reports the revision of its build, not of a checkout a docs-only update moved
 * later (docs/design/08-self-update.md). No stamp when git cannot say: the server reports none.
 */
function stamp(root, outDir) {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const rev = r.status === 0 ? r.stdout.trim() : "";
  if (rev) writeFileSync(join(outDir, REVISION_STAMP), `${rev}\n`);
}

/**
 * Writes the google-calendar default client's secret module into the staged `stagedDist` (mode 600) from the release
 * `value`, and returns its path; writes nothing and returns null when `value` is unset or blank. Never prints it.
 */
export function writeDefaultClient(stagedDist, value) {
  const secret = (value ?? "").trim();
  if (secret === "") return null;
  const file = join(stagedDist, DEFAULT_CLIENT_SECRET_MODULE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `export const DEFAULT_GOOGLE_CLIENT_SECRET = ${JSON.stringify(secret)};\n`, { mode: 0o600 });
  return file;
}

/** Builds the checkout at `root` into staging folders, stamps the staged dist/ and swaps them in. */
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
  // Taken before the compile steps read anything, so an input edited during the build is newer than the marker.
  const started = Date.now();
  try {
    run([tsc, "-p", join(root, "tsconfig.json"), "--outDir", stagedDist], root);
    run([vite, ...viteBuildArgs(root, stagedWeb)], root);
    // Before the swap: a failed build never gets this far, so the live dist/ keeps its own stamp.
    stamp(root, stagedDist);
    writeDefaultClient(stagedDist, process.env[DEFAULT_CLIENT_SECRET_ENV]);
    withLock(root, () => {
      swapIn(stagedDist, dist);
      swapIn(stagedWeb, webDist);
      // Only after both swaps: a failed build or a crash between them leaves no marker for the new output.
      writeFileSync(join(root, MARKER), String(started));
    });
  } finally {
    rmSync(stagedDist, { recursive: true, force: true });
    rmSync(stagedWeb, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (!process.argv.includes("--if-stale") || stale(root)) build(root);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}

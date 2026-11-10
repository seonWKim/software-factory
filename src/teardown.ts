// `factory teardown` (design 08-teardown.md): undoes what setup and the factory left on this machine. It removes the
// state folder, the factory's own worktrees, its merged `factory/*` branches and its `refs/factory/*` refs; it keeps
// and lists everything else (a person's folders in the worktrees folder, dirty worktrees, unmerged branches, branches
// checked out somewhere). Nothing is forced. It refuses while the factory runs here, never touches a shared store,
// and saves the SQLite store before removing it.

import { existsSync } from "node:fs";
import { chmod, cp, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { basename, dirname, join, sep } from "node:path";
import { type Loaded, Plugins } from "./compose.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import { DRAIN_MARGIN_MS, PID_FILE } from "./impl/updater/git-worktree.js";
import { SUPERVISOR_STATUS_FILE, type CommandRunner, type SupervisorStatus } from "./interfaces/updater.js";
import { type DrainDeps, supervisorLive, withDrain } from "./migrate-drain.js";
import { keysOf } from "./setup.js";
import { REF_PREFIXES, RUN_FOLDER, VERSIONS_DIR, isScratchFolder, statePath } from "./setup-paths.js";

export interface TeardownOptions {
  /** Skip the "type teardown" question (not the `--secrets` one). */
  yes: boolean;
  /** Print what would go; change nothing. */
  dryRun: boolean;
  /** Drain and stop a factory running on this machine first, instead of refusing. */
  stop: boolean;
  /** Also remove the factory's named entries from the secret file (asks again). */
  secrets: boolean;
}

export interface TeardownDeps {
  print(line: string): void;
  /** Shows `prompt` and returns the line typed (empty at end of input). */
  readLine(prompt: string): Promise<string>;
  clock: DrainDeps["clock"];
  pidAlive(pid: number): boolean;
  /** Sends SIGTERM. */
  stopPid(pid: number): void;
  run: CommandRunner;
  /** Where the SQLite store's save copy goes: outside the state folder and outside the repository. */
  saveDir: string;
}

/** One thing a real run removes, as the plan prints it. */
interface Removal {
  kind: "worktree" | "clone" | "folder" | "branch" | "ref";
  path: string;
  /** branch and ref: the value the ref must still have when it is deleted. */
  sha?: string;
}

interface Plan {
  removals: Removal[];
  /** The state folder, when it exists, with its top-level entries. */
  state: { dir: string; entries: string[] } | null;
  /** Worktrees kept inside the state folder (a dirty version copy): the folder is removed around them. */
  keepInState: string[];
  /** Kept, with why: printed on every run. */
  kept: string[];
  /** The store folder to save before the state folder goes (SQLite only). */
  saveDb: string | null;
  /** Secret file entries `--secrets` removes. */
  secretNames: string[];
}

/** Runs teardown. Exit code: 0 when done or nothing to delete, 1 when refused, declined or a removal failed. */
export async function teardown(loaded: Loaded, o: TeardownOptions, deps: Partial<TeardownDeps> = {}): Promise<number> {
  const d: TeardownDeps = { ...(await defaultDeps(loaded)), ...deps };
  const live = await livePids(loaded.stateDir, d.pidAlive);
  if (live.length > 0 && !o.dryRun) {
    if (!o.stop) {
      d.print(`teardown: the factory runs on this machine (pid ${live.join(", ")}, from ${join(loaded.stateDir, SUPERVISOR_STATUS_FILE)} and the version pid files).`);
      d.print("Stop it first, or run teardown with --stop to drain it. Nothing was removed.");
      return 1;
    }
    if (!(await stopFactory(loaded, d))) {
      d.print("teardown: the factory did not stop in time. Nothing was removed.");
      return 1;
    }
  }

  const plan = await makePlan(loaded, o, d);
  printKept(plan, d);
  const empty = plan.removals.length === 0 && plan.state === null && plan.secretNames.length === 0;
  if (empty) {
    d.print("teardown: nothing to delete on this machine.");
    printManual(loaded, o, d);
    return 0;
  }
  printPlan(loaded, plan, d);
  if (o.dryRun) {
    if (live.length > 0) d.print(`The factory runs on this machine (pid ${live.join(", ")}): a real run refuses unless --stop.`);
    d.print("Dry run: nothing was removed.");
    return 0;
  }
  if (!o.yes && (await d.readLine("Type teardown to remove everything listed above: ")).trim() !== "teardown") {
    d.print("teardown: not confirmed. Nothing was removed.");
    return 1;
  }
  if (plan.secretNames.length > 0 && (await d.readLine(`Type secrets to also remove ${plan.secretNames.join(", ")} from ${loaded.secretsFile}: `)).trim() !== "secrets") {
    d.print("teardown: secret entries not confirmed. Nothing was removed.");
    return 1;
  }
  await apply(loaded, plan, d);
  printManual(loaded, o, d);
  return 0;
}

async function defaultDeps(loaded: Loaded): Promise<TeardownDeps> {
  return {
    print: (line) => console.log(line),
    readLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } catch {
        return "";
      } finally {
        rl.close();
      }
    },
    clock: await new Plugins(loaded).clock(),
    pidAlive,
    stopPid: (pid) => process.kill(pid, "SIGTERM"),
    run: runProcess,
    saveDir: join(dirname(loaded.secretsFile), "backups"),
  };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Running check

async function readStatus(stateDir: string): Promise<SupervisorStatus | null> {
  try {
    return JSON.parse(await readFile(join(stateDir, SUPERVISOR_STATUS_FILE), "utf8")) as SupervisorStatus;
  } catch {
    return null;
  }
}

/**
 * The live factory processes this machine's state folder names: the supervisor, its children (claiming and
 * draining) from supervisor.json unless it says stopped, and any version copy's pid file.
 */
export async function livePids(stateDir: string, alive: (pid: number) => boolean): Promise<number[]> {
  const pids = new Set<number>();
  const s = await readStatus(stateDir);
  if (s && s.state !== "stopped") for (const p of [s.supervisor_pid, s.child_pid, ...(s.draining_pids ?? [])]) if (typeof p === "number") pids.add(p);
  const versions = join(stateDir, VERSIONS_DIR);
  for (const v of await readdir(versions).catch(() => [] as string[])) {
    const pid = Number.parseInt((await readFile(join(versions, v, PID_FILE), "utf8").catch(() => "")).trim(), 10);
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids].filter((p) => p !== process.pid && alive(p)).sort((a, b) => a - b);
}

/**
 * `--stop`: a live supervisor is asked to drain (the migrate handshake, so in-flight runs finish first) and is
 * stopped once drained, before it reads the start request the handshake leaves; then every other live process
 * gets SIGTERM. True once none is live, within the drain timeout.
 */
async function stopFactory(loaded: Loaded, d: TeardownDeps): Promise<boolean> {
  const timeoutMs = loaded.config.run_timeout_ms + DRAIN_MARGIN_MS;
  const stopAll = async () => {
    for (const pid of await livePids(loaded.stateDir, d.pidAlive)) d.stopPid(pid);
    const start = d.clock.now().getTime();
    while ((await livePids(loaded.stateDir, d.pidAlive)).length > 0) {
      if (d.clock.now().getTime() - start >= timeoutMs) return false;
      await d.clock.sleep(1000);
    }
    return true;
  };
  if (await supervisorLive(loaded.stateDir, d.pidAlive)) {
    // The handshake's own lines speak of migration steps; teardown has none.
    const print = (line: string) => (/\bsteps\b/.test(line) ? undefined : d.print(line));
    const code = await withDrain({ stateDir: loaded.stateDir, clock: d.clock, print, timeoutMs, pidAlive: d.pidAlive }, async () => ((await stopAll()) ? 0 : 1));
    if (code !== 0) return false;
  } else if (!(await stopAll())) return false;
  d.print("the factory stopped on this machine");
  return true;
}

// Plan

const isUnder = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

async function real(path: string): Promise<string> {
  return realpath(path).catch(() => path);
}

interface GitWorktree {
  path: string;
  branch: string | null;
}

async function git(d: TeardownDeps, cwd: string, args: string[]) {
  return d.run(["git", ...args], { cwd, env: baseEnv() });
}

async function gitOut(d: TeardownDeps, cwd: string, args: string[]): Promise<string> {
  const r = await git(d, cwd, args);
  if (r.exit_code !== 0) throw new Error(`git ${args.join(" ")} failed (exit ${r.exit_code}): ${r.stderr.trim().slice(0, 300)}`);
  return r.stdout;
}

/** `git worktree list --porcelain`: the main checkout first. */
async function worktreeList(d: TeardownDeps, repo: string): Promise<GitWorktree[]> {
  const out: GitWorktree[] = [];
  for (const block of (await gitOut(d, repo, ["worktree", "list", "--porcelain"])).split(/\n\n+/)) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    if (path) out.push({ path: await real(path), branch: /^branch (.+)$/m.exec(block)?.[1] ?? null });
  }
  return out;
}

/** Why a folder's work is not safe to drop, or null: uncommitted changes, or (a clone) commits the repository lacks. */
async function unsafe(d: TeardownDeps, repo: string, dir: string, clone: boolean): Promise<string | null> {
  const status = await git(d, dir, ["status", "--porcelain"]);
  if (status.exit_code !== 0) return "its git status could not be read";
  if (status.stdout.split("\n").some((l) => l.trim() !== "" && l !== `?? ${PID_FILE}`)) return "it has uncommitted changes";
  if (!clone) return null;
  const heads = (await git(d, dir, ["for-each-ref", "--format=%(objectname)", "refs/heads/"])).stdout.split("\n");
  const head = await git(d, dir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  for (const sha of new Set([...heads, head.stdout].map((s) => s.trim()).filter(Boolean))) {
    if ((await git(d, repo, ["cat-file", "-e", `${sha}^{commit}`])).exit_code !== 0) return "it holds commits the repository does not have";
  }
  return null;
}

async function makePlan(loaded: Loaded, o: TeardownOptions, d: TeardownDeps): Promise<Plan> {
  const repo = loaded.config.repo.path;
  const stateDir = await real(loaded.stateDir);
  const worktreesDir = await real(loaded.worktreesDir);
  const plan: Plan = { removals: [], state: null, keepInState: [], kept: [], saveDb: null, secretNames: [] };
  const all = await worktreeList(d, repo);
  const remaining: GitWorktree[] = [all[0]!];
  const registered = new Set(all.map((w) => w.path));

  for (const w of all.slice(1)) {
    const inWorktrees = dirname(w.path) === worktreesDir;
    const name = basename(w.path);
    const factoryMade = isUnder(w.path, join(stateDir, VERSIONS_DIR)) || (inWorktrees && (RUN_FOLDER.test(name) || isScratchFolder(name)));
    if (!factoryMade) {
      remaining.push(w);
      if (inWorktrees) plan.kept.push(`worktree ${w.path}: not made by the factory`);
      continue;
    }
    const why = existsSync(w.path) ? await unsafe(d, repo, w.path, false) : null;
    if (why) {
      remaining.push(w);
      plan.kept.push(`worktree ${w.path}: ${why}`);
      if (isUnder(w.path, stateDir)) plan.keepInState.push(w.path);
    } else plan.removals.push({ kind: "worktree", path: w.path });
  }

  for (const name of (await readdir(worktreesDir).catch(() => [] as string[])).sort()) {
    const path = join(worktreesDir, name);
    if (registered.has(path)) continue;
    if (isScratchFolder(name)) plan.removals.push({ kind: "folder", path });
    else if (!RUN_FOLDER.test(name)) plan.kept.push(`folder ${path}: not made by the factory`);
    else {
      const why = await unsafe(d, repo, path, true);
      if (why) plan.kept.push(`run folder ${path}: ${why}`);
      else plan.removals.push({ kind: "clone", path });
    }
  }

  if (existsSync(stateDir)) {
    plan.state = { dir: stateDir, entries: (await readdir(stateDir)).sort() };
    if (loaded.store.type !== "mysql" && existsSync(join(stateDir, "db"))) plan.saveDb = join(stateDir, "db");
  }

  const checkedOut = new Set(remaining.map((w) => w.branch).filter((b): b is string => b !== null));
  const base = loaded.config.repo.base_branch;
  const bases: string[] = [];
  for (const ref of [`refs/heads/${base}`, `refs/remotes/origin/${base}`]) {
    if ((await git(d, repo, ["rev-parse", "--verify", "--quiet", ref])).exit_code === 0) bases.push(ref);
  }
  const merged = async (sha: string) => {
    for (const b of bases) if ((await git(d, repo, ["merge-base", "--is-ancestor", sha, b])).exit_code === 0) return true;
    return false;
  };
  const branchPrefix = `refs/heads/${loaded.config.branch_prefix}`;
  for (const line of (await gitOut(d, repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).split("\n")) {
    const [ref, sha] = line.split(" ");
    if (!ref || !sha) continue;
    const kind = ref.startsWith(branchPrefix) ? "branch" : REF_PREFIXES.some((p) => ref.startsWith(p)) ? "ref" : null;
    if (!kind) continue;
    if (kind === "branch" && checkedOut.has(ref)) plan.kept.push(`branch ${ref.slice(11)}: checked out in a worktree`);
    else if (!(await merged(sha))) plan.kept.push(`${kind} ${kind === "branch" ? ref.slice(11) : ref}: not merged into ${base}`);
    else plan.removals.push({ kind, path: ref, sha });
  }

  if (o.secrets) plan.secretNames = await factorySecretsIn(loaded);
  return plan;
}

/** The factory's named entries present in the secret file: setup's template keys and every name a plugin declares. */
async function factorySecretsIn(loaded: Loaded): Promise<string[]> {
  const text = await readFile(loaded.secretsFile, "utf8").catch(() => null);
  if (text === null) return [];
  const names = new Set(keysOf(await readFile(join(loaded.root, ".env.example"), "utf8").catch(() => "")));
  for (const entry of Object.values(loaded.registry)) {
    for (const decls of Object.values(entry.secrets)) for (const s of decls ?? []) names.add(s.name);
  }
  return [...new Set(keysOf(text))].filter((k) => names.has(k));
}

// Output

function printKept(plan: Plan, d: TeardownDeps): void {
  if (plan.kept.length === 0) return;
  d.print("Kept (teardown never forces these; remove them by hand if you mean to):");
  for (const k of plan.kept) d.print(`  ${k}`);
}

const LABEL: Record<Removal["kind"], string> = { worktree: "git worktree", clone: "run folder", folder: "scratch folder", branch: "branch", ref: "ref" };

function printPlan(loaded: Loaded, plan: Plan, d: TeardownDeps): void {
  d.print("Removes:");
  for (const r of plan.removals) d.print(`  ${LABEL[r.kind]} ${r.kind === "branch" ? r.path.slice(11) : r.path}`);
  if (plan.state) {
    d.print(`  state folder ${plan.state.dir}${plan.keepInState.length > 0 ? " (except the kept worktrees in it)" : ""}:`);
    for (const e of plan.state.entries) d.print(`    ${e}: ${statePath(e)?.what ?? "not in the setup list"}`);
  }
  if (plan.saveDb) d.print(`  (the store folder ${plan.saveDb} is copied to ${d.saveDir} first)`);
  if (plan.secretNames.length > 0) d.print(`  secret entries ${plan.secretNames.join(", ")} in ${loaded.secretsFile} (other lines stay)`);
}

function printManual(loaded: Loaded, o: TeardownOptions, d: TeardownDeps): void {
  const db = loaded.store;
  d.print("Not touched by teardown (remove by hand if you mean to):");
  if (db.type === "mysql") {
    d.print(`  MySQL database ${db.database} on ${db.host}:${db.port}: the shared store was not touched; other replicas keep using it. Drop it by hand (mysql -u root -p, then DROP DATABASE ${db.database}; DROP USER '${db.user}'@'localhost';).`);
  } else d.print("  MySQL: not selected (this machine used SQLite).");
  d.print(`  ${loaded.configFile}: setup's edits stay; undo them with git (git checkout -- ${loaded.configFile}).`);
  if (!o.secrets) d.print(`  ${loaded.secretsFile}: the secret file stays (run teardown --secrets, or delete it by hand).`);
  d.print(`  ${join(dirname(loaded.secretsFile), "github-app.pem")}: the GitHub App key, if you made one: delete it by hand.`);
  const { owner, name } = loaded.config.repo;
  d.print(`  GitHub issues and pull requests: close them by hand at https://github.com/${owner}/${name}/issues?q=label%3A${encodeURIComponent(loaded.config.intake_label)}`);
  d.print("  The GitHub App: uninstall or delete it at https://github.com/settings/apps");
  d.print("  The Slack app: delete it at https://api.slack.com/apps");
}

// Apply

async function apply(loaded: Loaded, plan: Plan, d: TeardownDeps): Promise<void> {
  const repo = loaded.config.repo.path;
  if (plan.saveDb) {
    const stamp = d.clock.now().toISOString().replace(/[:.]/g, "-");
    const to = join(d.saveDir, `teardown-${stamp}`);
    await cp(plan.saveDb, to, { recursive: true });
    const db = join(to, "factory.db");
    d.print(existsSync(db) ? `saved the SQLite store: ${db}` : `saved the store folder: ${to}`);
  }
  let pruned = false;
  for (const r of plan.removals) {
    if (r.kind === "worktree") {
      await unlink(join(r.path, PID_FILE)).catch(() => undefined);
      if (existsSync(r.path)) await gitOut(d, repo, ["worktree", "remove", r.path]);
      pruned = true;
    } else if (r.kind === "clone" || r.kind === "folder") {
      await rm(r.path, { recursive: true, force: true });
    } else await gitOut(d, repo, ["update-ref", "-d", r.path, r.sha!]);
    d.print(`removed ${LABEL[r.kind]} ${r.kind === "branch" ? r.path.slice(11) : r.path}`);
  }
  if (pruned) await gitOut(d, repo, ["worktree", "prune"]);
  if (plan.state) {
    await removeExcept(plan.state.dir, plan.keepInState);
    d.print(`removed the state folder ${plan.state.dir}${plan.keepInState.length > 0 ? " (kept worktrees stay)" : ""}`);
  }
  await rmdir(loaded.worktreesDir).catch(() => undefined);
  if (plan.secretNames.length > 0) {
    await removeSecretEntries(loaded.secretsFile, plan.secretNames);
    d.print(`removed ${plan.secretNames.join(", ")} from ${loaded.secretsFile}`);
  }
}

/** Removes `dir` and everything in it, except the `keep` paths (and the folders that lead to them). */
async function removeExcept(dir: string, keep: readonly string[]): Promise<void> {
  if (keep.includes(dir)) return;
  if (!keep.some((k) => isUnder(k, dir))) {
    await rm(dir, { recursive: true, force: true });
    return;
  }
  for (const e of await readdir(dir)) await removeExcept(join(dir, e), keep);
}

/** Drops each line that sets one of `names`; every other line stays as written. Atomic, mode 600. */
export async function removeSecretEntries(file: string, names: readonly string[]): Promise<void> {
  const drop = new Set(names);
  const lines = (await readFile(file, "utf8")).split("\n").filter((l) => !drop.has(keysOf(l)[0] ?? ""));
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, lines.join("\n"), { mode: 0o600 });
  await rename(tmp, file);
  await chmod(file, 0o600);
}

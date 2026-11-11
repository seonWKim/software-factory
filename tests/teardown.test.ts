// `factory teardown` (design 08-teardown.md, issue #538): undoes setup on this machine. Real git and the solo
// setup under --yes, no model and no network; the running check and `--stop` use fake pids.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultsAsk } from "../src/cli/handlers/setup/ask.js";
import { type GuidedState, SETUP_STEPS, runSetup } from "../src/cli/handlers/setup/guided.js";
import { type Loaded, loadConfig } from "../src/compose.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { runProcess } from "../src/impl/process/run-process.js";
import { SUPERVISOR_REQUEST_FILE, SUPERVISOR_STATUS_FILE } from "../src/interfaces/updater.js";
import { hostId } from "../src/runtime/host-id.js";
import type { SetupIo } from "../src/setup.js";
import { STATE_PATHS, statePath } from "../src/setup-paths.js";
import { type TeardownDeps, type TeardownOptions, teardown } from "../src/teardown.js";
import { git } from "./helpers/git-fixture.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

/** The solo config: SQLite, no GitHub, no Slack. */
const SOLO = {
  ...REAL,
  store: { type: "sqlite" },
  auth: "local",
  permissions: { grants: ["static"] },
  plugins: { ...(REAL.plugins as object), source: ["local"], broker: "local", updater: "none" },
  repo: { ...(REAL.repo as object), path: "." },
  state_dir: ".factory",
  worktrees_dir: ".worktrees",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

interface Machine {
  dir: string;
  loaded: Loaded;
  stateDir: string;
  worktreesDir: string;
  secretsFile: string;
  saveDir: string;
}

/** A git repository on `main` with the factory's config, prompts and template, and a secret file in its own folder. */
async function machine(config: Record<string, unknown> = SOLO): Promise<Machine> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "sf-teardown-")));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  copyFileSync(join(REPO_ROOT, ".env.example"), join(dir, ".env.example"));
  writeFileSync(join(dir, "factory.config.json"), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(dir, ".gitignore"), ".factory/\n.worktrees/\n");
  git(dir, "init", "--quiet", "--initial-branch=main");
  git(dir, "add", ".");
  git(dir, "commit", "--quiet", "-m", "init");
  const cfg = realpathSync(mkdtempSync(join(tmpdir(), "sf-teardown-cfg-")));
  const secretsFile = join(cfg, "software-factory", ".env");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", secretsFile);
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  const loaded = await loadConfig(dir, { platform: "linux" });
  return { dir, loaded, stateDir: loaded.stateDir, worktreesDir: loaded.worktreesDir, secretsFile, saveDir: join(cfg, "saved") };
}

/** The solo setup under --yes, from its first step through Mode (the steps that write to this machine). */
async function setup(m: Machine): Promise<void> {
  const print = () => undefined;
  const io: SetupIo = { ask: defaultsAsk(print), secret: async () => "unused", print };
  const s: GuidedState = { loaded: m.loaded, github: false, rotate: [], ctx: { name: "setup", usage: "", load: () => loadConfig(m.dir, { platform: "linux" }) } };
  await runSetup(SETUP_STEPS.slice(0, SETUP_STEPS.findIndex((x) => x.name === "mode") + 1), s, io);
}

/** What a few factory commands leave: a host id, a run's clone, a version copy, a merged branch and a ref. */
async function factoryState(m: Machine): Promise<void> {
  hostId(m.stateDir);
  git(m.dir, "branch", "factory/wi_1");
  await new NoOpSandbox(m.worktreesDir, runProcess, undefined, { local: true }).create({ repo: m.dir, branch: "factory/wi_1", base_ref: "main" });
  git(m.dir, "worktree", "add", "--quiet", "--detach", join(m.stateDir, "versions", "abc123"), "main");
  writeFileSync(join(m.stateDir, "versions", "abc123", ".factory-pid"), "999999\n");
  git(m.dir, "update-ref", "refs/factory/outbound/factory/wi_1", "main");
  writeFileSync(join(m.stateDir, SUPERVISOR_STATUS_FILE), JSON.stringify({ state: "stopped", rev: null, target_rev: null, child_pid: null, since: "" }));
}

function deps(m: Machine, over: Partial<TeardownDeps> = {}) {
  const out: string[] = [];
  const d: Partial<TeardownDeps> = {
    print: (l) => out.push(l),
    readLine: async (p) => {
      throw new Error(`unexpected question: ${p}`);
    },
    pidAlive: () => false,
    stopPid: () => undefined,
    saveDir: m.saveDir,
    ...over,
  };
  return { d, out };
}

const OPTS: TeardownOptions = { yes: true, dryRun: false, stop: false, secrets: false };

/** Everything teardown could touch: files under the state and worktrees folders, worktrees, branches and refs. */
function snapshot(m: Machine) {
  const files = (d: string): string[] => (existsSync(d) ? readdirSync(d, { recursive: true }).map(String).sort() : []);
  return {
    state: files(m.stateDir),
    worktrees: files(m.worktreesDir),
    list: git(m.dir, "worktree", "list", "--porcelain"),
    refs: git(m.dir, "for-each-ref", "--format=%(refname)"),
  };
}

const factoryRefs = (m: Machine) => git(m.dir, "for-each-ref", "--format=%(refname)", "refs/heads/factory/", "refs/factory/");

describe("teardown: the shared list of setup's paths", () => {
  it("setup writes only paths the list names", async () => {
    const m = await machine();
    await setup(m);
    const written = readdirSync(m.stateDir);
    expect(written).toContain("db");
    expect(written.filter((e) => statePath(e) === null)).toEqual([]);
  });

  it("names each entry once, with what it holds", () => {
    const names = STATE_PATHS.map((p) => p.path);
    expect(new Set(names).size).toBe(names.length);
    for (const p of STATE_PATHS) expect(p.what, p.path).not.toBe("");
  });
});

describe("teardown: round trip", () => {
  it("setup, a few commands, teardown: no factory file, worktree, branch or ref remains; a second run has nothing to delete", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    expect(readdirSync(m.worktreesDir).some((e) => /^sbx_/.test(e))).toBe(true);

    const { d, out } = deps(m);
    expect(await teardown(m.loaded, OPTS, d)).toBe(0);
    expect(existsSync(m.stateDir)).toBe(false);
    expect(existsSync(m.worktreesDir)).toBe(false);
    expect(git(m.dir, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(factoryRefs(m)).toBe("");
    // The SQLite store was saved outside the state folder first, and its path printed.
    const saved = out.find((l) => l.startsWith("saved the SQLite store: "))!.slice("saved the SQLite store: ".length);
    expect(saved.startsWith(m.saveDir)).toBe(true);
    expect(existsSync(saved)).toBe(true);
    expect(out.join("\n")).not.toMatch(/MySQL|DROP DATABASE/);

    const again = deps(m);
    expect(await teardown(m.loaded, OPTS, again.d)).toBe(0);
    expect(again.out).toContain("teardown: nothing to delete on this machine.");
  });

  it("--dry-run prints every path, worktree, branch and ref it would remove, and changes nothing", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    const before = snapshot(m);
    const { d, out } = deps(m);
    expect(await teardown(m.loaded, { ...OPTS, yes: false, dryRun: true }, d)).toBe(0);
    expect(snapshot(m)).toEqual(before);
    const text = out.join("\n");
    expect(text).toContain(`git worktree ${join(m.stateDir, "versions", "abc123")}`);
    expect(text).toMatch(/run folder .*sbx_[0-9a-f]{8}/);
    expect(text).toContain("branch factory/wi_1");
    expect(text).toContain("ref refs/factory/outbound/factory/wi_1");
    expect(text).toContain(`state folder ${m.stateDir}`);
    expect(text).toContain("db: the SQLite store");
    expect(text).toContain("Dry run: nothing was removed.");
  });

  it("without --yes any answer but `teardown` exits non-zero with nothing removed", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    const before = snapshot(m);
    const { d, out } = deps(m, { readLine: async () => "yes" });
    expect(await teardown(m.loaded, { ...OPTS, yes: false }, d)).toBe(1);
    expect(snapshot(m)).toEqual(before);
    expect(out).toContain("teardown: not confirmed. Nothing was removed.");

    const typed = deps(m, { readLine: async () => "teardown\n" });
    expect(await teardown(m.loaded, { ...OPTS, yes: false }, typed.d)).toBe(0);
    expect(existsSync(m.stateDir)).toBe(false);
  });
});

describe("teardown: keeps what it did not make or cannot drop safely", () => {
  it("keeps and lists a person's worktree and the branch checked out there, a dirty run folder and an unmerged branch", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    git(m.dir, "branch", "factory/wi_2");
    git(m.dir, "worktree", "add", "--quiet", join(m.worktreesDir, "mine"), "factory/wi_2");
    const clone = readdirSync(m.worktreesDir).find((e) => /^sbx_/.test(e))!;
    writeFileSync(join(m.worktreesDir, clone, "draft.txt"), "work in progress\n");
    git(m.dir, "checkout", "--quiet", "-b", "factory/wip/wi_3");
    writeFileSync(join(m.dir, "x.txt"), "x\n");
    git(m.dir, "add", "x.txt");
    git(m.dir, "commit", "--quiet", "-m", "unmerged");
    git(m.dir, "checkout", "--quiet", "main");

    const { d, out } = deps(m);
    expect(await teardown(m.loaded, OPTS, d)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(`worktree ${join(m.worktreesDir, "mine")}: not made by the factory`);
    expect(text).toContain("branch factory/wi_2: checked out in a worktree");
    expect(text).toContain(`run folder ${join(m.worktreesDir, clone)}: it has uncommitted changes`);
    expect(text).toContain("branch factory/wip/wi_3: not merged into main");
    expect(existsSync(join(m.worktreesDir, "mine"))).toBe(true);
    expect(existsSync(join(m.worktreesDir, clone, "draft.txt"))).toBe(true);
    expect(factoryRefs(m).split("\n").sort()).toEqual(["refs/heads/factory/wi_2", "refs/heads/factory/wip/wi_3"]);
    expect(existsSync(m.stateDir)).toBe(false);
  });
});

describe("teardown: a factory running on this machine", () => {
  const running = (m: Machine) =>
    writeFileSync(
      join(m.stateDir, SUPERVISOR_STATUS_FILE),
      JSON.stringify({ state: "running", rev: "abc", target_rev: null, child_pid: 4343, supervisor_pid: 4242, since: "" }),
    );

  it("refuses, exits non-zero and removes nothing", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    running(m);
    const before = snapshot(m);
    const { d, out } = deps(m, { pidAlive: (p) => p === 4242 || p === 4343 });
    expect(await teardown(m.loaded, OPTS, d)).toBe(1);
    expect(snapshot(m)).toEqual(before);
    expect(out.join("\n")).toContain("pid 4242, 4343");
  });

  it("--stop drains the supervisor, stops it, then continues", async () => {
    const m = await machine();
    await setup(m);
    await factoryState(m);
    running(m);
    const live = new Set([4242, 4343]);
    let t = 0;
    // The fake supervisor: on its poll it takes the drain request, its child exits, and it reports migration_ready.
    const clock = {
      now: () => new Date(t),
      sleep: async (ms: number) => {
        t += ms;
        const req = join(m.stateDir, SUPERVISOR_REQUEST_FILE);
        if (existsSync(req) && JSON.parse(readFileSync(req, "utf8")).action === "drain") {
          live.delete(4343);
          writeFileSync(join(m.stateDir, SUPERVISOR_STATUS_FILE), JSON.stringify({ state: "migration_ready", rev: "abc", target_rev: null, child_pid: null, supervisor_pid: 4242, since: "" }));
          unlinkSync(req);
        }
      },
    };
    const stopped: number[] = [];
    const { d, out } = deps(m, { clock, pidAlive: (p) => live.has(p), stopPid: (p) => (stopped.push(p), live.delete(p)) });
    expect(await teardown(m.loaded, { ...OPTS, stop: true }, d)).toBe(0);
    expect(stopped).toEqual([4242]);
    expect(out).toContain("the factory stopped on this machine");
    expect(out.some((l) => /\bsteps\b/.test(l))).toBe(false);
    expect(existsSync(m.stateDir)).toBe(false);
  });
});

describe("teardown: config and secrets", () => {
  it("keeps the config and the secret file and prints where to remove the rest by hand", async () => {
    const m = await machine();
    await setup(m);
    const { d, out } = deps(m);
    expect(await teardown(m.loaded, OPTS, d)).toBe(0);
    expect(existsSync(join(m.dir, "factory.config.json"))).toBe(true);
    expect(existsSync(m.secretsFile)).toBe(true);
    const text = out.join("\n");
    for (const where of [m.secretsFile, "factory.config.json", "https://github.com/settings/apps", "https://api.slack.com/apps", "issues"]) {
      expect(text).toContain(where);
    }
    // The store is SQLite (design 05-coordination.md): no MySQL drop instructions.
    expect(text).not.toMatch(/MySQL database|DROP DATABASE|DROP USER/);
  });

  it("--secrets asks again, then removes only the factory's entries; other lines stay and the file keeps mode 600", async () => {
    const m = await machine();
    await setup(m);
    writeFileSync(m.secretsFile, "# mine\nMY_OWN=1\nCLAUDE_CODE_OAUTH_TOKEN=x\nexport SLACK_BOT_TOKEN=y\nGITHUB_APP_ID=\n", { mode: 0o600 });

    const declined = deps(m, { readLine: async () => "no" });
    expect(await teardown(m.loaded, { ...OPTS, secrets: true }, declined.d)).toBe(1);
    expect(existsSync(m.stateDir)).toBe(true);
    expect(readFileSync(m.secretsFile, "utf8")).toContain("CLAUDE_CODE_OAUTH_TOKEN=x");

    const prompts: string[] = [];
    const { d } = deps(m, { readLine: async (p) => (prompts.push(p), "secrets") });
    expect(await teardown(m.loaded, { ...OPTS, secrets: true }, d)).toBe(0);
    expect(prompts).toHaveLength(1);
    expect(readFileSync(m.secretsFile, "utf8")).toBe("# mine\nMY_OWN=1\n");
    expect(statSync(m.secretsFile).mode & 0o777).toBe(0o600);
  });
});

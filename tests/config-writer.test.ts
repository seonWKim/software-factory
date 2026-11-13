import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Loaded, loadConfig, localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { setConfigKey } from "../src/core/config-text.js";
import { type ConfigWriterDeps, FILE_ONLY_KEYS, editConfigFile } from "../src/core/config-writer.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { Timestamp, UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { ConfigFileChangesSql } from "../src/impl/store/sql/config-file-changes.js";
import { storeSql } from "../src/impl/store/sql/store-sql.js";
import { configWriter } from "../src/ui/settings-api.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { Worker } from "../src/worker/index.js";
import { FakeRunner, MemoryStorage, cleanScanner, config, prompts, silent } from "./helpers/fakes.js";
import { newStore } from "./helpers/store.js";

// The file-only key writer (design 08-settings): one key of factory.config.json, one commit on a new local branch
// factory/<id> made without a checkout, one local item waiting for the owner's merge, one audit row. Everything runs
// in a temporary git repository; the fixture is this repository's own factory.config.json, so the loader's checks
// (checkConfigKeys, then loadConfig) run on it for real.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const FILE = "factory.config.json";
const FIXTURE = readFileSync(new URL(`../${FILE}`, import.meta.url), "utf8");
const PROJECT = localProject({ owner: "o", name: "r" });

let loaded: Loaded;
beforeAll(async () => {
  loaded = await loadConfig(process.cwd());
});

/** A repo whose main holds `text` as the config file; the owner is on another branch with uncommitted changes. */
function tempRepo(text = FIXTURE) {
  const root = mkdtempSync(join(tmpdir(), "sf-config-writer-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  writeFileSync(join(repo, FILE), text);
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", "-A");
  git(repo, ...ident, "commit", "--quiet", "-m", "init");
  git(repo, "checkout", "--quiet", "-b", "work");
  writeFileSync(join(repo, "README.md"), "hi, edited\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  const owner = () => ({
    head: git(repo, "rev-parse", "HEAD"), ref: git(repo, "symbolic-ref", "HEAD"), status: git(repo, "status", "--porcelain"),
    main: git(repo, "rev-parse", "main"), file: readFileSync(join(repo, FILE), "utf8"),
  });
  const branches = () => git(repo, "for-each-ref", "--format=%(refname)", "refs/heads/factory/");
  return { root, repo, owner, branches };
}

async function setup() {
  const r = tempRepo();
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const changes = new ConfigFileChangesSql(storeSql(store), () => clock.now().toISOString() as Timestamp);
  const sandbox = new NoOpSandbox(join(r.root, "wt"));
  // The writer as the CLI and the Settings route build it, over the temporary repo; the loader is the real one.
  const write = configWriter({
    loaded: { ...loaded, root: r.repo, configFile: join(r.repo, FILE), externalConfig: null, config: { ...loaded.config, repo: { ...loaded.config.repo, path: r.repo } } },
    store, sandbox, now: () => clock.now().toISOString(), actor: ME, project: async () => PROJECT.key, loadConfig,
  });
  /** The writer with a fixed ID sequence and no loader check: for the branch tests. */
  let n = 0;
  const deps: ConfigWriterDeps = {
    store: changes, sandbox, repo: { path: r.repo, base_branch: "main" }, file: FILE, branch_prefix: "factory/",
    identity: { name: "factory", email: "factory@example.com" }, actor: ME, project: async () => PROJECT.key,
    newId: () => `wi_${String(++n).padStart(32, "0")}` as WorkItemId, check: async () => null,
  };
  const before = r.owner();
  /** No file, branch, audit row or item was written, and the owner's checkout is as it was. */
  const nothingWritten = async () => {
    expect(r.owner()).toEqual(before);
    expect(r.branches()).toBe("");
    expect(await changes.listConfigFileChanges(10)).toEqual([]);
    expect(await store.listWorkItems(10)).toEqual([]);
  };
  return { ...r, store, changes, deps, before, nothingWritten, edit: (key: string, value: unknown, confirm = false) => write({ key, value: JSON.stringify(value), confirm }) };
}

describe("setConfigKey: the layout-keeping text edit", () => {
  const ODD = '{\n  "a":1,   "repo" : {"owner":"o",\n     "test_command":   ["npm","test"], "path":"."},\n\t"z": [1,2]\n}\n';

  it("changes only the value's text, at the top level and inside an object", () => {
    expect(setConfigKey(ODD, ["repo", "test_command"], ["npm", "run", "t"])).toBe(ODD.replace('["npm","test"]', '["npm", "run", "t"]'));
    expect(setConfigKey(ODD, ["z"], { k: true })).toBe(ODD.replace("[1,2]", '{ "k": true }'));
  });

  it("adds a missing member last in its object, with any missing parent", () => {
    const added = setConfigKey(ODD, ["repo", "check_commands"], [["npm", "test"]]);
    expect(JSON.parse(added)).toEqual({ ...JSON.parse(ODD), repo: { ...JSON.parse(ODD).repo, check_commands: [["npm", "test"]] } });
    expect(added.startsWith(ODD.slice(0, ODD.indexOf(', "path":"."}') + ', "path":"."'.length))).toBe(true);
    expect(JSON.parse(setConfigKey(ODD, ["plugins", "egress"], "pattern")).plugins).toEqual({ egress: "pattern" });
  });
});

describe("the file-only key writer", { timeout: 60_000 }, () => {
  it("a confirmed edit: one key changed, every other byte the same, one commit on factory/<id>, one item, one audit row", async () => {
    const f = await setup();
    const r = await f.edit("repo.test_command", ["npm", "run", "check"]);
    expect(r).toMatchObject({ ok: true, old_value: '["npm","test"]', new_value: '["npm","run","check"]' });
    if (!r.ok) return;
    const branch = `factory/${r.item}`;
    expect(r.branch).toBe(branch);

    // Exactly one commit, its parent main's commit, its tree differing only in the config file's one value.
    const head = git(f.repo, "rev-parse", `refs/heads/${branch}`);
    expect(head).toBe(r.sha);
    expect(git(f.repo, "rev-list", "--parents", "-n", "1", head).split(" ")).toEqual([head, f.before.main]);
    expect(git(f.repo, "rev-list", "--count", `main..${branch}`)).toBe("1");
    expect(git(f.repo, "diff", "--name-only", "main", branch)).toBe(FILE);
    const edited = git(f.repo, "cat-file", "blob", `${branch}:${FILE}`) + "\n";
    expect(edited).toBe(FIXTURE.replace('"test_command": ["npm", "test"]', '"test_command": ["npm", "run", "check"]'));
    const { repo: was, ...rest } = JSON.parse(FIXTURE);
    const { repo: now, ...restNow } = JSON.parse(edited);
    expect(restNow).toEqual(rest);
    expect(now).toEqual({ ...was, test_command: ["npm", "run", "check"] });

    // The base ref, HEAD, the index and the working tree are as they were.
    expect(f.owner()).toEqual(f.before);
    expect(f.branches()).toBe(`refs/heads/${branch}`);

    // One local item in the state the local merge waits in, and one audit row with the actor's ID.
    const item = (await f.store.getWorkItem(r.item))!;
    expect(item).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: null, requester_id: ME, project: PROJECT.key });
    expect(item.source.type).toBe("local");
    expect(await f.store.listWorkItems(10)).toHaveLength(1);
    expect(await f.changes.listConfigFileChanges(10)).toEqual([
      { seq: expect.any(Number), work_item_id: r.item, key: "repo.test_command", old_value: '["npm","test"]', new_value: '["npm","run","check"]', branch, actor: ME, at: expect.any(String) },
    ]);
    expect((await f.store.listStateChanges(r.item)).map((c) => c.reason)).toEqual(["config_file_edit"]);
    // No review run: the owner's own edit waits for the owner's merge.
    expect(await f.store.listRuns(r.item)).toEqual([]);
  });

  it("refuses a value the config loader refuses, writing nothing", async () => {
    const f = await setup();
    for (const [key, value] of [["models", { cheap: "haiku" }], ["dials", { spec_gate_min_tier: 1, auto_merge_max_tier: 2 }], ["repo.test_command", "npm test"]] as const) {
      const r = await f.edit(key, value);
      expect(r, key).toMatchObject({ ok: false, refusal: expect.stringContaining("the config loader refuses") });
    }
    expect(await editConfigFile(f.deps, { key: "models", value: "{not json", confirm: false })).toMatchObject({ ok: false, refusal: "the value of models must be JSON text" });
    await f.nothingWritten();
  });

  it("refuses a guard, floor or permission edit without the confirm flag, writing nothing", async () => {
    const f = await setup();
    const sensitive: [string, unknown][] = [
      ["plugins.secrets", "env-file"], ["plugins.egress", "pattern"], ["plugins.broker", "local"], ["deny_paths", ["/x"]],
      ["floors", []], ["permissions", { grants: ["static"] }],
      ["plugins", { ...JSON.parse(FIXTURE).plugins, broker: "local" }],
    ];
    for (const [key, value] of sensitive) {
      expect(await f.edit(key, value), key).toMatchObject({ ok: false, refusal: expect.stringContaining("confirm") });
    }
    await f.nothingWritten();
  });

  it("with the confirm flag a floor or permission edit proceeds", async () => {
    const f = await setup();
    const floors = [...JSON.parse(FIXTURE).floors, { prefix: "docs/", tier: 3 }];
    expect(await f.edit("floors", floors, true)).toMatchObject({ ok: true });
    const permissions = { ...JSON.parse(FIXTURE).permissions, grants: ["static", "github-permission"] };
    expect(await f.edit("permissions", permissions, true)).toMatchObject({ ok: true });
    expect(f.branches().split("\n")).toHaveLength(2);
    expect((await f.changes.listConfigFileChanges(10)).map((c) => c.key)).toEqual(["permissions", "floors"]);
  });

  it("an edit of plugins that keeps the guards needs no confirm flag", async () => {
    const f = await setup();
    expect(await f.edit("plugins", { ...JSON.parse(FIXTURE).plugins, capability: "none" })).not.toMatchObject({ refusal: expect.stringContaining("confirm") });
  });

  it("accepts the path lists (hotspot_paths, mechanical_paths, path_companions) as file-only keys", async () => {
    const f = await setup();
    const was = JSON.parse(FIXTURE);
    const edits: [string, unknown][] = [
      ["hotspot_paths", [...was.hotspot_paths, "src/core/settings.ts"]],
      ["mechanical_paths", [...was.mechanical_paths, "docs/notes/"]],
      ["path_companions", [...was.path_companions, { when: "src/core/settings.ts", also: ["tests/settings.test.ts"] }]],
    ];
    for (const [key, value] of edits) {
      expect(FILE_ONLY_KEYS, key).toContain(key);
      const r = await f.edit(key, value);
      expect(r, key).toMatchObject({ ok: true, new_value: JSON.stringify(value) });
      if (r.ok) expect(JSON.parse(git(f.repo, "cat-file", "blob", `${r.branch}:${FILE}`))[key]).toEqual(value);
    }
  });

  it("refuses a key that is not file-only by name, writing nothing", async () => {
    const f = await setup();
    for (const key of ["workers", "repo.owner", "store", "models.cheap"]) {
      expect(await f.edit(key, 1), key).toMatchObject({ ok: false, refusal: expect.stringContaining(`${key} is not a file-only key`) });
    }
    await f.nothingWritten();
  });

  it("refuses when factory/<id> already exists, writing nothing and leaving that branch where it was", async () => {
    const f = await setup();
    git(f.repo, "branch", "factory/wi_00000000000000000000000000000001", "main");
    const r = await editConfigFile(f.deps, { key: "repo.test_command", value: '["npm","run","check"]', confirm: false });
    expect(r).toEqual({ ok: false, refusal: "the branch factory/wi_00000000000000000000000000000001 already exists" });
    expect(git(f.repo, "rev-parse", "factory/wi_00000000000000000000000000000001")).toBe(f.before.main);
    expect(await f.changes.listConfigFileChanges(10)).toEqual([]);
    expect(await f.store.listWorkItems(10)).toEqual([]);
  });

  it("the branch is created by a conditional ref update: a branch made in between is refused", async () => {
    const f = await setup();
    const sandbox = new NoOpSandbox(join(f.root, "wt"));
    const base = (await sandbox.readLocalFile({ repo: f.repo, ref: "main", path: FILE }))!;
    const spec = {
      repo: f.repo, base_ref: "main", parent: base.commit, branch: "factory/x", path: FILE, content: "{}\n", message: "m",
      identity: { name: "f", email: "f@example.com" },
    };
    const first = await sandbox.commitNewBranch(spec);
    expect(first).toMatchObject({ created: true });
    expect(await sandbox.commitNewBranch(spec)).toEqual({ created: false, reason: "exists" });
    expect(await sandbox.commitNewBranch({ ...spec, branch: "factory/y", parent: "0".repeat(40) })).toEqual({ created: false, reason: "base_moved" });
    expect(f.owner()).toEqual(f.before);
  });
});

describe("factory merge lands a filed config edit", { timeout: 60_000 }, () => {
  it("the merge queue's checks run on the merged commit before main moves; no review run", async () => {
    const r = tempRepo();
    git(r.repo, "checkout", "--quiet", "main");
    const gates = join(r.root, "gates.log");
    const gate = (name: string) => ["sh", "-c", `echo "${name} $(git rev-parse HEAD)" >> "${gates}"`];
    const cfg: FactoryConfig = { ...config, project: PROJECT, local_only: true, repo: { ...config.repo, path: r.repo, install_command: gate("install"), test_command: gate("test") } };
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
    const sandbox = new NoOpSandbox(join(r.root, "wt"), undefined, undefined, { local: true });
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth, clock, config: cfg, log: silent, scanner: cleanScanner, sandbox, repeated_failure_rule: false,
    });
    const worker = new Worker({
      id: "w1" as WorkerId, store, sandbox, runner: new FakeRunner({}), broker: new LocalToolBroker({ store, scanner: cleanScanner, branchPrefix: cfg.branch_prefix, repoPath: r.repo }),
      storage: new MemoryStorage(), clock, config: cfg, prompts, log: silent, scanner: cleanScanner,
      toolEnv: { PATH: process.env.PATH ?? "", HOME: r.root, GIT_CONFIG_GLOBAL: "/dev/null" }, awake: new NoKeepAwake(),
    });
    const step = async () => {
      await controller.tickIntake();
      while (await worker.tick()) await controller.tickRuns();
      await controller.tickRuns();
    };
    // The owner claims the factory first, as any local CLI command does.
    let n = 0;
    const cli = (a: Parameters<typeof runLocalCli>[1]) =>
      runLocalCli({ store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT.key, read: async () => "", newId: () => `id${++n}` }, a);
    await cli({ action: "users_list" });

    const mainBefore = git(r.repo, "rev-parse", "main");
    const e = await editConfigFile(
      {
        store: new ConfigFileChangesSql(storeSql(store), () => clock.now().toISOString() as Timestamp), sandbox, repo: { path: r.repo, base_branch: "main" }, file: FILE, branch_prefix: cfg.branch_prefix, identity: cfg.agent_git_identity,
        actor: ME, project: async () => PROJECT.key, newId: () => "wi_config0000000000000000000000001" as WorkItemId, check: async () => null,
      },
      { key: "repo.test_command", value: '["npm","run","check"]', confirm: false },
    );
    if (!e.ok) throw new Error(e.refusal);
    expect(existsSync(gates)).toBe(false);

    expect((await cli({ action: "command", command: "merge", id: e.item, text: "" })).code).toBe(0);
    await step();
    const main = git(r.repo, "rev-parse", "main");
    expect(await store.getWorkItem(e.item)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect(git(r.repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, e.sha]);
    expect(JSON.parse(git(r.repo, "show", `main:${FILE}`)).repo.test_command).toEqual(["npm", "run", "check"]);
    // The merge queue's checks ran before it landed.
    expect(readFileSync(gates, "utf8")).toMatch(/^install [0-9a-f]+\ntest [0-9a-f]+/);
    expect((await store.listRuns(e.item)).map((x) => x.kind)).not.toContain("review");
  });
});

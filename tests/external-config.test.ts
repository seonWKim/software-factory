// An external config (issue #336): `--config <path>` or FACTORY_CONFIG replaces the checked-in
// factory.config.json, and its folder holds the state. Prompts still come from the code root.

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_ENV, Plugins, cliConfig, loadConfig } from "../src/compose.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { pendingIn } from "../src/impl/updater/git-worktree.plugin.js";
import { CODE_ROOT_ENV, type CommandRunner } from "../src/interfaces/updater.js";
import { REGISTRY, createPlugin } from "../src/plugins.js";
import { checkLine, doctor, doctorChecks } from "../src/setup.js";
import { createUpdater } from "../src/supervisor.js";
import { recordingLog } from "./helpers/fakes.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const CHECKED_IN = join(REPO_ROOT, "factory.config.json");
const REAL = JSON.parse(readFileSync(CHECKED_IN, "utf8")) as Record<string, unknown>;
const SOLO = { ...REAL, store: { type: "sqlite" } };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

/** A main checkout (the cwd and code root) with its own checked-in config and prompts. */
function checkout(config: Record<string, unknown>): string {
  const dir = temp("sf-main-");
  mkdirSync(join(dir, "prompts"), { recursive: true });
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), `checked-in ${p}`);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, intake_label: "checked-in" }));
  return dir;
}

/** An external config in its own folder (like /tmp/x/factory.config.json). */
function external(config: Record<string, unknown>, dir = temp("sf-x-")): string {
  const file = join(dir, "factory.config.json");
  writeFileSync(file, JSON.stringify({ ...config, intake_label: "external" }));
  return file;
}

function noSecrets(): void {
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(temp("sf-nosecrets-"), ".env"));
}

describe("external config: the path", () => {
  it("factory dev --config <path> loads that file and not the checked-in one; prompts still come from the code root", async () => {
    const main = checkout(SOLO);
    const file = external(SOLO);
    const { args, configFile } = cliConfig(["dev", "--config", file], {}, main);
    expect(args).toEqual(["dev"]);
    expect(configFile).toBe(file);
    const loaded = await loadConfig(main, { configFile });
    expect(loaded.file.intake_label).toBe("external");
    expect(loaded.configFile).toBe(file);
    expect(loaded.externalConfig).toBe(file);
    expect(loaded.prompts.triage).toBe("checked-in triage");
  });

  it("the flag may come before the command, or as --config=<path>", () => {
    expect(cliConfig(["--config", "/x/c.json", "doctor", "--llm"], {}, "/cwd")).toEqual({ args: ["doctor", "--llm"], configFile: "/x/c.json" });
    expect(cliConfig(["status", "--config=/x/c.json"], {}, "/cwd")).toEqual({ args: ["status"], configFile: "/x/c.json" });
  });

  it("FACTORY_CONFIG works like the flag; when both are set, --config wins", () => {
    expect(cliConfig(["dev"], { [CONFIG_ENV]: "/env/c.json" }, "/cwd").configFile).toBe("/env/c.json");
    expect(cliConfig(["dev", "--config", "/flag/c.json"], { [CONFIG_ENV]: "/env/c.json" }, "/cwd").configFile).toBe("/flag/c.json");
  });

  it("no flag and no env var: no external config, the arguments unchanged", () => {
    expect(cliConfig(["dev", "x"], {}, "/cwd")).toEqual({ args: ["dev", "x"], configFile: undefined });
    expect(cliConfig(["dev"], { [CONFIG_ENV]: "" }, "/cwd").configFile).toBeUndefined();
  });

  it("a relative path is made absolute once, against the cwd at startup", () => {
    expect(cliConfig(["dev", "--config", "conf/c.json"], {}, "/work/proj").configFile).toBe("/work/proj/conf/c.json");
    expect(cliConfig(["dev"], { [CONFIG_ENV]: "../c.json" }, "/work/proj").configFile).toBe("/work/c.json");
  });

  it("--config with no path is refused", () => {
    expect(() => cliConfig(["dev", "--config"], {}, "/cwd")).toThrow(/--config needs a path/);
    expect(() => cliConfig(["dev", "--config="], {}, "/cwd")).toThrow(/--config needs a path/);
  });

  it("a missing or unreadable config file stops startup with an error that names the path", async () => {
    const main = checkout(SOLO);
    const missing = join(temp("sf-x-"), "factory.config.json");
    await expect(loadConfig(main, { configFile: missing })).rejects.toThrow(`cannot load the config file ${missing}`);
    const dir = temp("sf-x-");
    const bad = join(dir, "factory.config.json");
    writeFileSync(bad, "{ not json");
    await expect(loadConfig(main, { configFile: bad })).rejects.toThrow(`cannot load the config file ${bad}`);
    await expect(loadConfig(main, { configFile: dir })).rejects.toThrow(`cannot load the config file ${dir}`);
  });
});

describe("external config: where state lands", () => {
  it("with an external config, state_dir and worktrees_dir resolve from its folder; repo.path from the cwd", async () => {
    noSecrets();
    const main = checkout(SOLO);
    const x = temp("sf-x-");
    const loaded = await loadConfig(main, { configFile: external(SOLO, x) });
    expect(loaded.stateDir).toBe(join(x, REAL.state_dir as string));
    expect(loaded.worktreesDir).toBe(join(x, REAL.worktrees_dir as string));
    expect(loaded.config.repo.path).toBe(main);
    expect(loaded.config.deny_paths).toContain(join(x, REAL.state_dir as string, "db"));
    const base = new Plugins(loaded).base;
    const sandbox = await createPlugin(REGISTRY, "sandbox", "noop", base);
    expect((sandbox as unknown as { worktreesDir: string }).worktreesDir).toBe(join(x, REAL.worktrees_dir as string));
  });

  it("no flag and no env var: the checked-in file under the code root, state and worktrees under the cwd", async () => {
    const main = checkout(SOLO);
    const loaded = await loadConfig(main);
    expect(loaded.file.intake_label).toBe("checked-in");
    expect(loaded.configFile).toBe(join(main, "factory.config.json"));
    expect(loaded.externalConfig).toBeNull();
    expect(loaded.stateDir).toBe(join(main, REAL.state_dir as string));
    expect(loaded.worktreesDir).toBe(join(main, REAL.worktrees_dir as string));
  });

  it("the checked-in factory.config.json loads with its content unchanged, as the checked-in file and as --config", async () => {
    noSecrets();
    expect((await loadConfig(REPO_ROOT)).file).toEqual(REAL);
    expect((await loadConfig(REPO_ROOT, { configFile: CHECKED_IN })).file).toEqual(REAL);
  });
});

describe("external config: reviewed keys", () => {
  const loosened = {
    dials: { spec_gate_min_tier: 5, auto_merge_max_tier: 0 },
    floors: [],
    auth: "local",
    permissions: { grants: ["static"], static: { "local:me": ["owner"] } },
  };

  it("solo use (SQLite): a user config may set any key", async () => {
    const main = checkout(SOLO);
    const loaded = await loadConfig(main, { configFile: external({ ...SOLO, ...loosened }) });
    expect(loaded.file.dials).toEqual(loosened.dials);
    expect(loaded.file.floors).toEqual([]);
    expect(loaded.file.auth).toBe("local");
  });

  it("a shared store (MySQL): floors, dials, plugins, permissions and auth come only from the checked-in file", async () => {
    noSecrets();
    const main = checkout(REAL);
    const plugins = { ...(REAL.plugins as Record<string, unknown>), updater: "none" };
    const loaded = await loadConfig(main, { configFile: external({ ...REAL, ...loosened, plugins, workers: 2 }) });
    for (const k of ["dials", "floors", "plugins", "auth"]) expect(loaded.file[k as keyof typeof loaded.file], k).toEqual(REAL[k]);
    expect(loaded.file.permissions).toBeUndefined();
    expect(loaded.plugins.updater).toBe((REAL.plugins as Record<string, unknown>).updater);
    // Any other key is the user's.
    expect(loaded.file.intake_label).toBe("external");
    expect(loaded.file.workers).toBe(2);
  });
});

describe("external config: doctor", () => {
  it("prints one line that names the config file in use", async () => {
    noSecrets();
    const main = checkout(SOLO);
    const file = external(SOLO);
    const named = (await doctorChecks(await loadConfig(main, { configFile: file }))).filter((c) => c.msg.startsWith("config file: "));
    expect(named.map(checkLine)).toEqual([`ok    config file: ${file} (--config / FACTORY_CONFIG)`]);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await doctor(await loadConfig(main));
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("config file: "));
    expect(lines).toEqual([`ok    config file: ${join(main, "factory.config.json")} (checked-in)`]);
  });
});

describe("external config: git-worktree migrate calls", () => {
  it("the migrate --status check and migrate for a new folder get the external config as FACTORY_CONFIG", async () => {
    noSecrets();
    const main = checkout(SOLO);
    const file = external(SOLO);
    const calls: { cmd: readonly string[]; cwd: string; env: Readonly<Record<string, string>> }[] = [];
    const run: CommandRunner = async (cmd, opts) => {
      calls.push({ cmd, cwd: opts.cwd, env: opts.env });
      return { exit_code: 0, signal: null, stdout: '{"pending":[]}\n', stderr: "", timed_out: false };
    };
    const loaded = await loadConfig(main, { configFile: file });
    const u = await createUpdater(loaded, { run, launcher: { launch: () => { throw new Error("no launch"); } }, clock: new FakeClock(), log: recordingLog() });
    const o = (u as unknown as { o: { pendingMigrations(dir: string): Promise<string[] | null>; applyMigrations(dir: string): Promise<boolean>; configFile?: string } }).o;
    expect(o.configFile).toBe(file);
    expect(await o.pendingMigrations("/v/c2")).toEqual([]);
    expect(await o.applyMigrations("/v/c2")).toBe(true);
    expect(calls.map((c) => c.cmd.slice(3))).toEqual([["migrate", "--status", "--json"], ["migrate", "--no-drain"]]);
    for (const c of calls) {
      expect(c.cwd).toBe(main);
      expect(c.env[CONFIG_ENV]).toBe(file);
      expect(c.env[CODE_ROOT_ENV]).toBe("/v/c2");
    }
  });

  it("without an external config, the migrate check passes no FACTORY_CONFIG: the folder reads its own file", async () => {
    let env: Readonly<Record<string, string>> = {};
    const run: CommandRunner = async (_cmd, opts) => {
      env = opts.env;
      return { exit_code: 0, signal: null, stdout: '{"pending":["001"]}', stderr: "", timed_out: false };
    };
    expect(await pendingIn(run, { repoPath: "/main", configFile: null }, "/v/c2")).toEqual(["001"]);
    expect(env[CONFIG_ENV]).toBeUndefined();
  });
});

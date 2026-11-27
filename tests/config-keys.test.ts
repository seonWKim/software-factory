import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildUiParts } from "../src/compose.js";
import { loadConfig } from "../src/load-config.js";
import { uiUserId } from "../src/config-values.js";
import { SKILL_IMPROVE_DEFAULTS, SKILL_IMPROVE_KEYS, goldenConfig } from "../src/core/config.js";
import { cleanupConfig } from "../src/cleanup/index.js";
import type { CliIdentity } from "../src/core/local-cli.js";
import type { UserId } from "../src/core/types.js";
import {
  ConfigKeyError,
  STORE_KEYS,
  TOP_LEVEL_KEYS,
  closestKey,
  configFailLines,
  editDistance,
} from "../src/config-keys.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts and secret file. */
function root(config: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-config-keys-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify(config));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), "GITHUB_TOKEN=gh\n");
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

async function loadError(config: Record<string, unknown>): Promise<Error> {
  const err = await loadConfig(root(config)).then(
    () => null,
    (e: Error) => e,
  );
  if (!err) throw new Error("loadConfig succeeded");
  return err;
}

const SQLITE = { ...REAL, store: { type: "sqlite" } };

describe("config keys: unknown keys fail at load", () => {
  it("an unknown top-level key fails before the env, dials and other checks, naming the key and the valid keys", async () => {
    // env and dials are invalid too: the key check must run first.
    const err = await loadError({ ...REAL, env: "cloud", dials: { spec_gate_min_tier: 9, auto_merge_max_tier: 1 }, zebra: 1 });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain('"zebra"');
    for (const k of TOP_LEVEL_KEYS) expect(err.message).toContain(k);
    expect(err.message).not.toContain("did you mean");
  });

  it('"plugin" suggests "plugins"', async () => {
    const { plugins, ...rest } = REAL;
    const err = await loadError({ ...rest, plugin: plugins });
    expect(err.message).toContain('did you mean "plugins"?');
  });

  it('a sqlite store with "tpye" names store.tpye, lists the store keys and suggests "type"', async () => {
    const err = await loadError({ ...REAL, store: { type: "sqlite", tpye: "x" } });
    expect(err.message).toContain("store.tpye");
    for (const k of STORE_KEYS.sqlite!) expect(err.message).toContain(k);
    expect(err.message).toContain('did you mean "type"?');
  });

  it("an unknown key inside a floors entry names the path with the index", async () => {
    const floors = [{ prefix: "a/", tiar: 3 }, ...(REAL.floors as object[])];
    const err = await loadError({ ...REAL, floors });
    expect(err.message).toContain("floors[0].tiar");
    expect(err.message).toContain('did you mean "tier"?');
  });

  const nested: [string, string, string[]][] = [
    ["repo", "repo.zzzzzz", ["owner", "name", "path", "base_branch", "install_command", "install_commands", "test_command"]],
    ["dials", "dials.zzzzzz", ["spec_gate_min_tier", "auto_merge_max_tier"]],
    ["models", "models.zzzzzz", ["cheap", "standard", "strong"]],
    ["agent_git_identity", "agent_git_identity.zzzzzz", ["name", "email"]],
    ["ui", "ui.zzzzzz", ["port", "user_id"]],
  ];
  for (const [block, path, keys] of nested) {
    it(`an unknown key inside ${block} fails against ${block}'s own keys`, async () => {
      const err = await loadError({ ...REAL, [block]: { ...(REAL[block] as object), zzzzzz: 1 } });
      expect(err.message).toContain(path);
      expect(err.message).toContain(`valid ${block} keys: ${keys.join(", ")}`);
    });
  }

  it("repo.restart_command: absent is off, an argv of non-empty strings loads, any other value fails startup naming the key", async () => {
    const repo = REAL.repo as Record<string, unknown>;
    expect((await loadConfig(root({ ...REAL, repo }))).config.repo.restart_command).toBeUndefined();
    const set = await loadConfig(root({ ...REAL, repo: { ...repo, restart_command: ["bin/restart", "--port", "8080"] } }));
    expect(set.config.repo.restart_command).toEqual(["bin/restart", "--port", "8080"]);
    for (const bad of ["bin/stop && bin/start", [], ["bin/restart", ""], [1], null]) {
      const err = await loadError({ ...REAL, repo: { ...repo, restart_command: bad } });
      expect(err.message, JSON.stringify(bad)).toContain("repo.restart_command must be a non-empty array of non-empty strings (argv)");
    }
  });

  it("repo.test_selection: absent is off, this repo's hubs and always lists load, a bad value fails startup naming the key", async () => {
    const { test_selection, ...repo } = REAL.repo as Record<string, unknown>;
    expect(test_selection).toBeDefined();
    expect((await loadConfig(root({ ...REAL, repo }))).config.repo.test_selection).toBeUndefined();
    const set = await loadConfig(root(REAL));
    expect(set.config.repo.test_selection).toEqual(test_selection);
    for (const bad of [[], { hubs: ["src/"], always: [] }, { hubs: [], always: ["/abs/"] }, { hubs: [], always: [], extra: 1 }]) {
      const err = await loadError({ ...REAL, repo: { ...repo, test_selection: bad } });
      expect(err.message, JSON.stringify(bad)).toContain("repo.test_selection");
    }
  });

  it("repo.test_selection needs an npm repo.test_command: a Gradle command with it fails startup, without it loads", async () => {
    const { test_selection, ...repo } = REAL.repo as Record<string, unknown>;
    const gradle = ["./gradlew", "test"];
    const err = await loadError({ ...REAL, repo: { ...repo, test_command: gradle, test_selection } });
    expect(err.message).toContain("repo.test_selection");
    expect(err.message).toContain("needs an npm test command");
    const plain = await loadConfig(root({ ...REAL, repo: { ...repo, test_command: gradle } }));
    expect(plain.config.repo.test_command).toEqual(gradle);
    expect(plain.config.repo.test_selection).toBeUndefined();
    const npm = await loadConfig(root({ ...REAL, repo: { ...repo, test_command: ["npm", "test"], test_selection } }));
    expect(npm.config.repo.test_selection).toEqual(test_selection);
  });

  it('a sqlite store with the key "host" fails', async () => {
    const err = await loadError({ ...REAL, store: { type: "sqlite", host: "localhost" } });
    expect(err.message).toContain("store.host");
  });

  it("an invalid store type skips the store key check, so the plugin error reports it", async () => {
    const err = await loadError({ ...REAL, store: { type: "postgres", hots: "x" } });
    expect(err.message).toMatch(/unknown FactoryStore plugin "postgres"/);
    expect(err.message).not.toContain("store.hots");
  });

  it("two or more unknown keys are all reported in one error", async () => {
    const err = (await loadError({
      ...SQLITE,
      zebra: 1,
      repo: { ...(REAL.repo as object), ownr: "x" },
      ui: { prot: 1 },
    })) as ConfigKeyError;
    expect(err.problems).toHaveLength(3);
    expect(err.message).toContain('"zebra"');
    expect(err.message).toContain("repo.ownr");
    expect(err.message).toContain("ui.prot");
  });

  it("the checked-in factory.config.json loads", async () => {
    const loaded = await loadConfig(root(REAL));
    expect(loaded.file).toEqual(REAL);
    expect(loaded.store).toEqual({ type: "sqlite" });
    expect(loaded.config.repo.owner).toBe("seonWKim");
  });
});

const ME: CliIdentity = { user: "local:me@example.com" as UserId, from: "git user.email" };

describe("config keys: ui.user_id (issue #227)", () => {
  it("is optional: the checked-in config does not set it, and without it the page's commands have no actor", async () => {
    expect(REAL.ui === undefined || !Object.hasOwn(REAL.ui as object, "user_id")).toBe(true);
    expect(uiUserId(undefined)).toBeNull();
    expect(uiUserId({ port: 4310 })).toBeNull();
  });

  it("absent, the loopback page's commands act as the CLI identity from the environment", async () => {
    const parts = await buildUiParts(await loadConfig(root(SQLITE)), { identity: ME });
    try {
      expect(parts.commands).toMatchObject({ actor: ME.user, source: "environment" });
    } finally {
      await parts.close();
    }
  });

  it("a non-empty string loads and is the commands actor", async () => {
    const loaded = await loadConfig(root({ ...SQLITE, ui: { user_id: "github:7" } }));
    expect(uiUserId(loaded.file.ui)).toBe("github:7");
  });

  it("an empty or non-string value stops startup with an error naming the key", async () => {
    for (const user_id of ["", "   ", 7, true, null, [], {}]) {
      const err = await loadError({ ...SQLITE, ui: { user_id } });
      expect(err.message, JSON.stringify(user_id)).toContain("ui.user_id");
    }
  });

  it("each UI process makes its own random token, shared by both write routes and not in the store or on disk", async () => {
    const dir = root({ ...SQLITE, ui: { user_id: "github:7" } });
    const loaded = await loadConfig(dir);
    const first = await buildUiParts(loaded, { identity: ME });
    let second: Awaited<ReturnType<typeof buildUiParts>> | undefined;
    try {
      // ui.user_id overrides the environment's identity.
      expect(first.commands).toMatchObject({ actor: "github:7", source: "config" });
      expect(first.commands.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(first.commands.token).toBe(first.settings.csrfToken);
      second = await buildUiParts(loaded, { identity: ME });
      expect(second.commands.token).not.toBe(first.commands.token);
      const tables = await first.store.listTables();
      for (const t of tables) {
        const page = await first.store.listTableRows({ table: t.name, limit: 200 });
        expect(JSON.stringify(page), t.name).not.toContain(first.commands.token);
      }
    } finally {
      await first.close();
      await second?.close();
    }
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(dir)) {
      expect(readFileSync(f).includes(first.commands.token), f).toBe(false);
      expect(readFileSync(f).includes(second!.commands.token), f).toBe(false);
    }
  });
});

describe("config keys: packs (design 11-packs.md)", () => {
  it("is a top-level key, and the checked-in config, which has none, loads", async () => {
    expect(TOP_LEVEL_KEYS).toContain("packs");
    expect(REAL).not.toHaveProperty("packs");
    await expect(loadConfig(root(SQLITE))).resolves.toBeTruthy();
  });

  it("an unknown key inside packs names its path; a bad order or org names its key", async () => {
    expect((await loadError({ ...SQLITE, packs: { ordr: [] } })).message).toContain('unknown config key "ordr" at packs.ordr; valid packs keys: order, org, auto_approve_read_only; did you mean "order"?');
    expect((await loadError({ ...SQLITE, packs: { order: ["base", "org", "learned"] } })).message).toContain('packs.order leaves out the layer "project"');
    expect((await loadError({ ...SQLITE, packs: { org: "" } })).message).toContain("packs.org must be a non-empty path");
    expect((await loadError({ ...SQLITE, packs: "org" })).message).toContain("packs must be an object");
  });
});

describe("config keys: chat_eval (design 04-chat-agent)", () => {
  it("is a top-level key: the checked-in config sets chat_eval.schedule to daily and loads", async () => {
    expect(TOP_LEVEL_KEYS).toContain("chat_eval");
    expect(REAL.chat_eval).toEqual({ schedule: "daily" });
    await expect(loadConfig(root(SQLITE))).resolves.toBeTruthy();
  });

  it("an absent block loads; an unknown key or a schedule other than daily fails naming its path", async () => {
    const without: Record<string, unknown> = { ...SQLITE };
    delete without.chat_eval;
    await expect(loadConfig(root(without))).resolves.toBeTruthy();
    expect((await loadError({ ...SQLITE, chat_eval: { schedul: "daily" } })).message).toContain('unknown config key "schedul" at chat_eval.schedul; valid chat_eval keys: schedule; did you mean "schedule"?');
    expect((await loadError({ ...SQLITE, chat_eval: { schedule: "hourly" } })).message).toContain("chat_eval.schedule must be one of daily");
    expect((await loadError({ ...SQLITE, chat_eval: "daily" })).message).toContain("chat_eval must be an object");
  });
});

describe("config keys: defaults and projects", () => {
  const ID = "seonWKim/software-factory";
  const PROJECT_KEYS = ["max_attempts", "max_diff_lines", "max_diff_files", "budgets", "floors"];

  it("an unknown key inside a project names the project and the key, lists the project keys and suggests", async () => {
    const err = await loadError({ ...REAL, projects: { [ID]: { max_dif_lines: 10 } } });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toBe(
      `unknown config key "max_dif_lines" at projects["${ID}"].max_dif_lines; valid project "${ID}" keys: ${PROJECT_KEYS.join(", ")}; did you mean "max_diff_lines"?`,
    );
  });

  it("a far-off key inside a project gets no suggestion", async () => {
    const err = await loadError({ ...REAL, projects: { [ID]: { zebra: 1 } } });
    expect(err.message).toContain(`projects["${ID}"].zebra`);
    expect(err.message).not.toContain("did you mean");
  });

  it("an unknown key inside defaults fails against the project keys", async () => {
    const err = await loadError({ ...REAL, defaults: { workers: 2 } });
    expect(err.message).toContain(`unknown config key "workers" at defaults.workers; valid defaults keys: ${PROJECT_KEYS.join(", ")}`);
  });

  it("unknown keys at top level and inside a project are all reported in one error, before the project ID check", async () => {
    const err = (await loadError({ ...SQLITE, zebra: 1, projects: { "other/repo": { dials: {} } } })) as ConfigKeyError;
    expect(err.problems).toHaveLength(2);
    expect(err.message).toContain('"zebra"');
    expect(err.message).toContain('projects["other/repo"].dials');
  });
});

describe("config keys: suggestions", () => {
  it("edit distance", () => {
    expect(editDistance("hots", "host")).toBe(2);
    expect(editDistance("plugin", "plugins")).toBe(1);
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("same", "same")).toBe(0);
  });

  it("suggests only within edit distance 2", () => {
    expect(closestKey("hots", ["type", "host", "port"])).toBe("host");
    expect(closestKey("tiar", ["prefix", "tier"])).toBe("tier");
    expect(closestKey("zebra", TOP_LEVEL_KEYS)).toBeUndefined();
    expect(closestKey("hostxyz", ["host"])).toBeUndefined();
  });
});

describe("config keys: doctor output", () => {
  it("one FAIL line per problem, with the error's text and no stack", async () => {
    const err = await loadError({ ...SQLITE, zebra: 1, ui: { prot: 1 } });
    const lines = configFailLines(err);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.replace(/^FAIL {2}/, ""))).toEqual(err.message.split("\n"));
    for (const l of lines) {
      expect(l).toMatch(/^FAIL {2}/);
      expect(l).not.toMatch(/\n|\bat .*\.ts:\d+/);
    }
  });

  it("any other load error is one FAIL line", () => {
    expect(configFailLines(new Error("tiers must be integers 1–5"))).toEqual(["FAIL  tiers must be integers 1–5"]);
  });
});

describe("coordination config (design §5, 2026-11-03)", () => {
  it("max_coordination_cost is read from factory.config.json: the checked-in value is 2.5, the default", async () => {
    const { coordinationConfig } = await import("../src/core/config.js");
    expect(REAL.max_coordination_cost).toBe(2.5);
    expect(coordinationConfig(REAL)).toMatchObject({ max_cost: 2.5, hotspot_weight: 3 });
    expect(coordinationConfig({ ...REAL, max_coordination_cost: 4 }).max_cost).toBe(4);
    expect(coordinationConfig({}).max_cost).toBe(2.5);
  });

  it.each([0, -1, "2.5", null, true])("max_coordination_cost %j fails at startup, like other numeric keys", async (value) => {
    const err = await loadError({ ...SQLITE, max_coordination_cost: value });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("max_coordination_cost must be a number above 0");
  });

  it("hotspot_weight and hotspot_paths are checked at startup too", async () => {
    expect((await loadError({ ...SQLITE, hotspot_weight: 0 })).message).toContain("hotspot_weight must be a number above 0");
    expect((await loadError({ ...SQLITE, hotspot_paths: ["ok", ""] })).message).toContain("hotspot_paths must be a list of non-empty paths");
  });

  it("mechanical_paths and mechanical_weight load with their defaults, and compose passes them into the coordination config", async () => {
    const { coordinationConfig } = await import("../src/core/config.js");
    const { DEFAULT_MECHANICAL } = await import("../src/core/coordination.js");
    const defaults = ["docs/design/", "docs/design.md", "docs/plugins.md", "docs/plugins/"];
    expect(DEFAULT_MECHANICAL).toEqual(defaults);
    expect(coordinationConfig({})).toMatchObject({ mechanical: defaults, mechanical_weight: 0.25 });
    expect(REAL).toMatchObject({ mechanical_paths: defaults, mechanical_weight: 0.25 });
    expect(TOP_LEVEL_KEYS).toEqual(expect.arrayContaining(["mechanical_paths", "mechanical_weight"]));
    const loaded = await loadConfig(root(SQLITE));
    expect(loaded.config.coordination).toMatchObject({ max_cost: 2.5, hotspot_weight: 3, mechanical: defaults, mechanical_weight: 0.25 });
    const custom = await loadConfig(root({ ...SQLITE, mechanical_paths: ["gen/"], mechanical_weight: 0.5, max_coordination_cost: 4 }));
    expect(custom.config.coordination).toMatchObject({ max_cost: 4, mechanical: ["gen/"], mechanical_weight: 0.5 });
  });

  it.each([0, 1, 1.5, -0.25, "0.25", null])("mechanical_weight %j fails at startup: it must be above 0 and below 1.0", async (value) => {
    const err = await loadError({ ...SQLITE, mechanical_weight: value });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("mechanical_weight must be a number above 0 and below 1.0");
  });

  it("mechanical_paths must be a list of non-empty paths", async () => {
    expect((await loadError({ ...SQLITE, mechanical_paths: ["ok", ""] })).message).toContain("mechanical_paths must be a list of non-empty paths");
    expect((await loadError({ ...SQLITE, mechanical_paths: "docs/" })).message).toContain("mechanical_paths must be a list of non-empty paths");
  });

  it("conflict_window_days defaults to 3 and is read from factory.config.json", async () => {
    const { coordinationConfig } = await import("../src/core/config.js");
    expect(TOP_LEVEL_KEYS).toContain("conflict_window_days");
    expect(coordinationConfig({}).conflict_window_days).toBe(3);
    expect((await loadConfig(root(SQLITE))).config.coordination).toMatchObject({ conflict_window_days: 3 });
    const custom = await loadConfig(root({ ...SQLITE, conflict_window_days: 7 }));
    expect(custom.config.coordination).toMatchObject({ conflict_window_days: 7 });
  });

  it.each([0, -1, 1.5, "3", null])("conflict_window_days %j fails at startup: it must be a positive integer", async (value) => {
    const err = await loadError({ ...SQLITE, conflict_window_days: value });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("conflict_window_days must be a positive integer");
  });
});

describe("config keys: openai_compatible", () => {
  const MODELS = { cheap: "small-1", standard: "mid-1", strong: "big-1" };
  const BLOCK = { base_url: "https://api.example.test/v1", models: MODELS };
  const withBlock = (block: unknown) => ({ ...SQLITE, openai_compatible: block });

  it("a valid block loads", async () => {
    await expect(loadConfig(root(withBlock(BLOCK)))).resolves.toBeTruthy();
  });

  it("a misspelled key in the block names its full path and the valid keys", async () => {
    const err = await loadError(withBlock({ base_ul: BLOCK.base_url, base_url: BLOCK.base_url, models: MODELS }));
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("openai_compatible.base_ul");
    expect(err.message).toContain("valid openai_compatible keys: base_url, models");
    expect(err.message).toContain('did you mean "base_url"?');
  });

  it("a misspelled key in models names its path", async () => {
    const err = await loadError(withBlock({ ...BLOCK, models: { ...MODELS, strnog: "x" } }));
    expect(err.message).toContain("openai_compatible.models.strnog");
    expect(err.message).toContain("cheap, standard, strong");
  });

  it("a missing base_url names openai_compatible.base_url", async () => {
    const err = await loadError(withBlock({ models: MODELS }));
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("openai_compatible.base_url is required");
  });

  it.each(["not a url", "://nope", "ftp://api.example.test/v1", "file:///etc/x", 42, ""])(
    "base_url %j fails and names openai_compatible.base_url",
    async (base_url) => {
      const err = await loadError(withBlock({ ...BLOCK, base_url }));
      expect(err.message).toContain("openai_compatible.base_url");
    },
  );

  it.each(["http://api.example.test/v1", "http://10.0.0.5:8080/v1", "http://127.0.0.2/v1", "http://localhost.example.test/v1"])(
    "plain http to a non-loopback host %s fails",
    async (base_url) => {
      const err = await loadError(withBlock({ ...BLOCK, base_url }));
      expect(err.message).toContain("openai_compatible.base_url");
      expect(err.message).toContain("https");
    },
  );

  it.each(["https://api.example.test/v1", "https://10.0.0.5/v1", "http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])(
    "%s passes",
    async (base_url) => {
      await expect(loadConfig(root(withBlock({ ...BLOCK, base_url })))).resolves.toBeTruthy();
    },
  );

  it.each(["cheap", "standard", "strong"] as const)("models without %s names the missing one", async (missing) => {
    const { [missing]: _, ...rest } = MODELS;
    const err = await loadError(withBlock({ ...BLOCK, models: rest }));
    expect(err.message).toContain(`openai_compatible.models.${missing}`);
  });

  it("a missing models block fails", async () => {
    const err = await loadError(withBlock({ base_url: BLOCK.base_url }));
    expect(err.message).toContain("openai_compatible.models");
  });
});

describe("config keys: path_companions (design 04-triage.md)", () => {
  it("a config that sets it loads without an unknown-key error", async () => {
    const loaded = await loadConfig(root({ ...SQLITE, path_companions: [{ when: "src/a.ts", also: ["docs/a/"] }] }));
    expect(loaded.config.path_companions).toEqual([{ when: "src/a.ts", also: ["docs/a/"] }]);
  });

  it("an absent key loads with no companions", async () => {
    const rest: Record<string, unknown> = { ...SQLITE };
    delete rest.path_companions;
    expect((await loadConfig(root(rest))).config.path_companions).toEqual([]);
  });

  it("a bad entry and an unknown key inside an entry fail with the key and the entry index, in one error", async () => {
    const err = await loadError({ ...SQLITE, path_companions: [{ when: "src/a.ts", also: ["b"] }, { when: "", also: ["b"], extra: 1 }] });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("path_companions[1].when");
    expect(err.message).toContain('path_companions[1] has unknown key "extra"');
    expect(err.message).not.toContain("path_companions[0]");
  });
});

describe("github.history_since (design §5, Merges)", () => {
  it("is accepted in the github block, as a date or a UTC time", async () => {
    await expect(loadConfig(root({ ...SQLITE, github: { history_since: "2026-01-01" } }))).resolves.toBeTruthy();
    await expect(loadConfig(root({ ...SQLITE, github: { history_since: "2026-01-01T12:30:00Z" } }))).resolves.toBeTruthy();
  });

  it("an invalid value fails at startup, naming the setting", async () => {
    for (const history_since of ["last week", "2026-13-45", 20260101, "2026-01-01 00:00"]) {
      const err = await loadError({ ...SQLITE, github: { history_since } });
      expect(err.message).toContain("github.history_since");
    }
  });
});

describe("github.budget_share (design §5 Sources, GitHub call budget)", () => {
  it("is accepted in the github block next to min_remaining", async () => {
    await expect(loadConfig(root({ ...SQLITE, github: { min_remaining: 200, budget_share: 0.5 } }))).resolves.toBeTruthy();
    await expect(loadConfig(root({ ...SQLITE, github: { budget_share: 1 } }))).resolves.toBeTruthy();
  });

  it("a value that is not a number greater than 0 and at most 1 fails at startup, naming the key", async () => {
    for (const budget_share of [0, -0.5, 1.5, "0.5", null, true]) {
      const err = await loadError({ ...SQLITE, github: { budget_share } });
      expect(err.message).toContain("github.budget_share");
    }
  });
});

describe("auth_pause_ms (design §5 Restarts, RFC 0010 item 8)", () => {
  it("a set value loads into the core config", async () => {
    const { config } = await loadConfig(root({ ...SQLITE, auth_pause_ms: 300_000 }));
    expect(config.auth_pause_ms).toBe(300_000);
  });

  it("absent, it equals retry_max_ms (1800000 by default)", async () => {
    const { auth_pause_ms: _a, retry_max_ms: _m, ...rest } = SQLITE as Record<string, unknown>;
    const { config } = await loadConfig(root(rest));
    expect(config.auth_pause_ms).toBe(1_800_000);
    expect(config.auth_pause_ms).toBe(config.retry_max_ms);
    const custom = await loadConfig(root({ ...rest, retry_max_ms: 900_000 }));
    expect(custom.config.auth_pause_ms).toBe(900_000);
  });

  it("a value that is not a positive integer fails at load, naming the key", async () => {
    for (const auth_pause_ms of [0, -1, 1.5, "300000", null]) {
      const err = await loadError({ ...SQLITE, auth_pause_ms });
      expect(err.message).toContain("auth_pause_ms");
    }
  });
});

describe("agent_stop_checks (design §4 Pre-push gates, issue #302)", () => {
  it("is a top-level key; absent, it is 3", async () => {
    expect(TOP_LEVEL_KEYS).toContain("agent_stop_checks");
    const { agent_stop_checks: _set, ...rest } = SQLITE as Record<string, unknown>;
    expect((await loadConfig(root(rest))).config.agent_stop_checks).toBe(3);
  });

  it("a positive integer loads; the checked-in config sets it", async () => {
    expect((await loadConfig(root({ ...SQLITE, agent_stop_checks: 7 }))).config.agent_stop_checks).toBe(7);
    expect(typeof REAL.agent_stop_checks).toBe("number");
  });

  it("a value that is not a positive integer fails at startup, naming the key", async () => {
    for (const agent_stop_checks of [0, -1, 1.5, "3", null, true]) {
      const err = await loadError({ ...SQLITE, agent_stop_checks });
      expect(err.message).toContain("agent_stop_checks must be a positive integer");
    }
  });
});

describe("retention (design 08-retention)", () => {
  it("is a top-level key; absent, it gives 30, 30 and 90 days and startup goes on", async () => {
    expect(TOP_LEVEL_KEYS).toContain("retention");
    const { retention: _set, ...rest } = SQLITE as Record<string, unknown>;
    expect((await loadConfig(root(rest))).config.retention).toEqual({ outbox_days: 30, commands_days: 30, records_days: 90, raw_records_days: 7 });
  });

  it("compose passes the set values into the config; an absent key keeps its default; 0 loads", async () => {
    const { config } = await loadConfig(root({ ...SQLITE, retention: { outbox_days: 7, records_days: 0 } }));
    expect(config.retention).toEqual({ outbox_days: 7, commands_days: 30, records_days: 0, raw_records_days: 7 });
  });

  it("an unknown key under retention fails at load with a suggestion", async () => {
    const err = await loadError({ ...SQLITE, retention: { outbox_day: 7 } });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain('unknown config key "outbox_day" at retention.outbox_day');
    expect(err.message).toContain('did you mean "outbox_days"?');
  });

  it("a negative or non-integer value fails at startup, naming the key", async () => {
    for (const [key, value] of [["outbox_days", -1], ["commands_days", 1.5], ["records_days", "90"], ["records_days", null]] as const) {
      const err = await loadError({ ...SQLITE, retention: { [key]: value } });
      expect(err.message).toContain(`retention.${key} must be an integer of 0 or more`);
    }
    expect((await loadError({ ...SQLITE, retention: 30 })).message).toContain("retention must be an object");
  });
});

describe("cleanup (design 08-cleanup)", () => {
  it("is a file-only top-level key; absent, cleanup is on with keep_hours 24", async () => {
    expect(TOP_LEVEL_KEYS).toContain("cleanup");
    const { file } = await loadConfig(root(SQLITE));
    expect(cleanupConfig(file)).toEqual({ enabled: true, keep_hours: 24 });
  });

  it("reads the set values; an absent key keeps its default; keep_hours 0 loads", async () => {
    expect(cleanupConfig((await loadConfig(root({ ...SQLITE, cleanup: { enabled: false } }))).file)).toEqual({ enabled: false, keep_hours: 24 });
    expect(cleanupConfig((await loadConfig(root({ ...SQLITE, cleanup: { keep_hours: 0 } }))).file)).toEqual({ enabled: true, keep_hours: 0 });
  });

  it("keep_hours that is not an integer of 0 or more fails config load, naming the key", async () => {
    for (const keep_hours of [-1, 1.5, "24", null, true]) {
      const err = await loadError({ ...SQLITE, cleanup: { keep_hours } });
      expect(err).toBeInstanceOf(ConfigKeyError);
      expect(err.message).toContain("cleanup.keep_hours must be an integer of 0 or more");
    }
    expect((await loadError({ ...SQLITE, cleanup: { enabled: "yes" } })).message).toContain("cleanup.enabled must be true or false");
    expect((await loadError({ ...SQLITE, cleanup: 24 })).message).toContain("cleanup must be an object");
  });

  it("an unknown key under cleanup fails at load with a suggestion", async () => {
    const err = await loadError({ ...SQLITE, cleanup: { keep_hour: 24 } });
    expect(err.message).toContain('unknown config key "keep_hour" at cleanup.keep_hour');
    expect(err.message).toContain('did you mean "keep_hours"?');
  });
});

describe("golden (design 06-measurement, eval on change)", () => {
  it("is a top-level key; absent, startup succeeds and the gate is off", async () => {
    expect(TOP_LEVEL_KEYS).toContain("golden");
    const { golden: _set, ...rest } = SQLITE as Record<string, unknown>;
    const loaded = await loadConfig(root(rest));
    expect(goldenConfig(loaded.file)).toBeNull();
  });

  it("defaults replays to 1 and regression_margin to 0.05, and loads the values set, 0 and 1 included", async () => {
    await loadConfig(root({ ...SQLITE, golden: {} }));
    expect(goldenConfig({ golden: {} })).toEqual({ replays: 1, regression_margin: 0.05 });
    await loadConfig(root({ ...SQLITE, golden: { replays: 5, regression_margin: 0 } }));
    expect(goldenConfig({ golden: { replays: 5, regression_margin: 0 } })).toEqual({ replays: 5, regression_margin: 0 });
    expect(goldenConfig({ golden: { regression_margin: 1 } })).toEqual({ replays: 1, regression_margin: 1 });
  });

  it("fails startup on any other value", async () => {
    const bad = [
      { replays: 0 }, { replays: -1 }, { replays: 1.5 }, { replays: "2" }, { replays: null },
      { regression_margin: -0.01 }, { regression_margin: 1.01 }, { regression_margin: "0.1" }, { regression_margin: null },
    ];
    for (const golden of [...bad, "on", [], null, 3]) {
      const err = await loadError({ ...SQLITE, golden });
      expect(err, JSON.stringify(golden)).toBeInstanceOf(ConfigKeyError);
      expect(err.message).toContain("golden must be an object whose replays is an integer ≥ 1 (default 1) and whose regression_margin is a number from 0 to 1");
      expect(() => goldenConfig({ golden })).toThrow(/golden must be an object/);
    }
  });

  it("an unknown key under golden fails at load with a suggestion", async () => {
    const err = await loadError({ ...SQLITE, golden: { replay: 3 } });
    expect(err.message).toContain('unknown config key "replay" at golden.replay');
    expect(err.message).toContain('did you mean "replays"?');
  });
});

describe("repo.check_tz (design §4, the merge check's time zone)", () => {
  const REPO = REAL.repo as Record<string, unknown>;
  const withTz = (value: unknown) => ({ ...SQLITE, repo: { ...REPO, check_tz: value } });

  it("absent: off, nothing set", async () => {
    const { check_tz: _, ...repo } = REPO;
    expect((await loadConfig(root({ ...SQLITE, repo }))).config.repo).not.toHaveProperty("check_tz");
  });

  it("an IANA zone name loads; the checked-in config sets UTC", async () => {
    for (const zone of ["UTC", "Asia/Seoul", "America/New_York", "Etc/GMT+9"]) {
      expect((await loadConfig(root(withTz(zone)))).config.repo.check_tz).toBe(zone);
    }
    expect(REPO.check_tz).toBe("UTC");
  });

  it("a value that is not a known IANA zone fails at startup, naming the key", async () => {
    for (const value of ["Mars/Olympus", "", "+09:00", "-05:00", "utc ", 9, null, ["UTC"], { zone: "UTC" }]) {
      const err = await loadError(withTz(value));
      expect(err.message, JSON.stringify(value)).toContain("repo.check_tz must be an IANA time zone name");
    }
  });

  it("check_tz is a known repo key", async () => {
    const err = await loadError({ ...SQLITE, repo: { ...REPO, check_zt: "UTC" } });
    expect(err.message).toMatch(/did you mean "check_tz"/);
  });
});

describe("skill improvement keys (design 07-self-improvement)", () => {
  it("the six keys have the decided defaults in src/core/config.ts", () => {
    expect(SKILL_IMPROVE_DEFAULTS).toEqual({
      skill_improve_drop_margin: 0.05,
      skill_improve_stall_runs: 3,
      skill_improve_target: 0.9,
      skill_improve_noise: 0.02,
      skill_drafts_per_day: 3,
      skill_draft_token_budget: 50000,
    });
    expect([...SKILL_IMPROVE_KEYS].sort()).toEqual(Object.keys(SKILL_IMPROVE_DEFAULTS).sort());
  });

  it("each is a listed top-level key, so a config setting all six loads without an unknown-key error", async () => {
    for (const k of SKILL_IMPROVE_KEYS) expect(TOP_LEVEL_KEYS, k).toContain(k);
    const config = { ...REAL, store: { type: "sqlite" }, ...SKILL_IMPROVE_DEFAULTS };
    await expect(loadConfig(root(config))).resolves.toBeDefined();
  });

  it("skill folders reuse capabilities.skill_folders: no skill_folders top-level key", async () => {
    expect(TOP_LEVEL_KEYS).not.toContain("skill_folders");
    expect(TOP_LEVEL_KEYS).toContain("capabilities");
    const err = await loadError({ ...REAL, store: { type: "sqlite" }, skill_folders: ["skills"] });
    expect(err).toBeInstanceOf(ConfigKeyError);
    expect(err.message).toContain("skill_folders");
  });
});

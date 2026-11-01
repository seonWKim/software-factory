import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/compose.js";
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
  writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
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

  it('a mysql store with "hots" names store.hots, lists the store keys and suggests "host"', async () => {
    const store = { ...(REAL.store as object), hots: "db" };
    const err = await loadError({ ...REAL, store });
    expect(err.message).toContain("store.hots");
    for (const k of STORE_KEYS.mysql!) expect(err.message).toContain(k);
    expect(err.message).toContain('did you mean "host"?');
  });

  it("an unknown key inside a floors entry names the path with the index", async () => {
    const floors = [{ prefix: "a/", tiar: 3 }, ...(REAL.floors as object[])];
    const err = await loadError({ ...REAL, floors });
    expect(err.message).toContain("floors[0].tiar");
    expect(err.message).toContain('did you mean "tier"?');
  });

  const nested: [string, string, string[]][] = [
    ["repo", "repo.zzzzzz", ["owner", "name", "path", "base_branch", "install_command", "test_command"]],
    ["dials", "dials.zzzzzz", ["spec_gate_min_tier", "auto_merge_max_tier"]],
    ["models", "models.zzzzzz", ["cheap", "strong"]],
    ["agent_git_identity", "agent_git_identity.zzzzzz", ["name", "email"]],
    ["ui", "ui.zzzzzz", ["port"]],
  ];
  for (const [block, path, keys] of nested) {
    it(`an unknown key inside ${block} fails against ${block}'s own keys`, async () => {
      const err = await loadError({ ...REAL, [block]: { ...(REAL[block] as object), zzzzzz: 1 } });
      expect(err.message).toContain(path);
      expect(err.message).toContain(`valid ${block} keys: ${keys.join(", ")}`);
    });
  }

  it('a sqlite store with the mysql-only key "host" fails', async () => {
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
    expect(loaded.store.type).toBe("mysql");
    expect(loaded.config.repo.owner).toBe("seonWKim");
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

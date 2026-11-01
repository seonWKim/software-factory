import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Plugins, build, loadConfig } from "../src/compose.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { EnvFileSecretStore } from "../src/impl/secrets/env-file-secret-store.js";
import { type Secret, type SecretName, type SecretStore, secretName } from "../src/interfaces/secret-store.js";
import type { SourceAdapter } from "../src/interfaces/source-adapter.js";
import {
  PLUGIN_KINDS,
  REGISTRY,
  type Registry,
  type SecretDeclaration,
  declaredSecretNames,
  declaredSecrets,
  selectPlugins,
  withPlugin,
} from "../src/plugins.js";
import { doctorChecks, ensureSecretFile, secretChecks, secretsToPrompt } from "../src/setup.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const n = secretName;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** A throwaway repo root with its own config, prompts, state dir and secret file (mode 600). */
function root(config: Record<string, unknown>, secrets: string): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-secret-names-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  const secretsDir = mkdtempSync(join(tmpdir(), "sf-secret-names-cfg-"));
  writeFileSync(join(secretsDir, ".env"), secrets, { mode: 0o600 });
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(secretsDir, ".env"));
  return dir;
}

const sorted = (names: Iterable<string>) => [...names].sort();

describe("secretName()", () => {
  it("accepts upper-case names with digits and underscores", () => {
    for (const ok of ["SLACK_BOT_TOKEN", "GITHUB_TOKEN", "A", "DB2_PASSWORD", "X_"]) {
      const name: SecretName = secretName(ok);
      expect(name).toBe(ok);
    }
  });

  it("throws for lower-case letters, empty strings, spaces, hyphens and a leading digit", () => {
    for (const bad of ["slack_bot_token", "Slack_Token", "", " ", "SLACK BOT", "SLACK-BOT-TOKEN", "1_TOKEN", "9", "_TOKEN"]) {
      expect(() => secretName(bad), JSON.stringify(bad)).toThrow(/not a secret name/);
    }
  });
});

describe("registry: each plugin declares its secrets", () => {
  const names = (kind: keyof Registry, plugin: string) => sorted(REGISTRY[kind].secrets[plugin]!.map((d) => d.name));

  it("every registered plugin has a declaration list, and nothing else does", () => {
    for (const kind of PLUGIN_KINDS) {
      expect(sorted(Object.keys(REGISTRY[kind].secrets)), kind).toEqual(sorted(Object.keys(REGISTRY[kind].plugins)));
    }
  });

  it("each declaration has a one-line purpose", () => {
    for (const kind of PLUGIN_KINDS) {
      for (const [plugin, decls] of Object.entries(REGISTRY[kind].secrets)) {
        for (const d of decls) {
          expect(d.purpose.trim(), `${kind}.${plugin} ${d.name}`).not.toBe("");
          expect(d.purpose, `${kind}.${plugin} ${d.name}`).not.toContain("\n");
        }
      }
    }
  });

  it("names the secrets each plugin reads", () => {
    expect(names("broker", "github")).toEqual(["GITHUB_TOKEN"]);
    expect(names("store", "mysql")).toEqual(["MYSQL_PASSWORD"]);
    expect(names("store", "sqlite")).toEqual([]);
    expect(names("runner", "claude-code")).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(names("llm", "claude-cli")).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    expect(names("source", "github-issues")).toEqual(["GITHUB_TOKEN"]);
    expect(names("auth", "github")).toEqual(["GITHUB_TOKEN"]);
    expect(names("auth", "none")).toEqual([]);
    expect(names("secrets", "env-file")).toEqual([]);
  });

  it("withPlugin without a secrets list still works and declares none", () => {
    const r = withPlugin(REGISTRY, "clock", "test-clock", () => new FakeClock());
    expect(r.clock.secrets["test-clock"]).toEqual([]);
    expect(r.clock.secrets.system).toEqual([]);
  });
});

describe("the secret set is the union of the selected plugins' declarations", () => {
  it("default config: the model credential, GITHUB_TOKEN and MYSQL_PASSWORD", async () => {
    const loaded = await loadConfig(root(REAL, ""), { platform: "linux" });
    expect(sorted(declaredSecretNames(loaded.registry, loaded.plugins))).toEqual([
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
      "MYSQL_PASSWORD",
    ]);
  });

  it("switching store.type from mysql to sqlite removes MYSQL_PASSWORD, with no code edit", async () => {
    const file = "MYSQL_PASSWORD=mysql-pw-value\nGITHUB_TOKEN=gh-value\n";
    const mysql = await loadConfig(root(REAL, file), { platform: "linux" });
    expect(declaredSecretNames(mysql.registry, mysql.plugins).has(n("MYSQL_PASSWORD"))).toBe(true);
    const mysqlSecrets = await new Plugins(mysql).secrets();
    expect((await mysqlSecrets.get(n("MYSQL_PASSWORD")))?.reveal()).toBe("mysql-pw-value");
    expect(await mysqlSecrets.valuesForScan()).toContain("mysql-pw-value");

    const sqlite = await loadConfig(root({ ...REAL, store: { type: "sqlite" } }, file), { platform: "linux" });
    expect(declaredSecretNames(sqlite.registry, sqlite.plugins).has(n("MYSQL_PASSWORD"))).toBe(false);
    const sqliteSecrets = await new Plugins(sqlite).secrets();
    expect(await sqliteSecrets.get(n("MYSQL_PASSWORD"))).toBeNull();
    expect(await sqliteSecrets.valuesForScan()).not.toContain("mysql-pw-value");
    expect(await sqliteSecrets.valuesForScan()).toContain("gh-value");
  });

  it("a name declared by several plugins appears once, with each purpose", () => {
    const sel = selectPlugins(REGISTRY, { store: { type: "sqlite" }, auth: "github" }, { platform: "linux" });
    const gh = declaredSecrets(REGISTRY, sel).filter((d) => d.name === "GITHUB_TOKEN");
    expect(gh).toHaveLength(1);
    for (const plugin of [REGISTRY.broker.secrets.github!, REGISTRY.source.secrets["github-issues"]!, REGISTRY.auth.secrets.github!]) {
      expect(gh[0]!.purpose).toContain(plugin[0]!.purpose);
    }
  });
});

describe("env-file store: only declared names", () => {
  const FILE = [
    "GITHUB_TOKEN=gh-value",
    "UNDECLARED_TOKEN=undeclared-value",
    "MYSQL_HOST=db.internal",
    "MYSQL_USER=factory",
    "MYSQL_PASSWORD=mysql-pw-value",
    "",
  ].join("\n");

  it("a key no selected plugin declares is not returned by get and not in valuesForScan", async () => {
    const loaded = await loadConfig(root(REAL, FILE), { platform: "linux" });
    const secrets = await new Plugins(loaded).secrets();
    expect(await secrets.get(n("UNDECLARED_TOKEN"))).toBeNull();
    expect(await secrets.valuesForScan()).not.toContain("undeclared-value");
    expect(await secrets.valuesForScan()).toContain("gh-value");
  });

  it("a plain setting such as MYSQL_HOST is not returned by get and not in valuesForScan", async () => {
    const loaded = await loadConfig(root(REAL, FILE), { platform: "linux" });
    expect(loaded.store).toMatchObject({ type: "mysql", host: "db.internal" }); // still read as a setting
    const secrets = await new Plugins(loaded).secrets();
    expect(await secrets.get(n("MYSQL_HOST"))).toBeNull();
    expect(await secrets.get(n("MYSQL_USER"))).toBeNull();
    const scan = await secrets.valuesForScan();
    expect(scan).not.toContain("db.internal");
    expect(scan).not.toContain("factory");
    expect(scan).toContain("mysql-pw-value");
  });

  it("with no declared names it loads nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-env-"));
    writeFileSync(join(dir, ".env"), FILE);
    const store = new EnvFileSecretStore(join(dir, ".env"));
    expect(await store.valuesForScan()).toEqual([]);
    expect(await store.get(n("GITHUB_TOKEN"))).toBeNull();
  });
});

describe("a plugin brings its own secret (TEST_GATEWAY_TOKEN)", () => {
  const GATEWAY: readonly SecretDeclaration[] = [{ name: n("TEST_GATEWAY_TOKEN"), purpose: "calls the test gateway" }];
  const fakeSource = {} as SourceAdapter;
  const registry = withPlugin(REGISTRY, "source", "test-gateway", () => fakeSource, GATEWAY);
  const config = {
    ...REAL,
    store: { type: "sqlite" },
    auth: "none",
    plugins: { ...(REAL.plugins as object), source: "test-gateway", awake: "none" },
  };

  it("its value is returned by get and appears in valuesForScan", async () => {
    const loaded = await loadConfig(root(config, "TEST_GATEWAY_TOKEN=gateway-value-123\nGITHUB_TOKEN=gh-value\n"), { registry });
    expect(declaredSecretNames(loaded.registry, loaded.plugins).has(n("TEST_GATEWAY_TOKEN"))).toBe(true);
    const secrets = await new Plugins(loaded).secrets();
    expect((await secrets.get(n("TEST_GATEWAY_TOKEN")))?.reveal()).toBe("gateway-value-123");
    expect(await secrets.valuesForScan()).toContain("gateway-value-123");
  });

  it("is not loaded when the plugin is not selected", async () => {
    const loaded = await loadConfig(root({ ...config, plugins: { ...(REAL.plugins as object), awake: "none" } }, "TEST_GATEWAY_TOKEN=gateway-value-123\n"), {
      registry,
    });
    const secrets = await new Plugins(loaded).secrets();
    expect(await secrets.get(n("TEST_GATEWAY_TOKEN"))).toBeNull();
    expect(await secrets.valuesForScan()).not.toContain("gateway-value-123");
  });

  it("missing from the file does not fail startup; doctor reports it as FAIL with a hint to run setup", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const loaded = await loadConfig(root(config, "# nothing here yet\n"), { registry });
    const built = await build(loaded, { clock: new FakeClock() });
    await built.close();

    const checks = await doctorChecks(loaded);
    const gateway = checks.find((c) => c.msg.includes("TEST_GATEWAY_TOKEN"));
    expect(gateway).toBeDefined();
    expect(gateway!.ok).toBe(false);
    expect(gateway!.warn).toBeFalsy();
    expect(gateway!.msg).toMatch(/npm run setup/);
    expect(gateway!.msg).toContain("calls the test gateway");
  });
});

class MapSecrets implements SecretStore {
  constructor(private readonly values: Record<string, string>) {}
  async get(name: SecretName): Promise<Secret | null> {
    const v = this.values[name];
    return v === undefined ? null : { name, reveal: () => v, toJSON: () => `[secret ${name}]` };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.values(this.values);
  }
}

describe("doctor and setup follow the declared secrets", () => {
  const DECLS: SecretDeclaration[] = [
    { name: n("CLAUDE_CODE_OAUTH_TOKEN"), purpose: "oauth", oneOf: "model credential" },
    { name: n("ANTHROPIC_API_KEY"), purpose: "api key", oneOf: "model credential" },
    { name: n("GITHUB_TOKEN"), purpose: "github" },
    { name: n("SLACK_BOT_TOKEN"), purpose: "posts to Slack" },
  ];

  it("secretChecks: one check per name, one per oneOf group, missing ones FAIL with the setup hint", async () => {
    const checks = await secretChecks(DECLS, new MapSecrets({ ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "g" }));
    expect(checks).toEqual([
      { ok: true, msg: "model credential present (ANTHROPIC_API_KEY)" },
      { ok: true, msg: "GITHUB_TOKEN present" },
      { ok: false, msg: "SLACK_BOT_TOKEN missing: posts to Slack (run: npm run setup)" },
    ]);
    const none = await secretChecks(DECLS, new MapSecrets({}));
    expect(none[0]).toEqual({
      ok: false,
      msg: "model credential missing: one of CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY (run: npm run setup)",
    });
    expect(JSON.stringify(checks)).not.toMatch(/"k"|"g"/);
  });

  it("setup prompts for a declared secret with no guided step when it is missing or rotated", async () => {
    expect((await secretsToPrompt(DECLS, new MapSecrets({}), [])).map((d) => d.name)).toEqual(["SLACK_BOT_TOKEN"]);
    expect(await secretsToPrompt(DECLS, new MapSecrets({ SLACK_BOT_TOKEN: "s" }), [])).toEqual([]);
    expect((await secretsToPrompt(DECLS, new MapSecrets({ SLACK_BOT_TOKEN: "s" }), [n("SLACK_BOT_TOKEN")])).map((d) => d.name)).toEqual([
      "SLACK_BOT_TOKEN",
    ]);
  });

  it("setup adds every declared name the secret file lacks, empty, keeping values", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dir = mkdtempSync(join(tmpdir(), "sf-setup-declared-"));
    writeFileSync(join(dir, "template"), "GITHUB_TOKEN=\n");
    const file = join(dir, "cfg", ".env");
    await ensureSecretFile(file, join(dir, "template"), [n("GITHUB_TOKEN"), n("SLACK_BOT_TOKEN")]);
    expect(readFileSync(file, "utf8")).toBe("GITHUB_TOKEN=\nSLACK_BOT_TOKEN=\n");
  });
});

describe("docs and template follow the declarations", () => {
  const doc = readFileSync(join(REPO_ROOT, "docs", "plugins.md"), "utf8");

  /** The text from an interface's `## Name` heading to the next `## ` heading. */
  const section = (name: string): string => {
    const m = doc.match(new RegExp(`^## ${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
    if (!m) throw new Error(`no ## ${name} section`);
    return m[1]!;
  };

  /** A plugin's bullet: its `- \`name\`:` line and the indented lines under it. */
  const bullet = (sectionText: string, plugin: string): string => {
    const lines = sectionText.split("\n");
    const start = lines.findIndex((l) => l.startsWith(`- \`${plugin}\`:`));
    if (start < 0) throw new Error(`no bullet for ${plugin}`);
    const out = [lines[start]!];
    for (const l of lines.slice(start + 1)) {
      if (!/^\s+\S/.test(l)) break;
      out.push(l);
    }
    return out.join("\n");
  };

  /** Secret names on the `Secrets:` line: backticked upper-case names up to `Settings:` or the line's end. */
  const docSecrets = (bulletText: string): string[] | null => {
    const m = bulletText.match(/Secrets:(.*)$/m);
    if (!m) return null;
    const text = m[1]!.split("Settings:")[0]!;
    return sorted(new Set([...text.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((x) => x[1]!)));
  };

  for (const kind of PLUGIN_KINDS) {
    const entry = REGISTRY[kind];
    for (const plugin of Object.keys(entry.plugins)) {
      it(`${entry.interface} \`${plugin}\`: the Secrets line lists exactly its declared names`, () => {
        const listed = docSecrets(bullet(section(entry.interface), plugin));
        expect(listed, "a Secrets: line").not.toBeNull();
        expect(listed).toEqual(sorted(new Set(entry.secrets[plugin]!.map((d) => d.name))));
      });
    }
  }

  it("the drift check catches a missing and an undeclared name", () => {
    expect(docSecrets("- `x`: X.\n  - Secrets: `A_TOKEN`. Settings: `B_HOST`.")).toEqual(["A_TOKEN"]);
    expect(docSecrets("- `x`: X. Secrets: none.")).toEqual([]);
    expect(docSecrets("- `x`: X.")).toBeNull();
  });

  it(".env.example lists every secret the default selection declares", () => {
    const template = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const keys = new Set([...template.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]!));
    for (const platform of ["darwin", "linux"]) {
      const sel = selectPlugins(REGISTRY, REAL as { store: { type: unknown }; auth: unknown; plugins?: unknown }, { platform });
      for (const name of declaredSecretNames(REGISTRY, sel)) expect(keys, name).toContain(name);
    }
  });
});

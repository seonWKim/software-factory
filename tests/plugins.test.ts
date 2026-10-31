import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, Plugins, build, loadConfig } from "../src/compose.js";
import type { WorkerDeps } from "../src/core/worker.js";
import { GitHubAuthProvider, NoAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { ListAllCapabilitySearch } from "../src/impl/capability/list-all-capability-search.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { SystemClock } from "../src/impl/clock/system-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { ClaudeCliLLMProvider } from "../src/impl/llm/claude-cli-llm-provider.js";
import { ClaudeCodeRunner } from "../src/impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { EnvFileSecretStore } from "../src/impl/secrets/env-file-secret-store.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";
import { MysqlDriver } from "../src/impl/store/mysql/mysql-driver.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import type { EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import type { ToolBroker, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import {
  type Contexts,
  DEFAULT_PLUGINS,
  PLUGIN_KINDS,
  type PluginKind,
  REGISTRY,
  type Registry,
  createPlugin,
  withPlugin,
} from "../src/plugins.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
type Ctor = abstract new (...args: never[]) => unknown;

/** The implementation class behind every registered plugin. Every registry name must appear here. */
const EXPECTED: { [K in PluginKind]: Record<string, Ctor> } = {
  store: { sqlite: SqlFactoryStore, mysql: SqlFactoryStore },
  sandbox: { noop: NoOpSandbox },
  runner: { "claude-code": ClaudeCodeRunner },
  llm: { "claude-cli": ClaudeCliLLMProvider },
  auth: { github: GitHubAuthProvider, none: NoAuthProvider },
  secrets: { "env-file": EnvFileSecretStore },
  egress: { pattern: PatternEgressScanner },
  broker: { github: GitHubToolBroker },
  storage: { fs: FsSharedStorage },
  source: { "github-issues": GitHubIssueSource },
  capability: { "list-all": ListAllCapabilitySearch },
  clock: { system: SystemClock },
};
const STORE_DRIVER: Record<string, Ctor> = { sqlite: SqliteDriver, mysql: MysqlDriver };

const GUARDS = ["secrets", "egress", "broker"] as const;

/** Today's config shape: no `plugins` object. */
function withoutPlugins(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { plugins: _, ...rest } = REAL;
  return { ...rest, ...over };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A throwaway repo root with its own config, prompts, state dir and secret file. */
function root(config: Record<string, unknown>, secrets = "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-plugins-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), secrets);
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

class MapSecrets implements SecretStore {
  async get(name: SecretName): Promise<Secret | null> {
    return { name, reveal: () => "pw" };
  }
  async valuesForScan(): Promise<readonly string[]> {
    return [];
  }
}

/** A full context, so any plugin of any interface can be built. */
async function context(loaded: Loaded): Promise<Contexts[PluginKind] & Record<string, unknown>> {
  const base = new Plugins(loaded).base;
  const secrets = new MapSecrets();
  const clock = new FakeClock();
  const github = new GitHubClient(secrets);
  mkdirSync(join(loaded.stateDir, "db"), { recursive: true });
  const store = (await createPlugin(loaded.registry, "store", "sqlite", { ...base, secrets, clock })) as FactoryStore;
  const scanner = new PatternEgressScanner(async () => []);
  const sandbox = new NoOpSandbox(join(loaded.root, "wt"));
  return { ...base, secrets, clock, github, store, scanner, sandbox, capabilities: [] } as never;
}

async function closeIfStore(kind: PluginKind, x: unknown): Promise<void> {
  if (kind === "store") await (x as FactoryStore).close();
}

describe("plugin registry: defaults", () => {
  it("config without a plugins object resolves to exactly today's implementations", async () => {
    const loaded = await loadConfig(root(withoutPlugins()));
    expect(loaded.plugins).toEqual({
      store: "mysql",
      sandbox: "noop",
      runner: "claude-code",
      llm: "claude-cli",
      auth: "github",
      secrets: "env-file",
      egress: "pattern",
      broker: "github",
      storage: "fs",
      source: "github-issues",
      capability: "list-all",
      clock: "system",
    });
    const ctx = await context(loaded);
    for (const kind of PLUGIN_KINDS) {
      const name = loaded.plugins[kind];
      const x = await createPlugin(loaded.registry, kind, name, ctx as never);
      expect(x, `${kind}=${name}`).toBeInstanceOf(EXPECTED[kind][name]);
      if (kind === "store") expect((x as unknown as { db: unknown }).db).toBeInstanceOf(MysqlDriver);
      await closeIfStore(kind, x);
    }
    await (ctx.store as FactoryStore).close();
  });

  it("the checked-in factory.config.json selects the same defaults", async () => {
    const loaded = await loadConfig(root(REAL));
    const { store: _s, auth: _a, ...rest } = loaded.plugins;
    expect(rest).toEqual(DEFAULT_PLUGINS);
    expect(REAL.plugins).toEqual(DEFAULT_PLUGINS);
  });
});

describe("plugin registry: every registered name", () => {
  it("resolves to an instance of its implementation", async () => {
    const loaded = await loadConfig(root(withoutPlugins()));
    const ctx = await context(loaded);
    let count = 0;
    for (const kind of PLUGIN_KINDS) {
      expect(Object.keys(REGISTRY[kind].plugins).sort(), kind).toEqual(Object.keys(EXPECTED[kind]).sort());
      for (const name of Object.keys(REGISTRY[kind].plugins)) {
        const x = await createPlugin(REGISTRY, kind, name, ctx as never);
        expect(x, `${kind}=${name}`).toBeInstanceOf(EXPECTED[kind][name]);
        if (kind === "store") expect((x as unknown as { db: unknown }).db).toBeInstanceOf(STORE_DRIVER[name]);
        await closeIfStore(kind, x);
        count++;
      }
    }
    expect(count).toBe(14); // 15 classes in the issue list: SqliteDriver and MysqlDriver sit under the two store plugins
    await (ctx.store as FactoryStore).close();
  });
});

describe("plugin registry: unknown names fail at startup", () => {
  const configWith = (kind: PluginKind, value: unknown): Record<string, unknown> => {
    if (kind === "store") return { ...REAL, store: { type: value } };
    if (kind === "auth") return { ...REAL, auth: value };
    return { ...REAL, plugins: { ...(REAL.plugins as object), [kind]: value } };
  };

  for (const kind of PLUGIN_KINDS) {
    it(`${kind}: names the interface, the bad value and every available name`, async () => {
      const dir = root(configWith(kind, "no-such-plugin"));
      const err = await loadConfig(dir).then(
        () => null,
        (e: Error) => e.message,
      );
      expect(err).toContain(REGISTRY[kind].interface);
      expect(err).toContain("no-such-plugin");
      for (const name of Object.keys(REGISTRY[kind].plugins)) expect(err).toContain(name);
    });
  }

  it("build() refuses a bad selection too", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" } }));
    const bad = { ...loaded, plugins: { ...loaded.plugins, sandbox: "docker" } };
    await expect(build(bad, { clock: new FakeClock() })).rejects.toThrow(/unknown Sandbox plugin "docker".*available: noop/);
  });

  it("unknown keys in the plugins object fail, and store/auth point to their own keys", async () => {
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandox: "noop" } }))).rejects.toThrow(
      /unknown plugins key "sandox"/,
    );
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), auth: "none" } }))).rejects.toThrow(
      /top-level "auth" key/,
    );
  });
});

describe("plugin registry: guards cannot be disabled", () => {
  const DISABLING: [string, unknown][] = [
    ["omitted", undefined],
    ["null", null],
    ["false", false],
    ["empty string", ""],
    ["none", "none"],
    ["a non-name", 0],
  ];
  for (const guard of GUARDS) {
    for (const [label, value] of DISABLING) {
      it(`${guard}: ${label}`, async () => {
        const plugins: Record<string, unknown> = { ...(REAL.plugins as object) };
        if (value === undefined) delete plugins[guard];
        else plugins[guard] = value;
        const err = await loadConfig(root({ ...REAL, plugins })).then(
          () => null,
          (e: Error) => e.message,
        );
        expect(err).toContain(REGISTRY[guard].interface);
        expect(err).toMatch(/is a guard and cannot be disabled/);
        expect(err).toContain("docs/architecture.md §5");
      });
    }
  }

  it("an empty plugins object selects no guard, so it fails", async () => {
    await expect(loadConfig(root({ ...REAL, plugins: {} }))).rejects.toThrow(/cannot be disabled/);
  });

  it("a guard plugin cannot be registered under a disabling name", () => {
    expect(() => withPlugin(REGISTRY, "secrets", "none", () => new MapSecrets())).toThrow(/means disabled/);
  });
});

describe("plugin registry: guards can be switched", () => {
  class TestSecrets extends MapSecrets {}
  class TestScanner implements EgressScanner {
    async scan(): Promise<ScanResult> {
      return { clean: true };
    }
  }
  class TestBroker implements ToolBroker {
    listTools(): ToolDescriptor[] {
      return [];
    }
    async call(): Promise<ToolResult> {
      return { ok: true, content: null };
    }
  }

  it("build() wires the selected test-only SecretStore, EgressScanner and ToolBroker", async () => {
    const made: { secrets?: SecretStore; scanner?: EgressScanner; broker?: ToolBroker; brokerCtx?: Contexts["broker"] } = {};
    let registry: Registry = REGISTRY;
    registry = withPlugin(registry, "secrets", "test-secrets", () => (made.secrets = new TestSecrets()));
    registry = withPlugin(registry, "egress", "test-egress", () => (made.scanner = new TestScanner()));
    registry = withPlugin(registry, "broker", "test-broker", (c) => {
      made.brokerCtx = c;
      return (made.broker = new TestBroker());
    });
    const dir = root({
      ...REAL,
      store: { type: "sqlite" },
      plugins: { ...(REAL.plugins as object), secrets: "test-secrets", egress: "test-egress", broker: "test-broker" },
    });
    const loaded = await loadConfig(dir, { registry });
    const built = await build(loaded, { clock: new FakeClock() });
    try {
      expect(made.secrets).toBeInstanceOf(TestSecrets);
      expect(built.secrets).toBe(made.secrets);
      const w = (built.worker as unknown as { d: WorkerDeps }).d;
      expect(w.scanner).toBe(made.scanner);
      expect(w.broker).toBe(made.broker);
      // The other plugins get the swapped guards, not the built-in ones.
      expect((w.runner as unknown as { opts: { secrets: unknown } }).opts.secrets).toBe(made.secrets);
      expect(made.brokerCtx?.secrets).toBe(made.secrets);
      expect(made.brokerCtx?.scanner).toBe(made.scanner);
      expect(made.brokerCtx?.store).toBe(built.store);
      expect((built.controller as unknown as { d: { store: unknown } }).d.store).toBe(built.store);
    } finally {
      await built.close();
    }
  });

  it("Plugins (canary and setup) resolve through the same registry and selection", async () => {
    let registry: Registry = REGISTRY;
    const secrets = new MapSecrets();
    registry = withPlugin(registry, "secrets", "test-secrets", () => secrets);
    const loaded = await loadConfig(
      root({ ...REAL, plugins: { ...(REAL.plugins as object), secrets: "test-secrets" } }),
      { registry },
    );
    const p = new Plugins(loaded, { extraScanValues: ["sf-canary-x"] });
    expect(await p.secrets()).toBe(secrets);
    expect(await p.scanner(secrets)).toBeInstanceOf(PatternEgressScanner);
    expect(p.base.extraScanValues).toEqual(["sf-canary-x"]);
  });
});

describe("plugin registry: existing config keys keep working", () => {
  it("store type sqlite gives SqlFactoryStore over SqliteDriver", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" } }));
    expect(loaded.store).toEqual({ type: "sqlite" });
    const built = await build(loaded, { clock: new FakeClock() });
    try {
      expect(built.store).toBeInstanceOf(SqlFactoryStore);
      expect((built.store as unknown as { db: unknown }).db).toBeInstanceOf(SqliteDriver);
    } finally {
      await built.close();
    }
  });

  it("no store block still means sqlite", async () => {
    const { store: _, ...rest } = REAL;
    expect((await loadConfig(root(rest))).plugins.store).toBe("sqlite");
  });

  it("MYSQL_* settings in the secret file override the store block", async () => {
    const loaded = await loadConfig(
      root(REAL, "MYSQL_HOST=db.internal\nMYSQL_PORT=3307\nMYSQL_DATABASE=sf_other\nMYSQL_USER=sf_user\nMYSQL_PASSWORD=pw\n"),
    );
    expect(loaded.store).toEqual({ type: "mysql", host: "db.internal", port: 3307, database: "sf_other", user: "sf_user" });
  });

  it("top-level auth none gives NoAuthProvider", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" }, auth: "none" }));
    const built = await build(loaded, { clock: new FakeClock() });
    try {
      expect((built.controller as unknown as { d: { auth: unknown } }).d.auth).toBeInstanceOf(NoAuthProvider);
    } finally {
      await built.close();
    }
  });
});

describe("plugin registry: only src/plugins.ts constructs implementations", () => {
  it("compose.ts, canary.ts and setup.ts call new on none of them", () => {
    const classes = Object.values(EXPECTED)
      .flatMap((m) => Object.values(m))
      .concat([SqliteDriver, MysqlDriver])
      .map((c) => c.name);
    for (const f of ["compose.ts", "canary.ts", "setup.ts"]) {
      const text = readFileSync(join(REPO_ROOT, "src", f), "utf8");
      for (const name of classes) expect(text, `${f}: new ${name}`).not.toMatch(new RegExp(`new\\s+${name}\\b`));
    }
  });
});

describe("docs/plugins.md", () => {
  /** The text from an interface's `## Name` heading to the next `## ` heading. */
  const section = (name: string): string | null => {
    const doc = readFileSync(join(REPO_ROOT, "docs", "plugins.md"), "utf8");
    const m = doc.match(new RegExp(`^## ${name}\\b[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m"));
    return m ? m[1]! : null;
  };

  for (const kind of PLUGIN_KINDS) {
    const entry = REGISTRY[kind];
    it(`has a ${entry.interface} section naming every ${kind} plugin`, () => {
      const s = section(entry.interface);
      expect(s, `## ${entry.interface}`).not.toBeNull();
      for (const name of Object.keys(entry.plugins)) expect(s).toContain(`\`${name}\``);
      if (entry.guard) expect(s).toMatch(/cannot be disabled/);
    });
  }

  it("covers 12 interfaces", () => {
    expect(PLUGIN_KINDS).toHaveLength(12);
  });
});

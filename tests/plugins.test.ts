import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, Plugins, build, loadConfig } from "../src/compose.js";
import type { WorkerDeps } from "../src/core/worker.js";
import { CaffeinateKeepAwake } from "../src/impl/awake/caffeinate-keep-awake.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubAuthProvider, NoAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { Bm25CapabilitySearch } from "../src/impl/capability/bm25-capability-search.js";
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
import { GitWorktreeUpdater } from "../src/impl/updater/git-worktree.js";
import type { EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import type { ToolBroker, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import {
  type Contexts,
  IMPL_DIR,
  type PluginDescriptor,
  defaultPlugins,
  findPluginFiles,
  PLUGIN_KINDS,
  PLUGINS_KEYS,
  type PluginKind,
  REGISTRY,
  type Registry,
  createPlugin,
  withPlugin,
} from "../src/plugins.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
type Ctor = abstract new (...args: never[]) => unknown;

/**
 * The implementation class behind the default selection (darwin), for the defaults test only. Other plugins
 * are covered by the property tests over every discovered descriptor, so a new plugin edits no test here.
 */
const EXPECTED: { [K in PluginKind]: Record<string, Ctor> } = {
  store: { mysql: SqlFactoryStore },
  sandbox: { noop: NoOpSandbox },
  runner: { "claude-code": ClaudeCodeRunner },
  llm: { "claude-cli": ClaudeCliLLMProvider },
  auth: { github: GitHubAuthProvider },
  secrets: { "env-file": EnvFileSecretStore },
  egress: { pattern: PatternEgressScanner },
  broker: { github: GitHubToolBroker },
  storage: { fs: FsSharedStorage },
  source: { "github-issues": GitHubIssueSource },
  capability: { "list-all": ListAllCapabilitySearch },
  clock: { system: SystemClock },
  updater: { "git-worktree": GitWorktreeUpdater },
  awake: { caffeinate: CaffeinateKeepAwake },
};

/** Every descriptor file under src/impl with what it exports, loaded the way the registry loads them. */
const DESCRIPTORS = await Promise.all(
  findPluginFiles([IMPL_DIR]).map(async (file) => ({
    file,
    descriptor: ((await import(pathToFileURL(file).href)) as { default: PluginDescriptor }).default,
  })),
);

const GUARDS = ["secrets", "egress", "broker"] as const;

/** Today's config shape: no `plugins` object. */
function withoutPlugins(over: Record<string, unknown> = {}): Record<string, unknown> {
  const { plugins: _, ...rest } = REAL;
  return { ...rest, ...over };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A PATH whose first entry holds a fake `caffeinate`, so the caffeinate plugin builds on any OS. */
function pathWithFakeCaffeinate(): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-bin-"));
  writeFileSync(join(dir, "caffeinate"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "caffeinate"), 0o755);
  return [dir, process.env.PATH ?? ""].join(delimiter);
}

/** A throwaway repo root with its own config, prompts, state dir and secret file. */
function root(config: Record<string, unknown>, secrets = "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "sf-plugins-"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...config, state_dir: "state", worktrees_dir: "wt" }));
  mkdirSync(join(dir, "secrets"));
  writeFileSync(join(dir, "secrets", ".env"), secrets);
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
  return dir;
}

class MapSecrets implements SecretStore {
  async get(name: SecretName): Promise<Secret | null> {
    return { name, reveal: () => "pw", toJSON: () => `[secret ${name}]` };
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
  // Updater: a runner and launcher that fail if used; constructing a plugin must not run anything.
  const run = async () => {
    throw new Error("the updater ran a command at construction");
  };
  const launcher = {
    launch() {
      throw new Error("the updater launched a child at construction");
    },
  };
  const log = { info() {}, warn() {}, error() {} };
  return { ...base, secrets, clock, github, store, scanner, sandbox, capabilities: [], run, launcher, log } as never;
}

async function closeIfStore(kind: PluginKind, x: unknown): Promise<void> {
  if (kind === "store") await (x as FactoryStore).close();
}

describe("plugin registry: defaults", () => {
  it("config without a plugins object resolves to exactly today's implementations", async () => {
    vi.stubEnv("PATH", pathWithFakeCaffeinate());
    const loaded = await loadConfig(root(withoutPlugins()), { platform: "darwin" });
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
      updater: "git-worktree",
      awake: "caffeinate",
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

  it("the checked-in factory.config.json selects the same defaults, leaving awake to the platform", async () => {
    for (const platform of ["darwin", "linux"]) {
      const loaded = await loadConfig(root(REAL), { platform });
      const { store: _s, auth: _a, ...rest } = loaded.plugins;
      expect(rest).toEqual(defaultPlugins(platform));
    }
    const { awake: _w, ...fixed } = defaultPlugins("darwin");
    expect(REAL.plugins).toEqual(fixed);
  });

  it("awake defaults to caffeinate on macOS and none everywhere else", async () => {
    expect(defaultPlugins("darwin").awake).toBe("caffeinate");
    for (const platform of ["linux", "win32", "freebsd"]) expect(defaultPlugins(platform).awake).toBe("none");
    expect((await loadConfig(root(withoutPlugins()), { platform: "darwin" })).plugins.awake).toBe("caffeinate");
    expect((await loadConfig(root(withoutPlugins()), { platform: "linux" })).plugins.awake).toBe("none");
    expect((await loadConfig(root(REAL), { platform: "linux" })).plugins.awake).toBe("none");
  });

  it("an explicit plugins.awake wins over the platform default", async () => {
    const cfg = (awake: string) => root({ ...REAL, plugins: { ...(REAL.plugins as object), awake } });
    expect((await loadConfig(cfg("none"), { platform: "darwin" })).plugins.awake).toBe("none");
    expect((await loadConfig(cfg("caffeinate"), { platform: "linux" })).plugins.awake).toBe("caffeinate");
  });
});

describe("plugin registry: every discovered plugin", () => {
  it("every registered name comes from exactly one descriptor file, and every descriptor is registered", () => {
    const registered = PLUGIN_KINDS.flatMap((kind) => Object.keys(REGISTRY[kind].plugins).map((name) => `${kind}/${name}`));
    const described = DESCRIPTORS.map(({ descriptor: d }) => `${d.kind}/${d.name}`);
    expect([...described].sort()).toEqual([...registered].sort());
    expect(new Set(described).size).toBe(described.length);
  });

  for (const { file, descriptor: d } of DESCRIPTORS) {
    describe(`${d.kind} \`${d.name}\` (${file.slice(IMPL_DIR.length + 1)})`, () => {
      it("is registered with its descriptor's factory and secrets", () => {
        expect(REGISTRY[d.kind].plugins[d.name]).toBe(d.create);
        expect(REGISTRY[d.kind].secrets[d.name]).toEqual(d.secrets ?? []);
      });

      it("sits beside its implementation, built with definePlugin", () => {
        const text = readFileSync(file, "utf8");
        expect(text).toMatch(/export default definePlugin\(/);
        const local = [...text.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => join(dirname(file), m[1]!));
        expect(local.filter((p) => p.startsWith(IMPL_DIR)).length, "imports its implementation from src/impl").toBeGreaterThan(0);
      });

      it("builds an object from a full context without running anything", async () => {
        vi.stubEnv("PATH", pathWithFakeCaffeinate());
        const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" } }));
        const ctx = await context(loaded);
        const isMysql = d.kind === "store" && d.name === "mysql";
        const run = () => createPlugin(REGISTRY, d.kind, d.name, (isMysql ? { ...ctx, loaded: mysqlLoaded(loaded) } : ctx) as never);
        try {
          const x = await run();
          expect(x).toBeTypeOf("object");
          expect(x).not.toBeNull();
          await closeIfStore(d.kind, x);
        } finally {
          await (ctx.store as FactoryStore).close();
        }
      });

      it("declares well-formed secrets, a valid default, and a guard name that does not mean disabled", () => {
        for (const s of d.secrets ?? []) {
          expect(s.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
          expect(s.purpose.trim()).not.toBe("");
        }
        if (d.kind === "store" || d.kind === "auth") expect(d.default).toBeUndefined();
        if (REGISTRY[d.kind].guard) expect(["", "none"]).not.toContain(d.name);
      });
    });
  }
});

/**
 * The classes a descriptor constructs from its own interface's directory (src/impl/<dir>/...), such as
 * SqlFactoryStore and SqliteDriver; shared helpers such as ConsoleLogger come from elsewhere.
 */
function implementationClasses(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const own = join(IMPL_DIR, file.slice(IMPL_DIR.length + 1).split(/[\\/]/)[0]!);
  const constructed = new Set([...text.matchAll(/new\s+([A-Z]\w*)/g)].map((m) => m[1]!));
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)]
    .filter((m) => join(dirname(file), m[2]!).startsWith(own))
    .flatMap((m) => m[1]!.split(",").map((x) => x.trim()))
    .filter((name) => constructed.has(name));
}

/** A loaded config whose store block is mysql (the mysql plugin checks it; the driver connects lazily). */
function mysqlLoaded(loaded: Loaded): Loaded {
  return { ...loaded, store: { type: "mysql", host: "127.0.0.1", port: 3306, database: "sf", user: "sf" } };
}

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

  it('an unknown plugins key keeps the known keys and suggests a close one: "sandox" -> "sandbox"', async () => {
    const err = await loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandox: "noop" } })).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain('did you mean "sandbox"?');
    for (const k of PLUGINS_KEYS) expect(err).toContain(k);
  });

  it("an unknown plugins key that is not close gets no suggestion", async () => {
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), zzzzzzzz: "x" } }))).rejects.toThrow(
      /^(?!.*did you mean).*unknown plugins key "zzzzzzzz"/s,
    );
  });

  it("every unknown plugins key is reported in one error", async () => {
    const err = await loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandox: "noop", runer: "x" } })).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(err).toContain('"sandox"');
    expect(err).toContain('"runer"');
    expect(err).toContain('did you mean "runner"?');
  });

  it("an unknown plugin name keeps every available name and suggests a close one", async () => {
    const sandbox = await loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandbox: "nop" } })).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(sandbox).toMatch(/unknown Sandbox plugin "nop".*available: noop; did you mean "noop"\?/);
    const guard = await loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), egress: "patern" } })).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(guard).toMatch(/unknown EgressScanner plugin "patern".*available: pattern; did you mean "pattern"\?/);
    const far = await loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandbox: "docker" } })).then(
      () => null,
      (e: Error) => e.message,
    );
    expect(far).not.toContain("did you mean");
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

describe("plugin registry: KeepAwake startup check", () => {
  const caffeinateConfig = () =>
    root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "caffeinate" } });

  it("build() rejects caffeinate when no caffeinate executable is on PATH, naming the key and the none alternative", async () => {
    const loaded = await loadConfig(caffeinateConfig());
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-bin-")));
    const err = await build(loaded, { clock: new FakeClock() }).then(
      async (b) => {
        await b.close();
        return null;
      },
      (e: Error) => e.message,
    );
    expect(err).toContain("plugins.awake");
    expect(err).toContain("caffeinate");
    expect(err).toMatch(/"none"/);
  });

  it("build() wires caffeinate when the executable is on PATH", async () => {
    const loaded = await loadConfig(caffeinateConfig());
    vi.stubEnv("PATH", pathWithFakeCaffeinate());
    const built = await build(loaded, { clock: new FakeClock() });
    try {
      expect((built.worker as unknown as { d: WorkerDeps }).d.awake).toBeInstanceOf(CaffeinateKeepAwake);
    } finally {
      await built.close();
    }
  });

  it("build() wires none without looking for caffeinate", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none" } }));
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-bin-")));
    const built = await build(loaded, { clock: new FakeClock() });
    try {
      expect((built.worker as unknown as { d: WorkerDeps }).d.awake).toBeInstanceOf(NoKeepAwake);
    } finally {
      await built.close();
    }
  });
});

describe("plugin registry: CapabilitySearch wiring", () => {
  const capabilityOf = async (capability?: string) => {
    const plugins = capability ? { ...(REAL.plugins as object), capability } : REAL.plugins;
    const dir = root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(plugins as object), awake: "none" } });
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nHow the zebra works.\n");
    const built = await build(await loadConfig(dir), { clock: new FakeClock() });
    try {
      return (built.worker as unknown as { d: WorkerDeps }).d.capability;
    } finally {
      await built.close();
    }
  };

  it("the checked-in config still selects list-all, and build() passes it to the worker", async () => {
    expect((REAL.plugins as Record<string, unknown>).capability).toBe("list-all");
    const c = await capabilityOf();
    expect(c).toBeInstanceOf(ListAllCapabilitySearch);
    expect(await c!.search("zebra", 8)).toEqual([]);
  });

  it('"capability": "bm25" gives Bm25CapabilitySearch over the code root\'s docs; switching back gives list-all', async () => {
    const c = await capabilityOf("bm25");
    expect(c).toBeInstanceOf(Bm25CapabilitySearch);
    expect((await c!.search("zebra", 8)).map((x) => x.id)).toEqual(["docs/guide.md"]);
    expect(await capabilityOf("list-all")).toBeInstanceOf(ListAllCapabilitySearch);
  });
});

describe("plugin registry: only plugin descriptors construct implementations", () => {
  it("compose.ts, canary.ts and setup.ts call new on none of them", () => {
    const classes = new Set(DESCRIPTORS.flatMap(({ file }) => implementationClasses(file)));
    expect(classes).toContain("MysqlDriver");
    expect(classes).toContain("SqliteDriver");
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

  it("KeepAwake says how to switch it, the platform default, the startup failure and the lid", () => {
    const s = section("KeepAwake")!;
    expect(s).toContain("plugins.awake");
    expect(s).toMatch(/macOS/);
    expect(s).toMatch(/PATH/);
    expect(s).toMatch(/lid/);
  });

  it("CapabilitySearch says what bm25 indexes, the snippet cap, the index size, rebuilds, switching, Read and permission", () => {
    const s = section("CapabilitySearch")!;
    for (const text of ["`docs/`", "`skills/`", "200", "8", "mtime", "plugins.capability", '"capability": "bm25"', '"capability": "list-all"', "Read"]) {
      expect(s, text).toContain(text);
    }
    expect(s).toMatch(/not permission/);
    expect(s).toMatch(/Not wired in yet/);
  });

  it("covers 14 interfaces", () => {
    expect(PLUGIN_KINDS).toHaveLength(14);
  });
});

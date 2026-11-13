import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Loaded, Plugins, build, loadConfig } from "../src/compose.js";
import type { WorkerDeps } from "../src/worker/index.js";
import { CaffeinateKeepAwake } from "../src/impl/awake/caffeinate-keep-awake.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { GitHubAuthProvider } from "../src/impl/github/github-auth-provider.js";
import { NoAuthProvider } from "../src/impl/auth/none-auth-provider.js";
import { AuditedAuthProvider } from "../src/impl/auth/audited-auth.js";
import { PassportToolBroker } from "../src/impl/broker/passport-broker.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { GitHubToolBroker } from "../src/impl/github/github-tool-broker.js";
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
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import { FsSharedStorage } from "../src/impl/storage/fs-shared-storage.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { GitWorktreeUpdater } from "../src/impl/updater/git-worktree.js";
import { HttpNetworkProbe } from "../src/impl/network-probe/http-network-probe.js";
import { SqlBus } from "../src/bus/index.js";
import { TimeBasedTicks } from "../src/shared/ticks/plugins/time-based/time-based-tick-generator.js";
import { JournalEngines } from "../src/worker/engine/plugins/journal/journal-engine.js";
import { NoTacitLedger } from "../src/impl/tacit/no-tacit-ledger.js";
import type { AuthProvider } from "../src/interfaces/auth-provider.js";
import type { UserId } from "../src/core/types.js";
import type { EgressScanner, ScanResult } from "../src/interfaces/egress-scanner.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { Secret, SecretName, SecretStore } from "../src/interfaces/secret-store.js";
import type { GitHubAccess, GitHubApi } from "../src/interfaces/github-credentials.js";
import type { ToolBroker, ToolDescriptor, ToolResult } from "../src/interfaces/tool-broker.js";
import {
  type Contexts,
  PLUGIN_ROOT,
  connectHooks,
  loadRegistry,
  type PluginDescriptor,
  defaultPlugins,
  findPluginFiles,
  PLUGIN_KINDS,
  PLUGINS_KEYS,
  type PluginKind,
  REGISTRY,
  type Registry,
  GRANTS,
  INTEGRATION_KINDS,
  createPlugin,
  declaredSecrets,
  selectedSetups,
  selectPlugins,
  selectedSources,
  withPlugin,
} from "../src/plugins.js";
import { FakeSlackPollSource, fakeSlackPollRegistry, fakeRepoLookup } from "./helpers/fakes.js";
import { TokenCredentials } from "../src/impl/github/token-credentials.js";

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
type Ctor = abstract new (...args: never[]) => unknown;

/**
 * The implementation class behind the default selection (darwin), for the defaults test only. Other plugins
 * are covered by the property tests over every discovered descriptor, so a new plugin edits no test here.
 */
const EXPECTED: { [K in PluginKind]: Record<string, Ctor> } = {
  store: { sqlite: SqlFactoryStore },
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
  github_auth: { token: TokenCredentials },
  // Optional with no default plugin (issue #172); github-issues among the sources implies github (issue #273).
  forge: { github: GitHubForge },
  network_probe: { http: HttpNetworkProbe },
  bus: { sql: SqlBus },
  ticks: { "time-based": TimeBasedTicks },
  engine: { journal: JournalEngines },
  tacit: { none: NoTacitLedger },
  // Optional, selected as a list by the top-level `calendar` key, default []: no provider (google-calendar) is a default.
  calendar: {},
};

/** Every descriptor file under src/impl with what it exports, loaded the way the registry loads them. */
const DESCRIPTORS = await Promise.all(
  findPluginFiles([PLUGIN_ROOT]).map(async (file) => ({
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
function root(config: Record<string, unknown>, secrets = "GITHUB_TOKEN=gh\n"): string {
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
  const github = new GitHubClient(new TokenCredentials(secrets));
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
      store: "sqlite",
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
      github_auth: "token",
      network_probe: "http",
      bus: "sql",
      ticks: "time-based",
      engine: "journal",
      tacit: "none",
      // Derived from github-issues, the default source (issue #273).
      forge: "github",
    });
    const ctx = await context(loaded);
    for (const kind of PLUGIN_KINDS) {
      // The calendar list defaults to [] (no source), so nothing is built for it.
      if (kind === "calendar") continue;
      const name = loaded.plugins[kind];
      if (name === undefined) throw new Error(`${kind} has no default`);
      const x = await createPlugin(loaded.registry, kind, name, ctx as never);
      // A credential plugin builds its credentials and the one forge client over them.
      if (kind === "github_auth") expect((x as unknown as GitHubAccess).api).toBeInstanceOf(GitHubClient);
      const made = kind === "github_auth" ? (x as unknown as GitHubAccess).credentials : x;
      expect(made, `${kind}=${name}`).toBeInstanceOf(EXPECTED[kind][name]);
      if (kind === "store") expect((x as unknown as { db: unknown }).db).toBeInstanceOf(SqliteDriver);
      await closeIfStore(kind, x);
    }
    await (ctx.store as FactoryStore).close();
  });

  it("the checked-in factory.config.json selects the defaults, except the GitHub App bot, local and Slack intake, the bm25 doc index and the agents-home tacit ledger, leaving awake to the platform", async () => {
    for (const platform of ["darwin", "linux"]) {
      const loaded = await loadConfig(root(REAL), { platform });
      const { store: _s, auth: _a, github_auth, sources, capability, tacit, forge, ...rest } = loaded.plugins;
      expect(github_auth).toBe("app");
      expect(tacit).toBe("agents-home");
      expect(sources).toEqual(["github-issues", "local", "slack"]);
      expect(forge).toBe("github");
      expect(capability).toBe("bm25");
      const { github_auth: _g, capability: _c, tacit: _t, ...defaults } = defaultPlugins(platform);
      expect(rest).toEqual(defaults);
    }
    const { awake: _w, ...fixed } = defaultPlugins("darwin");
    expect(REAL.plugins).toEqual({ ...fixed, github_auth: "app", source: ["github-issues", "local", "slack"], capability: "bm25", tacit: "agents-home" });
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
    describe(`${d.kind} \`${d.name}\` (${file.slice(PLUGIN_ROOT.length + 1)})`, () => {
      it("is registered with its descriptor's factory and secrets", () => {
        expect(REGISTRY[d.kind].plugins[d.name]).toBe(d.create);
        expect(REGISTRY[d.kind].secrets[d.name]).toEqual(d.secrets ?? []);
      });

      it("sits beside its implementation, built with definePlugin", () => {
        const text = readFileSync(file, "utf8");
        expect(text).toMatch(/export default definePlugin\(/);
        const local = [...text.matchAll(/(?:from\s+|import\()"(\.[^"]+)"/g)].map((m) => join(dirname(file), m[1]!));
        // A component's plugin keeps its descriptor in src/impl until plugin-api.ts is a component (M11): a component
        // file importing it would break dependency-direction. Its implementation is then in the component's plugins/.
        const home = (p: string) => p.startsWith(pluginHome(file)) || /[\\/](bus|shared[\\/]ticks)[\\/]plugins[\\/]/.test(p);
        expect(local.filter(home).length, "imports its implementation from its own folder").toBeGreaterThan(0);
      });

      it("builds an object from a full context without running anything", async () => {
        vi.stubEnv("PATH", pathWithFakeCaffeinate());
        // A `slack` block too: the slack source needs its channels to build (it is off in the checked-in config).
        const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" }, slack: { channels: ["C0TEST0001"] } }));
        const ctx = await context(loaded);
        const run = () => createPlugin(REGISTRY, d.kind, d.name, ctx as never);
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

/** A plugin's own folder: src/impl/<interface>/ for legacy plugins, else the folder of its descriptor. */
function pluginHome(file: string): string {
  const [top, dir] = file.slice(PLUGIN_ROOT.length + 1).split(/[\\/]/);
  return top === "impl" ? join(PLUGIN_ROOT, "impl", dir!) : dirname(file);
}

/**
 * The classes a descriptor constructs from its own interface's directory (src/impl/<dir>/...), such as
 * SqlFactoryStore and SqliteDriver; shared helpers such as ConsoleLogger come from elsewhere.
 */
function implementationClasses(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const own = pluginHome(file);
  const constructed = new Set([...text.matchAll(/new\s+([A-Z]\w*)/g)].map((m) => m[1]!));
  return [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*"(\.[^"]+)"/g)]
    .filter((m) => join(dirname(file), m[2]!).startsWith(own))
    .flatMap((m) => m[1]!.split(",").map((x) => x.trim()))
    .filter((name) => constructed.has(name));
}

describe("plugin registry: unknown names fail at startup", () => {
  const configWith = (kind: PluginKind, value: unknown): Record<string, unknown> => {
    if (kind === "store") return { ...REAL, store: { type: value } };
    if (kind === "auth") return { ...REAL, auth: value };
    if (kind === "calendar") return { ...REAL, calendar: [value] };
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
    await expect(build(bad, { clock: new FakeClock(), repoLookup: fakeRepoLookup })).rejects.toThrow(/unknown Sandbox plugin "docker".*available: noop/);
  });

  it("unknown keys in the plugins object fail, and store/auth point to their own keys", async () => {
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), sandox: "noop" } }))).rejects.toThrow(
      /unknown plugins key "sandox"/,
    );
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), auth: "none" } }))).rejects.toThrow(
      /top-level "auth" key/,
    );
  });

  it("the removed plugins.test_database key fails at startup as an unknown plugins key", async () => {
    expect(PLUGINS_KEYS).not.toContain("test_database");
    await expect(loadConfig(root({ ...REAL, plugins: { ...(REAL.plugins as object), test_database: "none" } }))).rejects.toThrow(
      /unknown plugins key "test_database"/,
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

describe("plugin registry: integrations switch at runtime, and nothing else does", () => {
  // The interfaces the owner may switch from the dashboard (design 08-settings). Adding one here is a reviewed choice;
  // a guard never joins it.
  const ALLOWED_INTEGRATIONS: readonly PluginKind[] = ["tacit"];

  it("marks tacit (TacitLedger) as an integration", () => {
    expect(INTEGRATION_KINDS).toContain("tacit");
    expect(REGISTRY.tacit.interface).toBe("TacitLedger");
  });

  it("marks no other interface, and never a guard (SecretStore, EgressScanner, ToolBroker)", () => {
    for (const kind of INTEGRATION_KINDS) expect(ALLOWED_INTEGRATIONS, kind).toContain(kind);
    for (const guard of GUARDS) {
      expect(REGISTRY[guard].guard, guard).toBe(true);
      expect(INTEGRATION_KINDS, guard).not.toContain(guard);
    }
    expect(GUARDS.map((g) => REGISTRY[g].interface).sort()).toEqual(["EgressScanner", "SecretStore", "ToolBroker"]);
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
    allTools(): ToolDescriptor[] {
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
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect(made.secrets).toBeInstanceOf(TestSecrets);
      expect(built.secrets).toBe(made.secrets);
      const w = (built.worker as unknown as { d: WorkerDeps }).d;
      expect(w.scanner).toBe(made.scanner);
      // Behind the run passport guard (M9).
      expect(w.broker).toBeInstanceOf(PassportToolBroker);
      expect((w.broker as PassportToolBroker).inner).toBe(made.broker);
      // The other plugins get the swapped guards, not the built-in ones.
      expect((w.runner as unknown as { opts: { secrets: unknown } }).opts.secrets).toBe(made.secrets);
      expect(made.brokerCtx?.secrets).toBe(made.secrets);
      expect(made.brokerCtx?.scanner).toBe(made.scanner);
      expect(made.brokerCtx?.store).toBe(built.store);
      expect(built.controller.kernel.d.store).toBe(built.store);
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
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
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

  it("local commands get the local auth plugin whatever auth selects for GitHub; the per-origin form names both", async () => {
    const authOf = async (auth: unknown) => {
      const built = await build(await loadConfig(root({ ...REAL, store: { type: "sqlite" }, auth })), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
      try {
        const d = built.controller.kernel.d;
        // Each behind the audit of its decisions (M9).
        return [d.auth, d.local_auth].map((a) => (a as AuditedAuthProvider).inner);
      } finally {
        await built.close();
      }
    };
    const [gh, local] = await authOf("github");
    expect(gh).toBeInstanceOf(GitHubAuthProvider);
    expect(local).toBeInstanceOf(LocalAuthProvider);
    const [gh2, local2] = await authOf({ github_issue: "github", local: "none" });
    expect(gh2).toBeInstanceOf(GitHubAuthProvider);
    expect(local2).toBeInstanceOf(NoAuthProvider);
    await expect(loadConfig(root({ ...REAL, auth: { github_issue: "github", slack: "local" } }))).rejects.toThrow(/unknown auth origin "slack".*known origins: .*slack_thread/);
    await expect(loadConfig(root({ ...REAL, auth: { local: "local" } }))).rejects.toThrow(/auth needs "github_issue"/);
    await expect(loadConfig(root({ ...REAL, auth: { github_issue: "github", local: "nope" } }))).rejects.toThrow(/unknown AuthProvider plugin "nope"/);
    await expect(loadConfig(root({ ...REAL, auth: { github_issue: "github", slack_thread: "nope" } }))).rejects.toThrow(/unknown AuthProvider plugin "nope"/);
  });

  it("Slack commands get the slack_thread auth plugin when auth names one, else the local-origin one (issues #486, #498)", async () => {
    const readerAuthOf = async (auth: unknown) => {
      const built = await build(await loadConfig(root({ ...REAL, store: { type: "sqlite" }, auth })), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
      try {
        const { forge, local, slack } = built.controller.kernel.reader.auth;
        return { forge: (forge as AuditedAuthProvider).inner, local: (local as AuditedAuthProvider).inner, slack: (slack as AuditedAuthProvider).inner };
      } finally {
        await built.close();
      }
    };
    const split = await readerAuthOf({ github_issue: "github", slack_thread: "local" });
    expect(split.forge).toBeInstanceOf(GitHubAuthProvider);
    expect(split.slack).toBeInstanceOf(LocalAuthProvider);
    // No slack_thread key: the local-origin plugin, the same instance (chat accounts act as their linked user, #498).
    const same = await readerAuthOf("github");
    expect(same.forge).toBeInstanceOf(GitHubAuthProvider);
    expect(same.slack).toBe(same.local);
  });

  it("an authorize call asks only the plugin of the identity's origin: slack_thread for Slack, github_issue for GitHub", async () => {
    const asked: string[] = [];
    const fake = (name: string) => (): AuthProvider => ({
      resolve: async (i) => (asked.push(`${name}:resolve:${i.provider}`), { user_id: `${i.provider}:${i.subject}` as UserId, attributes: {} }),
      authorize: async (p) => (asked.push(`${name}:authorize:${p.user_id}`), { allow: true }),
    });
    let reg = withPlugin(REGISTRY, "auth", "fake-gh", fake("gh"));
    reg = withPlugin(reg, "auth", "fake-slack", fake("slack"));
    const config = { ...REAL, store: { type: "sqlite" }, auth: { github_issue: "fake-gh", slack_thread: "fake-slack" } };
    const built = await build(await loadConfig(root(config), { registry: reg }), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const unit = await built.controller.unit("auth");
      await unit.authorize({ provider: "slack", subject: "U1" }, "submit_work", "wi_1");
      expect(asked).toEqual(["slack:resolve:slack", "slack:authorize:slack:U1"]);
      asked.length = 0;
      await unit.authorize({ provider: "github", subject: "7" }, "submit_work", "wi_1");
      expect(asked).toEqual(["gh:resolve:github", "gh:authorize:github:7"]);
    } finally {
      await built.close();
    }
  });

  it("top-level auth none gives NoAuthProvider", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" }, auth: "none" }));
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect((built.controller.kernel.d.auth as AuditedAuthProvider).inner).toBeInstanceOf(NoAuthProvider);
    } finally {
      await built.close();
    }
  });
});

describe("plugin registry: plugins.source takes a list (design 2026-11-01)", () => {
  const registry = fakeSlackPollRegistry();
  const select = (source: unknown, reg: Registry = registry) =>
    selectPlugins(reg, { store: { type: "sqlite" }, auth: "github", plugins: { ...(REAL.plugins as object), source } }, { platform: "linux" });
  const failure = (source: unknown): string | null => {
    try {
      select(source);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  };

  it("a single string selects exactly as today, and is a list of one", () => {
    const s = select("github-issues");
    expect(s.source).toBe("github-issues");
    expect(s.sources).toBeUndefined();
    expect(selectedSources(s)).toEqual(["github-issues"]);
  });

  it("a list of one gives the same selection as the string", () => {
    expect(select(["github-issues"])).toEqual(select("github-issues"));
    expect(select(["fake-slack-poll"])).toEqual(select("fake-slack-poll"));
  });

  it("a list of two keeps both names, in order", () => {
    const s = select(["github-issues", "fake-slack-poll"]);
    expect(selectedSources(s)).toEqual(["github-issues", "fake-slack-poll"]);
    expect(s.source).toBe("github-issues");
  });

  it("an empty list selects no source (issue #282); an empty runner or llm list still fails, naming its key", () => {
    expect(failure([])).toBeNull();
    expect(selectedSources(select([]))).toEqual([]);
    const other = (key: "runner" | "llm") => () =>
      selectPlugins(registry, { store: { type: "sqlite" }, auth: "github", plugins: { ...(REAL.plugins as object), [key]: [] } }, { platform: "linux" });
    expect(other("runner")).toThrow(/plugins\.runner is an empty list/);
    expect(other("llm")).toThrow(/plugins\.llm is an empty list/);
  });

  it("an unknown name in the list fails, naming plugins.source and the name", () => {
    const err = failure(["github-issues", "no-such-source"]);
    expect(err).toMatch(/plugins\.source/);
    expect(err).toContain("no-such-source");
    expect(err).toContain("github-issues");
  });

  it("a non-string entry fails, naming plugins.source", () => {
    expect(failure(["github-issues", 3])).toMatch(/plugins\.source/);
  });

  it("the same name twice fails, naming plugins.source and the name", () => {
    const err = failure(["github-issues", "github-issues"]);
    expect(err).toMatch(/plugins\.source/);
    expect(err).toContain("github-issues");
  });

  it("loadConfig reports the same failures at startup", async () => {
    const cfg = (source: unknown) => root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), source } });
    // No source at all starts (issue #282); an empty runner or llm chain does not.
    expect(selectedSources((await loadConfig(cfg([]), { registry })).plugins)).toEqual([]);
    const chain = (key: "runner" | "llm") => root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), [key]: [] } });
    await expect(loadConfig(chain("runner"), { registry })).rejects.toThrow(/plugins\.runner/);
    await expect(loadConfig(chain("llm"), { registry })).rejects.toThrow(/plugins\.llm/);
    await expect(loadConfig(cfg(["github-issues", "github-issues"]), { registry })).rejects.toThrow(/plugins\.source/);
    await expect(loadConfig(cfg(["github-issues", "nope"]), { registry })).rejects.toThrow(/plugins\.source/);
  });

  it("every listed source's secrets are declared", () => {
    const reg = withPlugin(registry, "source", "secret-source", () => new FakeSlackPollSource(), [
      { name: "SLACK_APP_TOKEN" as SecretName, purpose: "the test source's token" },
    ]);
    const names = (source: unknown) => declaredSecrets(reg, select(source, reg)).map((d) => d.name);
    expect(names(["github-issues", "secret-source"])).toContain("SLACK_APP_TOKEN");
    expect(names("github-issues")).not.toContain("SLACK_APP_TOKEN");
  });

  it("build() makes one adapter per listed source and hands them all to the controller", async () => {
    const made: FakeSlackPollSource[] = [];
    const reg = fakeSlackPollRegistry(REGISTRY, () => {
      const s = new FakeSlackPollSource();
      made.push(s);
      return s;
    });
    const dir = root({
      ...REAL,
      store: { type: "sqlite" },
      plugins: { ...(REAL.plugins as object), awake: "none", source: ["github-issues", "fake-slack-poll"] },
    });
    const built = await build(await loadConfig(dir, { registry: reg }), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      const sources = built.controller.kernel.sources;
      expect(sources).toHaveLength(2);
      expect(sources[0]).toBeInstanceOf(GitHubIssueSource);
      expect(made).toHaveLength(1);
      expect(sources[1]).toBe(made[0]);
    } finally {
      await built.close();
    }
  });

  it("build() refuses two listed sources of the same type, naming plugins.source", async () => {
    let reg = fakeSlackPollRegistry();
    reg = withPlugin(reg, "source", "fake-slack-poll-2", () => new FakeSlackPollSource());
    const dir = root({
      ...REAL,
      store: { type: "sqlite" },
      plugins: { ...(REAL.plugins as object), awake: "none", source: ["github-issues", "fake-slack-poll", "fake-slack-poll-2"] },
    });
    await expect(build(await loadConfig(dir, { registry: reg }), { clock: new FakeClock(), repoLookup: fakeRepoLookup })).rejects.toThrow(/plugins\.source.*slack_thread/);
  });
});

describe("plugin registry: KeepAwake startup check", () => {
  const caffeinateConfig = () =>
    root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "caffeinate" } });

  it("build() rejects caffeinate when no caffeinate executable is on PATH, naming the key and the none alternative", async () => {
    const loaded = await loadConfig(caffeinateConfig());
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-bin-")));
    const err = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup }).then(
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
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      expect((built.worker as unknown as { d: WorkerDeps }).d.awake).toBeInstanceOf(CaffeinateKeepAwake);
    } finally {
      await built.close();
    }
  });

  it("build() wires none without looking for caffeinate", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" }, plugins: { ...(REAL.plugins as object), awake: "none" } }));
    vi.stubEnv("PATH", mkdtempSync(join(tmpdir(), "sf-empty-bin-")));
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: fakeRepoLookup });
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
    const built = await build(await loadConfig(dir), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
    try {
      return (built.worker as unknown as { d: WorkerDeps }).d.capability;
    } finally {
      await built.close();
    }
  };

  it("the checked-in config selects bm25, and build() passes it to the worker", async () => {
    expect((REAL.plugins as Record<string, unknown>).capability).toBe("bm25");
    const c = await capabilityOf();
    expect(c).toBeInstanceOf(Bm25CapabilitySearch);
    expect((await c!.search("zebra", 8)).map((x) => x.id)).toEqual(["docs/guide.md"]);
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
    expect(classes).toContain("SqliteDriver");
    for (const f of ["compose.ts", "canary.ts", "setup.ts"]) {
      const text = readFileSync(join(REPO_ROOT, "src", f), "utf8");
      for (const name of classes) expect(text, `${f}: new ${name}`).not.toMatch(new RegExp(`new\\s+${name}\\b`));
    }
  });
});

describe("GitHub plugins (design 05-sources): one client per process, built by the credential plugin", () => {
  const GITHUB_DIR = join(PLUGIN_ROOT, "impl", "github");
  const srcFiles = (dir: string): string[] => findPluginFiles([dir], /\.ts$/);

  it("every GitHub descriptor imports its implementation inside create(), never at top level", () => {
    const files = [...findPluginFiles([GITHUB_DIR]), ...findPluginFiles([GITHUB_DIR], /\.grant\.ts$/)];
    expect(files.map((f) => f.slice(GITHUB_DIR.length + 1))).toEqual(expect.arrayContaining(["token.plugin.ts", "app.plugin.ts", "github-permission.grant.ts"]));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const topLevel = [...text.matchAll(/^import\s+(?!type\b)[^"]*from\s+"(\.[^"]+)"/gm)].map((m) => join(dirname(file), m[1]!));
      expect(topLevel.filter((p) => p.startsWith(join(PLUGIN_ROOT, "impl"))), file).toEqual([]);
      expect(text, file).toMatch(/\bimport\("\.\//);
    }
  });

  it("the token and app descriptors name their secrets themselves, and the implementations take the names from them", () => {
    for (const [descriptor, impl, secret] of [["token.plugin.ts", "token-credentials.ts", "GITHUB_TOKEN"], ["app.plugin.ts", "app-credentials.ts", "GITHUB_APP_ID"]] as const) {
      expect(readFileSync(join(GITHUB_DIR, descriptor), "utf8")).toContain(`export const ${secret} = secretName("${secret}")`);
      const text = readFileSync(join(GITHUB_DIR, impl), "utf8");
      expect(text).toContain(`import { ${secret} } from "./${descriptor.replace(/\.ts$/, ".js")}"`);
      expect(text).not.toContain(`secretName("${secret}")`);
    }
  });

  it("'new GitHubClient' appears under src/ only in the token and app credential files", () => {
    const users = srcFiles(join(REPO_ROOT, "src")).filter((f) => /new\s+GitHubClient\b/.test(readFileSync(f, "utf8")));
    expect(users.map((f) => f.slice(REPO_ROOT.length + 1)).sort()).toEqual(["src/impl/github/app-credentials.ts", "src/impl/github/token-credentials.ts"]);
  });

  it("build() makes one client and hands it to every context that needs one; only the broker and the forge get credentials", async () => {
    const credentials = { token: async () => null };
    const api = { tag: "the one client", shareBudget: () => {} } as unknown as GitHubApi;
    let made = 0;
    const seen: Record<string, Record<string, unknown>> = {};
    const record = <T>(kind: string, ctx: object, x: T): T => ((seen[kind] = ctx as Record<string, unknown>), x);
    let reg = withPlugin(REGISTRY, "github_auth", "app", () => (made++, { credentials, api }));
    reg = withPlugin(reg, "source", "github-issues", (c) => record("source", c, REGISTRY.source.plugins["github-issues"]!(c)));
    reg = withPlugin(reg, "auth", "github", (c) => record("auth", c, REGISTRY.auth.plugins.github!(c)));
    reg = withPlugin(reg, "forge", "github", (c) => record("forge", c, REGISTRY.forge.plugins.github!(c)));
    reg = withPlugin(reg, "broker", "github", (c) => record("broker", c, {} as ToolBroker));
    const grant = GRANTS["github-permission"]!;
    const create = vi.spyOn(grant, "create").mockImplementation((c) => record("grant", c, { remote: true, roles: async () => [], denies: async () => false }));
    const dir = root({ ...REAL, store: { type: "sqlite" }, tool_grants: undefined, plugins: { ...(REAL.plugins as object), awake: "none", source: ["github-issues"] } });
    try {
      const built = await build(await loadConfig(dir, { registry: reg }), { clock: new FakeClock(), repoLookup: fakeRepoLookup });
      await built.close();
    } finally {
      create.mockRestore();
    }
    expect(made).toBe(1);
    for (const kind of ["source", "auth", "grant", "forge", "broker"]) {
      expect(seen[kind]?.github, kind).toBe(api);
      expect(seen[kind]!.repo, kind).toEqual({ owner: (REAL.repo as { owner: string }).owner, name: (REAL.repo as { name: string }).name });
    }
    for (const kind of ["source", "auth", "grant"]) {
      expect(Object.keys(seen[kind]!), kind).not.toContain("credentials");
      expect(Object.keys(seen[kind]!), kind).not.toContain("token");
      expect(Object.values(seen[kind]!), kind).not.toContain(credentials);
    }
    expect(seen.broker!.credentials).toBe(credentials);
    // The forge's writes are outbound's (RFC 0015 M7): its run pushes need them.
    expect(seen.forge!.credentials).toBe(credentials);
  });

  it("Plugins.githubApi() builds the credential plugin once and returns its client every time", async () => {
    const api = {} as GitHubApi;
    let made = 0;
    const reg = withPlugin(REGISTRY, "github_auth", "app", () => (made++, { credentials: { token: async () => null }, api }));
    const p = new Plugins(await loadConfig(root({ ...REAL, store: { type: "sqlite" } }), { registry: reg }));
    expect(await p.githubApi()).toBe(api);
    expect(await p.githubApi()).toBe(api);
    expect(made).toBe(1);
  });

  it("the github-issues plugin's setup hook creates the intake, status and PR flag labels", async () => {
    const loaded = await loadConfig(root({ ...REAL, store: { type: "sqlite" } }));
    const hooks = selectedSetups(loaded.registry, loaded.plugins);
    expect(hooks.map((h) => `${h.kind}/${h.name}`)).toContain("source/github-issues");
    expect(selectedSetups(loaded.registry, { ...loaded.plugins, source: "local", sources: ["local"] }).map((h) => h.name)).not.toContain("github-issues");
    const posted: string[] = [];
    const github = {
      request: async (method: string, path: string, body?: { name: string }) => (posted.push(`${method} ${path} ${body?.name}`), {}),
    } as unknown as GitHubApi;
    const lines: string[] = [];
    await hooks.find((h) => h.name === "github-issues")!.setup({ ...new Plugins(loaded).base, github, print: (l) => lines.push(l) });
    const { owner, name } = loaded.config.repo;
    expect(posted[0]).toBe(`POST /repos/${owner}/${name}/labels ${loaded.config.intake_label}`);
    expect(posted).toContain(`POST /repos/${owner}/${name}/labels ${loaded.config.status_label_prefix}triaging`);
    expect(posted).toContain(`POST /repos/${owner}/${name}/labels ${loaded.config.status_label_prefix}incomplete`);
    expect(lines[0]).toBe(`   "${loaded.config.intake_label}": created`);
  });
});

describe("connect hooks (factory setup <kind> <command>)", () => {
  const API_URL = pathToFileURL(join(REPO_ROOT, "src", "plugin-api.ts")).href;
  /** A temp folder with one calendar (or `kind`) descriptor whose `connect` field is `connect`. */
  const descriptorDir = (connect: string, kind = "calendar", name = "fixture-cal"): string => {
    const dir = mkdtempSync(join(tmpdir(), "sf-connect-"));
    writeFileSync(
      join(dir, `${name}.plugin.ts`),
      `import { definePlugin } from ${JSON.stringify(API_URL)};\n` +
        `export default definePlugin({ kind: ${JSON.stringify(kind)}, name: ${JSON.stringify(name)}, create: () => ({}), connect: ${connect} });\n`,
    );
    return dir;
  };
  const hook = (command: string) => `{ command: ${JSON.stringify(command)}, connect: async () => {}, disconnect: async () => {} }`;
  const failure = (p: Promise<unknown>) => p.then(() => null, (e: Error) => e.message);

  it("the registry lists each kind's connect hooks by plugin name, as it lists setups", () => {
    for (const kind of PLUGIN_KINDS) expect(typeof REGISTRY[kind].connects, kind).toBe("object");
    expect(REGISTRY.calendar.connects["google-calendar"]?.command).toBe("google");
    expect(connectHooks(REGISTRY).map((h) => `${h.kind}/${h.name}/${h.hook.command}`)).toContain("calendar/google-calendar/google");
    for (const h of connectHooks(REGISTRY)) expect(Object.keys(REGISTRY[h.kind].plugins), h.name).toContain(h.name);
  });

  it("a descriptor's connect field is loaded into its kind's entry", async () => {
    const registry = await loadRegistry([PLUGIN_ROOT, descriptorDir(hook("fixture"))]);
    expect(registry.calendar.connects["fixture-cal"]?.command).toBe("fixture");
    expect(connectHooks(registry).map((h) => h.name)).toEqual(expect.arrayContaining(["google-calendar", "fixture-cal"]));
  });

  it("a bad connect field, a kind other than calendar, or a command taken twice fails startup", async () => {
    expect(await failure(loadRegistry([PLUGIN_ROOT, descriptorDir("{ command: 'Bad Word', connect: async () => {} }")]))).toMatch(/connect must be/);
    expect(await failure(loadRegistry([PLUGIN_ROOT, descriptorDir(hook("x"), "clock", "fixture-clock")]))).toMatch(/clock plugins take no connect hook/);
    expect(await failure(loadRegistry([PLUGIN_ROOT, descriptorDir(hook("google"))]))).toMatch(/two connect hooks for "setup calendar google": google-calendar and fixture-cal/);
  });
});

/** An interface name in kebab-case, the name of its topic file: KeepAwake → keep-awake, GitHubCredentials → github-credentials. */
const kebab = (name: string): string =>
  name
    .replace(/GitHub/g, "Github")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();

describe("docs/plugins/<interface>.md", () => {
  /** An interface's topic file, `docs/plugins/<kebab name>.md`, without its History section; null when the file is missing. */
  const section = (name: string): string | null => {
    const file = join(REPO_ROOT, "docs", "plugins", `${kebab(name)}.md`);
    if (!existsSync(file)) return null;
    return readFileSync(file, "utf8").split(/^## History\b/m)[0]!;
  };

  it("names topic files in kebab-case", () => {
    expect(kebab("KeepAwake")).toBe("keep-awake");
    expect(kebab("LLMProvider")).toBe("llm-provider");
    expect(kebab("GitHubCredentials")).toBe("github-credentials");
    expect(kebab("Clock")).toBe("clock");
    expect(kebab("FactoryStore")).toBe("factory-store");
  });

  it("reads no section for an interface without a topic file", () => {
    expect(section("NoSuchInterface")).toBeNull();
  });

  for (const kind of PLUGIN_KINDS) {
    const entry = REGISTRY[kind];
    it(`has docs/plugins/${kebab(entry.interface)}.md naming every ${kind} plugin`, () => {
      const s = section(entry.interface);
      expect(s, `docs/plugins/${kebab(entry.interface)}.md`).not.toBeNull();
      for (const name of Object.keys(entry.plugins)) expect(s).toContain(`\`${name}\``);
      if (entry.guard) expect(s).toMatch(/cannot be disabled/);
    });
  }

  it("docs/plugins.md lists every registered plugin in its interface's row", () => {
    const rows = new Map<string, string>();
    for (const line of readFileSync(join(REPO_ROOT, "docs", "plugins.md"), "utf8").split("\n")) {
      const cells = line.split("|").map((c) => c.trim());
      if (cells.length < 4 || !cells[1]) continue;
      rows.set(cells[1].replace(/\s*\(.*$/, ""), cells[2]!);
    }
    for (const kind of PLUGIN_KINDS) {
      const entry = REGISTRY[kind];
      const cell = rows.get(entry.interface);
      expect(cell, `docs/plugins.md row for ${entry.interface}`).toBeDefined();
      for (const name of Object.keys(entry.plugins)) expect(cell, `${entry.interface} row names \`${name}\``).toContain(`\`${name}\``);
    }
  });

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

  it("covers every interface in the registry, the tacit ledger among them", () => {
    expect(PLUGIN_KINDS).toEqual(Object.keys(REGISTRY));
    expect(PLUGIN_KINDS).toContain("tacit");
  });
});

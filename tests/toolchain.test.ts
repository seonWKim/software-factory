import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLCHAIN_PLACEHOLDER, checkToolchainEnv, fillPrompt, loadConfig, toolchainConfig } from "../src/compose.js";
import type { FactoryConfig, ToolchainConfig } from "../src/core/config.js";
import { keyRefusal, PR_ONLY_KEYS } from "../src/core/settings.js";
import { FORBIDDEN_ENV } from "../src/core/tools/index.js";
import { WARM_FAILED } from "../src/core/worker.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { TOOLCHAIN_HOMES, buildAgentEnv } from "../src/impl/runner/claude-code-runner.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions } from "../src/interfaces/sandbox.js";
import { doctorChecks, toolchainChecks } from "../src/setup.js";
import { config, pipeline } from "./helpers/fakes.js";

// The `toolchain` block (design 05-sandbox.md, issue #334): read-only caches, non-secret agent env, and a warm
// step the worker runs before the agent. With no block, everything is as it was before the block existed.

const REPO_ROOT = join(import.meta.dirname, "..");
const REAL = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
const TEMPLATE = "Run: {{check_commands}}.{{toolchain}} Done.";

afterEach(() => vi.unstubAllEnvs());

/** A code root with the real config plus `extra`, prompts made of TEMPLATE, a fake HOME and secret file. */
function root(extra: Record<string, unknown> = {}): { dir: string; home: string } {
  const dir = mkdtempSync(join(tmpdir(), "sf-toolchain-"));
  const home = join(dir, "home");
  mkdirSync(home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(home, ".config", "software-factory", ".env"));
  mkdirSync(join(dir, "prompts"));
  for (const p of ["triage", "implement", "review", "resolve"]) writeFileSync(join(dir, "prompts", `${p}.md`), TEMPLATE);
  writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" }, state_dir: "state", ...extra }));
  return { dir, home };
}
const load = (dir: string) => loadConfig(dir, { platform: "linux" });

describe("toolchain config", () => {
  it("parses caches (a leading ~ is HOME), env and warm_command", async () => {
    const { dir, home } = root({ toolchain: { caches: ["~/.gradle/caches", "/opt/m2"], env: { GRADLE_RO_DEP_CACHE: "/opt/g" }, warm_command: ["./gradlew", "dependencies"] } });
    expect((await load(dir)).config.toolchain).toEqual({
      caches: [join(home, ".gradle", "caches"), "/opt/m2"],
      env: { GRADLE_RO_DEP_CACHE: "/opt/g" },
      warm_command: ["./gradlew", "dependencies"],
    });
  });

  it("warm_command defaults to repo.install_command", async () => {
    const { dir } = root({ toolchain: { caches: [] } });
    const loaded = await load(dir);
    expect(loaded.config.toolchain?.warm_command).toEqual(loaded.config.repo.install_command);
  });

  it("an unknown toolchain key fails startup with a suggestion", async () => {
    const { dir } = root({ toolchain: { cache: [] } });
    await expect(load(dir)).rejects.toThrow(/unknown config key "cache" at toolchain\.cache.*did you mean "caches"/);
  });

  it("is a PR-only key: settings set refuses it", () => {
    expect(PR_ONLY_KEYS).toContain("toolchain");
    expect(keyRefusal("toolchain")).toMatch(/changes by PR only/);
  });

  it("a relative cache or a non-string env value fails startup naming the entry", async () => {
    await expect(load(root({ toolchain: { caches: ["build/cache"] } }).dir)).rejects.toThrow(/toolchain\.caches\[0\] must be an absolute folder/);
    await expect(load(root({ toolchain: { env: { JAVA_OPTS: 1 } } }).dir)).rejects.toThrow(/toolchain\.env\.JAVA_OPTS must be a string/);
  });
});

describe("G1: a toolchain env entry that looks like a credential fails startup", () => {
  it("a credential-looking or factory-owned key fails, naming the entry", async () => {
    for (const key of ["GITHUB_TOKEN", "NPM_TOKEN", "MAVEN_PASSWORD", "MY_API_KEY", "PATH", "HOME", "CLAUDE_CONFIG_DIR", "GIT_CONFIG_GLOBAL", "ANTHROPIC_BASE_URL"]) {
      await expect(load(root({ toolchain: { env: { [key]: "x" } } }).dir), key).rejects.toThrow(new RegExp(`toolchain\\.env\\.${key}.*\\(G1\\)`));
    }
  });

  it("a value matching a secret pattern or a known secret fails, naming the entry and never the value", async () => {
    const token = `ghp_${"a1".repeat(18)}`;
    const known = "known-secret-value-42";
    const scanner = new PatternEgressScanner(async () => [known]);
    const tc = (env: Record<string, string>): ToolchainConfig => ({ caches: [], env, warm_command: ["true"] });
    const err = await checkToolchainEnv(tc({ JAVA_OPTS: "-Xmx1g", REGISTRY_AUTH: token }), scanner).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/toolchain\.env\.REGISTRY_AUTH looks like a credential \(github_token\) \(G1\)/);
    expect((err as Error).message).not.toContain(token);
    expect((err as Error).message).not.toContain("JAVA_OPTS");
    await expect(checkToolchainEnv(tc({ MAVEN_OPTS: `-Dx=${known}` }), scanner)).rejects.toThrow(/toolchain\.env\.MAVEN_OPTS.*known_secret/);
    await expect(checkToolchainEnv(tc({ JAVA_OPTS: "-Xmx1g" }), scanner)).resolves.toBeUndefined();
    await expect(checkToolchainEnv(undefined, scanner)).resolves.toBeUndefined();
  });

  it("build() runs the value check with the configured scanner before it builds the runner", () => {
    const src = readFileSync(join(REPO_ROOT, "src", "compose.ts"), "utf8");
    const body = src.slice(src.indexOf("export async function build("));
    expect(body.indexOf("await checkToolchainEnv(loaded.config.toolchain, scanner)")).toBeGreaterThan(body.indexOf("p.scanner(secrets)"));
    expect(body.indexOf("await checkToolchainEnv(")).toBeLessThan(body.indexOf("p.runner("));
  });

  it("the runner checks the keys again when it builds the env", () => {
    const cred = { name: "CLAUDE_CODE_OAUTH_TOKEN" as const, value: "v" };
    expect(() => buildAgentEnv({ env_allowlist: {}, toolchain_env: { GH_TOKEN: "x" } }, cred, { home: "/h", claudeConfigDir: "/c", path: "/bin" })).toThrow(/G1/);
  });
});

describe("a cache that overlaps a denied path fails startup", () => {
  it("in either direction: the secret file's folder, a cache inside a denied path, a denied path inside the cache", async () => {
    const cases: [string, RegExp][] = [
      ["~/.config", /software-factory/], // holds the secret file's folder
      ["~/.config/software-factory/cache", /software-factory/], // inside the secret file's folder
      ["~/.ssh/known", /\.ssh/], // inside a deny_paths entry
      ["~", /\.ssh/], // holds every home deny entry
    ];
    for (const [cache, denied] of cases) {
      const err = await load(root({ toolchain: { caches: [cache] } }).dir).catch((e: Error) => e);
      expect(err, cache).toBeInstanceOf(Error);
      expect((err as Error).message, cache).toMatch(/toolchain\.caches\[0\] \S+ overlaps the denied path/);
      expect((err as Error).message, cache).toMatch(denied);
    }
  });

  it("a cache beside the denied paths loads", async () => {
    const { dir, home } = root({ toolchain: { caches: ["~/.gradle", "~/.config-cache"] } });
    expect((await load(dir)).config.toolchain?.caches).toEqual([join(home, ".gradle"), join(home, ".config-cache")]);
  });

  it("toolchainConfig takes the denied paths it is given", () => {
    expect(() => toolchainConfig({ caches: ["/srv/cache"] }, { home: "/h", install_command: ["make"], deny_paths: ["/srv"] })).toThrow(/overlaps the denied path \/srv/);
  });
});

describe("an agent run with a toolchain block", () => {
  const cred = { name: "CLAUDE_CODE_OAUTH_TOKEN" as const, value: "oauth-v" };
  const paths = { home: "/homes/run_1", claudeConfigDir: "/c", path: "/usr/bin" };

  it("sees the env entries and per-run toolchain homes inside its TMPDIR; the factory's own entries win", () => {
    const env = buildAgentEnv({ env_allowlist: { GIT_AUTHOR_NAME: "bot" }, toolchain_env: { GRADLE_RO_DEP_CACHE: "/home/u/.gradle/caches" } }, cred, paths);
    expect(env.GRADLE_RO_DEP_CACHE).toBe("/home/u/.gradle/caches");
    for (const [key, dir] of Object.entries(TOOLCHAIN_HOMES)) expect(env[key]).toBe(`/homes/run_1/tmp/toolchain/${dir}`);
    expect(env.HOME).toBe("/homes/run_1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    // A declared entry may point a tool home elsewhere (e.g. at a read-only cache).
    expect(buildAgentEnv({ env_allowlist: {}, toolchain_env: { CARGO_HOME: "/x" } }, cred, paths).CARGO_HOME).toBe("/x");
  });

  it("without the block the env has exactly the keys it had before", () => {
    const env = buildAgentEnv({ env_allowlist: { GIT_AUTHOR_NAME: "bot" } }, cred, paths);
    expect(Object.keys(env).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "CLAUDE_CONFIG_DIR", "DISABLE_AUTOUPDATER", "GIT_AUTHOR_NAME",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH", "TERM", "TMPDIR",
    ]);
  });
});

describe("prompts name the offline check command", () => {
  const repo = (over: Partial<FactoryConfig["repo"]> = {}): FactoryConfig["repo"] =>
    ({ owner: "o", name: "n", path: ".", base_branch: "main", install_command: ["make", "deps"], test_command: ["make", "unit"], ...over }) as FactoryConfig["repo"];
  const tc: ToolchainConfig = { caches: ["/home/u/.gradle/caches"], env: {}, warm_command: ["./gradlew", "dependencies"] };

  it.each(["implement", "review", "resolve"])("prompts/%s.md: the checks from check_commands, said to run offline from the caches", (name) => {
    const text = readFileSync(join(REPO_ROOT, "prompts", `${name}.md`), "utf8");
    expect(text).toContain(TOOLCHAIN_PLACEHOLDER);
    const out = fillPrompt(text, repo({ check_commands: [["./gradlew", "--offline", "test"]] }), "local", tc);
    expect(out).toMatch(/`\.\/gradlew --offline test`\. They run offline: there is no network, and the toolchain caches \(`\/home\/u\/\.gradle\/caches`\) are read-only/);
    expect(out).not.toContain("{{");
    // The test_command fallback.
    expect(fillPrompt(text, repo(), "local", tc)).toMatch(/`make unit`\. They run offline/);
  });

  it.each(["implement", "review", "resolve"])("prompts/%s.md without a toolchain block: the text before the placeholder existed", (name) => {
    const text = readFileSync(join(REPO_ROOT, "prompts", `${name}.md`), "utf8");
    const before = text.split(TOOLCHAIN_PLACEHOLDER).join("");
    expect(fillPrompt(text, repo(), "local")).toBe(fillPrompt(before, repo(), "local"));
    expect(fillPrompt(text, repo(), "local")).not.toMatch(/offline|toolchain/);
  });

  it("loadConfig fills them from the block, and leaves them as before without it", async () => {
    const without = await load(root().dir);
    expect(without.prompts.implement).toBe("Run: `npm run typecheck`, then `npm test`. Done.");
    const withBlock = await load(root({ toolchain: { caches: ["/opt/cache"] } }).dir);
    for (const p of [withBlock.prompts.implement, withBlock.prompts.review, withBlock.prompts.resolve]) {
      expect(p).toMatch(/^Run: `npm run typecheck`, then `npm test`\. They run offline: .*`\/opt\/cache`.* Done\.$/);
    }
  });
});

describe("the worker's warm step", () => {
  const toolchain: ToolchainConfig = { caches: ["/home/u/.gradle/caches"], env: { GRADLE_RO_DEP_CACHE: "/home/u/.gradle/caches" }, warm_command: ["./gradlew", "dependencies"] };
  const WARM = "./gradlew dependencies";

  /** A pipeline whose agent calls record the non-git commands run before each, and the warm command's env. */
  async function world(cfg: Partial<FactoryConfig>) {
    const before: Record<string, string[][]> = {};
    const envs: Record<string, string>[] = [];
    const f = await pipeline({ config: { ...cfg, repo: { ...config.repo, check_commands: [["./gradlew", "--offline", "test"]] } } });
    for (const role of ["triage", "implement", "review"] as const) {
      const scripted = f.runner.script[role] ?? (() => ({}));
      f.runner.script[role] = (spec: AgentRunSpec) => ((before[role] ??= []).push([...f.sandbox.commands]), scripted(spec));
    }
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = (h, cmd, o: ExecOptions) => {
      if (cmd.join(" ") === WARM) envs.push({ ...o.env });
      return exec(h, cmd, o);
    };
    return { f, before, envs };
  }

  it("runs warm_command before the implement and review agents, not before triage, without credentials", async () => {
    const { f, before, envs } = await world({ toolchain });
    await f.submit();
    await f.step();
    expect(f.agentCalls("implement")).toBe(1);
    expect(f.agentCalls("review")).toBe(1);
    expect(before.triage![0]).not.toContain(WARM);
    expect(before.implement![0]).toContain(WARM);
    // Once per run: the review run warms its own folder.
    expect(f.sandbox.commands.filter((c) => c === WARM).length).toBe(2);
    expect(before.review![0]!.filter((c) => c === WARM).length).toBe(2);
    for (const env of envs) for (const key of Object.keys(env)) expect(FORBIDDEN_ENV.test(key), key).toBe(false);
    // The agent gets the caches to read and the env entries.
    const spec = f.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.readable_paths).toEqual(toolchain.caches);
    expect(spec.toolchain_env).toEqual(toolchain.env);
    expect(spec.writable_paths).toEqual([]);
  });

  it("a failing warm_command fails the run before the agent starts, naming the command", async () => {
    const { f } = await world({ toolchain });
    f.sandbox.exits[WARM] = 1;
    const item = await f.submit();
    await f.step();
    expect(f.agentCalls("implement")).toBe(0);
    const run = (await f.runs(item, "implement"))[0]!;
    expect(run.outcome).toMatchObject({ status: "failed", error_code: WARM_FAILED, detail: expect.stringContaining(`\`${WARM}\` exited 1`) });
  });

  it("with no toolchain block: no warm step, and the agent spec has no toolchain fields", async () => {
    const { f, before } = await world({});
    await f.submit();
    await f.step();
    expect(f.agentCalls("implement")).toBe(1);
    expect(f.sandbox.commands).not.toContain(WARM);
    for (const spec of f.runner.specs) {
      expect(spec).not.toHaveProperty("readable_paths");
      expect(spec).not.toHaveProperty("toolchain_env");
    }
  });
});

describe("factory doctor: toolchain caches", () => {
  it("a missing cache is a warn, an existing one ok, an overlap with a denied path a FAIL", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-toolchain-doctor-"));
    const present = join(dir, "present");
    mkdirSync(present);
    const secrets = join(dir, "secrets");
    const checks = await toolchainChecks({
      deny_paths: [secrets],
      toolchain: { caches: [present, join(dir, "missing"), dir], env: {}, warm_command: ["true"] },
    });
    expect(checks).toEqual([
      { ok: true, msg: `toolchain cache ${present} exists (read-only for agents)` },
      { ok: false, warn: true, msg: `toolchain cache ${join(dir, "missing")} does not exist (the warm step may create it)` },
      { ok: false, msg: `toolchain cache ${dir} overlaps the denied path ${secrets}` },
    ]);
    expect(await toolchainChecks({ deny_paths: [secrets] })).toEqual([]);
  });

  it("doctorChecks reports them", async () => {
    const { dir, home } = root({ toolchain: { caches: ["~/.gradle"] } });
    const loaded = await load(dir);
    const lines = (await doctorChecks(loaded)).map((c) => c.msg);
    expect(lines).toContain(`toolchain cache ${join(home, ".gradle")} does not exist (the warm step may create it)`);
    const overlapping = { ...loaded, config: { ...loaded.config, toolchain: { ...loaded.config.toolchain!, caches: [home] } } };
    const failed = (await doctorChecks(overlapping)).filter((c) => !c.ok && !c.warn).map((c) => c.msg);
    expect(failed).toContain(`toolchain cache ${home} overlaps the denied path ${join(home, ".ssh")}`);
  });
});

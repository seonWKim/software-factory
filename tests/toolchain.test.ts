import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOLCHAIN_PLACEHOLDER, checkToolchainEnv, fillPrompt, loadConfig, toolchainConfig } from "../src/compose.js";
import type { FactoryConfig, ToolchainConfig } from "../src/core/config.js";
import { keyRefusal, PR_ONLY_KEYS } from "../src/core/settings.js";
import { Edit, FORBIDDEN_ENV, Read, Write, guardPolicy, type ToolContext } from "../src/core/tools/index.js";
import { WARM_FAILED, Worker } from "../src/worker/index.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { ClaudeCodeRunner, TOOLCHAIN_HOMES, buildAgentEnv, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import type { ExecOptions, ExecResult, Sandbox } from "../src/interfaces/sandbox.js";
import { doctorChecks, toolchainChecks } from "../src/setup.js";
import { config, pipeline } from "./helpers/fakes.js";

// The `toolchain` block (design 05-sandbox.md, issue #334): read-only caches, non-secret agent env, and a warm
// step the worker runs before the agent. With no block, everything is as it was before the block existed.

const REPO_ROOT = join(import.meta.dirname, "..");
// The real config without its own toolchain block (this repo's warm step, issue #573): each test sets its own.
const { toolchain: _realToolchain, ...REAL } = JSON.parse(readFileSync(join(REPO_ROOT, "factory.config.json"), "utf8")) as Record<string, unknown>;
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

// Read-only input folders (design 05-sandbox.md): `read_only_inputs`, a project's source data outside its repo,
// read by the agents and never written. The same parsing, deny-path check, read allow list and doctor report as
// the toolchain caches. With no key, everything is as it was before the key existed.
describe("read_only_inputs", () => {
  it("parses absolute folders and a leading ~ (the owner's HOME), normalized like the caches", async () => {
    const { dir, home } = root({ read_only_inputs: ["~/data/resume", "/srv/in/../inputs/"] });
    expect((await load(dir)).config.read_only_inputs).toEqual([join(home, "data", "resume"), "/srv/inputs"]);
  });

  it("a relative folder or a non-list fails startup naming the entry", async () => {
    await expect(load(root({ read_only_inputs: ["data/resume"] }).dir)).rejects.toThrow(/read_only_inputs\[0\] must be an absolute folder/);
    await expect(load(root({ read_only_inputs: "/srv/inputs" }).dir)).rejects.toThrow(/read_only_inputs must be a list of absolute folders/);
  });

  it("a folder that is, holds or lies inside a denied path fails startup, naming both paths", async () => {
    for (const input of ["~/.ssh", "~/.ssh/known", "~"]) {
      const { dir, home } = root({ read_only_inputs: ["/srv/inputs", input] });
      const err = await load(dir).catch((e: Error) => e);
      expect(err, input).toBeInstanceOf(Error);
      const path = input === "~" ? home : join(home, input.slice(2));
      expect((err as Error).message, input).toContain(`read_only_inputs[1] ${path} overlaps the denied path ${join(home, ".ssh")}`);
      expect((err as Error).message, input).not.toContain("read_only_inputs[0]");
    }
  });

  it("an absent key changes nothing: no field, no readable path, no doctor line", async () => {
    const loaded = await load(root().dir);
    expect(loaded.config).not.toHaveProperty("read_only_inputs");
    expect((await doctorChecks(loaded)).map((c) => c.msg).join("\n")).not.toMatch(/read-only input/);
  });

  it("the agents may read each input folder, never write it, with or without a toolchain block", async () => {
    const inputs = ["/srv/inputs/resume"];
    const only = await pipeline({ config: { read_only_inputs: inputs } });
    await only.submit();
    await only.step();
    const spec = only.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.readable_paths).toEqual(inputs);
    expect(spec.writable_paths).toEqual([]);
    expect(spec).not.toHaveProperty("toolchain_env");
    // No toolchain block: no warm step either.
    expect(only.sandbox.commands.join("\n")).not.toContain("npm ci");
    const toolchain: ToolchainConfig = { caches: ["/home/u/.gradle"], env: {}, warm_command: ["true"] };
    const both = await pipeline({ config: { toolchain, read_only_inputs: inputs } });
    await both.submit();
    await both.step();
    expect(both.runner.specs.find((s) => s.role === "implement")!.readable_paths).toEqual([...toolchain.caches, ...inputs]);
  });

  it("the harness settings read-allow and write-deny each input folder; the shared Write and Edit tools refuse it", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "sf-inputs-")));
    const workdir = join(base, "wt");
    const input = join(base, "resume");
    mkdirSync(workdir);
    mkdirSync(input);
    writeFileSync(join(input, "cv.md"), "experience\n");
    const spec = { deny_paths: [join(base, "secrets")], writable_paths: [], readable_paths: [input] };
    const s = buildHarnessSettings(spec, workdir) as {
      permissions: { allow: string[]; deny: string[] };
      sandbox: { filesystem: { allowWrite: string[]; allowRead?: string[]; denyWrite?: string[] } };
    };
    expect(s.sandbox.filesystem.allowRead).toContain(input);
    expect(s.sandbox.filesystem.denyWrite).toContain(input);
    expect(s.sandbox.filesystem.allowWrite).not.toContain(input);
    expect(s.permissions.allow.some((r) => r.includes(input))).toBe(false);
    expect(s.permissions.deny).toContain(`Edit(/${input}/**)`);
    const ctx: ToolContext = {
      sandbox: new NoOpSandbox(base),
      handle: { id: "sbx_inputs", workdir, base_sha: "" },
      policy: guardPolicy({ workdir, ...spec, env_allowlist: {} }),
    };
    expect(await Read.run({ file_path: join(input, "cv.md") }, ctx)).toMatchObject({ ok: true, content: expect.stringContaining("experience") });
    expect(await Write.run({ file_path: join(input, "new.md"), content: "x" }, ctx)).toMatchObject({ ok: false });
    expect(await Edit.run({ file_path: join(input, "cv.md"), old_string: "experience", new_string: "changed" }, ctx)).toMatchObject({ ok: false });
    expect(readFileSync(join(input, "cv.md"), "utf8")).toBe("experience\n");
    expect(existsSync(join(input, "new.md"))).toBe(false);
  });

  it("factory doctor lists each input folder, and a FAIL for one that overlaps a denied path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-inputs-doctor-"));
    const present = join(dir, "present");
    mkdirSync(present);
    const secrets = join(dir, "secrets");
    expect(await toolchainChecks({ deny_paths: [secrets], read_only_inputs: [present, join(dir, "missing"), dir] })).toEqual([
      { ok: true, msg: `read-only input ${present} exists (read-only for agents)` },
      { ok: false, warn: true, msg: `read-only input ${join(dir, "missing")} does not exist` },
      { ok: false, msg: `read-only input ${dir} overlaps the denied path ${secrets}` },
    ]);
    const { dir: cfg, home } = root({ read_only_inputs: ["~/data/resume"] });
    const lines = (await doctorChecks(await load(cfg))).map((c) => c.msg);
    expect(lines).toContain(`read-only input ${join(home, "data", "resume")} does not exist`);
  });
});

// The warmed Gradle wrapper distribution (design 05-sandbox.md): with a toolchain block, the worker names the
// owner's `~/.gradle/wrapper/dists` (when it exists and the run folder has gradlew) as a seed, and the runner copies
// it into the run's own GRADLE_USER_HOME before the agent starts. The source is never written or made readable.
describe("the warmed Gradle wrapper distribution", () => {
  const toolchain: ToolchainConfig = { caches: ["/home/u/.gradle/caches"], env: { GRADLE_RO_DEP_CACHE: "/home/u/.gradle/caches" }, warm_command: ["./gradlew", "dependencies"] };
  const HOME = "/home/u";
  const SOURCE = "/home/u/.gradle/wrapper/dists";

  async function world(cfg: Partial<FactoryConfig>) {
    const f = await pipeline({ config: cfg });
    for (const w of [f.w1, f.w2]) w.d.toolEnv = { HOME };
    return f;
  }

  it("names the owner's wrapper dists as a seed when it exists and the run folder has gradlew", async () => {
    const f = await world({ toolchain });
    await f.submit();
    await f.step();
    const spec = f.runner.specs.find((s) => s.role === "implement")!;
    expect(spec.toolchain_seeds).toEqual([SOURCE]);
    expect(f.sandbox.commands).toContain("test -f gradlew");
    expect(f.sandbox.commands).toContain(`test -d ${SOURCE}`);
    // Never a readable cache or a write root.
    expect(spec.readable_paths).toEqual(toolchain.caches);
    expect(spec.writable_paths).toEqual([]);
  });

  it("a missing source or no gradlew: no seed, and the run goes on", async () => {
    for (const missing of [`test -d ${SOURCE}`, "test -f gradlew"]) {
      const f = await world({ toolchain });
      f.sandbox.exits[missing] = 1;
      await f.submit();
      await f.step();
      expect(f.agentCalls("implement"), missing).toBe(1);
      expect(f.runner.specs.find((s) => s.role === "implement")!.toolchain_seeds, missing).toEqual([]);
    }
  });

  it("no toolchain block: no seed field and no check", async () => {
    const f = await world({});
    await f.submit();
    await f.step();
    for (const spec of f.runner.specs) expect(spec).not.toHaveProperty("toolchain_seeds");
    expect(f.sandbox.commands.some((c) => c.startsWith("test "))).toBe(false);
  });

  it("a source that overlaps a denied path fails startup, naming both paths", async () => {
    const f = await pipeline({ config: { toolchain } });
    for (const denied of ["/home/u/.gradle", "/home/u/.gradle/wrapper/dists/x"]) {
      const config = { ...f.config, deny_paths: [...f.config.deny_paths, denied] };
      expect(() => new Worker({ ...f.w1.d, config, toolEnv: { HOME } }), denied).toThrow(`${SOURCE} overlaps the denied path ${denied}`);
      // No block: nothing to check.
      const { toolchain: _block, ...without } = config;
      expect(() => new Worker({ ...f.w1.d, config: without, toolEnv: { HOME } })).not.toThrow();
    }
  });

  /** A real run folder: the owner's warmed dists with one file, and a runner whose sandbox records what the agent saw. */
  function seeded() {
    const base = mkdtempSync(join(tmpdir(), "sf-seeds-"));
    const source = join(base, "owner", ".gradle", "wrapper", "dists");
    const bin = join(source, "gradle-8.12.1-bin", "abc", "gradle-8.12.1", "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "gradle"), "#!/bin/sh\n", { mode: 0o555 });
    chmodSync(join(source, "gradle-8.12.1-bin", "abc"), 0o555); // a read-only source folder still gives a writable copy
    const seen: { env: Record<string, string>; copied: boolean; writable: boolean }[] = [];
    const sandbox: Sandbox = {
      create: async () => ({ id: "s", workdir: base }),
      updateBase: async () => "base",
      exec: async (_h, _cmd, o): Promise<ExecResult> => {
        const env = { ...o.env };
        const dists = join(env.GRADLE_USER_HOME ?? join(base, "none"), "wrapper", "dists");
        const copied = existsSync(join(dists, "gradle-8.12.1-bin", "abc", "gradle-8.12.1", "bin", "gradle"));
        let writable = false;
        if (copied) {
          writeFileSync(join(dists, "gradle-8.12.1-bin", "abc", "gradle-8.12.1.zip.lck"), "");
          writable = true;
        }
        seen.push({ env, copied, writable });
        return { exit_code: 0, signal: null, stdout: "", stderr: "", timed_out: false };
      },
      copyIn: async () => {},
      copyOut: async () => {},
      destroy: async () => {},
    };
    const runner = new ClaudeCodeRunner({
      sandbox, secrets: { get: async () => ({ reveal: () => "x" }) as never, valuesForScan: async () => [] },
      claudeConfigDir: join(base, "cfg"), homesDir: join(base, "homes"), models: { cheap: "c", standard: "s", strong: "x" },
    });
    const spec = (over: Partial<AgentRunSpec>): AgentRunSpec => ({
      run_id: "run_1", work_item_id: "wi_1", role: "implement", sandbox: { id: "s", workdir: base }, system_prompt: "s", prompt: "p",
      tools: [Read], tool_grants: [], lease_token: 1, env_allowlist: {}, deny_paths: [], writable_paths: [], model_class: "standard",
      timeout_ms: 30_000, signal: new AbortController().signal, ...over,
    }) as AgentRunSpec;
    const snapshot = () => execFileSync("ls", ["-lR", source], { encoding: "utf8" });
    return { base, source, runner, spec, seen, snapshot };
  }

  it("the runner copies the seed into the run's GRADLE_USER_HOME before the agent starts; the copy is writable and the source unchanged", async () => {
    const { base, source, runner, spec, seen, snapshot } = seeded();
    const before = snapshot();
    await runner.run(spec({ toolchain_env: {}, toolchain_seeds: [source] }));
    expect(seen[0]!.env.GRADLE_USER_HOME).toBe(join(base, "homes", "run_1", "tmp", "toolchain", "gradle"));
    expect(seen[0]).toMatchObject({ copied: true, writable: true });
    expect(snapshot()).toBe(before);
    expect(existsSync(join(source, "gradle-8.12.1-bin", "abc", "gradle-8.12.1.zip.lck"))).toBe(false);
    // A second step of the same run keeps the copy it has.
    await runner.run(spec({ toolchain_env: {}, toolchain_seeds: [source] }));
    expect(seen[1]).toMatchObject({ copied: true, writable: true });
  });

  it("a link in the seed to a file outside it or to a denied path is not copied; a link inside it is kept", async () => {
    const { base, source, runner, spec } = seeded();
    const dir = join(source, "gradle-8.12.1-bin");
    writeFileSync(join(base, "outside.txt"), "outside");
    mkdirSync(join(base, "secret"));
    writeFileSync(join(base, "secret", "id_rsa"), "key");
    symlinkSync(join(base, "outside.txt"), join(dir, "outside-link"));
    symlinkSync(join(base, "secret", "id_rsa"), join(dir, "denied-link"));
    symlinkSync(join(dir, "abc", "gradle-8.12.1", "bin", "gradle"), join(dir, "inside-link"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await runner.run(spec({ toolchain_env: {}, toolchain_seeds: [source], deny_paths: [join(base, "secret")] }));
    const copy = join(base, "homes", "run_1", "tmp", "toolchain", "gradle", "wrapper", "dists", "gradle-8.12.1-bin");
    expect(existsSync(join(copy, "abc", "gradle-8.12.1", "bin", "gradle"))).toBe(true);
    for (const link of ["outside-link", "denied-link"]) {
      expect(() => lstatSync(join(copy, link)), link).toThrow();
      expect(warn.mock.calls.flat().join("\n")).toContain(join(dir, link).replace(base, ""));
    }
    expect(readFileSync(join(copy, "inside-link"), "utf8")).toBe("#!/bin/sh\n");
    expect(realpathSync(join(copy, "inside-link"))).toBe(realpathSync(join(copy, "abc", "gradle-8.12.1", "bin", "gradle")));
    warn.mockRestore();
  });

  it("a missing seed or none makes no copy, and the run goes on", async () => {
    const { base, runner, spec, seen } = seeded();
    await runner.run(spec({ toolchain_env: {}, toolchain_seeds: [join(base, "nowhere")] }));
    await runner.run(spec({ run_id: "run_2" as AgentRunSpec["run_id"], toolchain_env: {}, toolchain_seeds: [] }));
    await runner.run(spec({ run_id: "run_3" as AgentRunSpec["run_id"] }));
    expect(seen.map((s) => s.copied)).toEqual([false, false, false]);
    for (const run of ["run_1", "run_2", "run_3"]) expect(existsSync(join(base, "homes", run, "tmp", "toolchain")), run).toBe(false);
  });
});

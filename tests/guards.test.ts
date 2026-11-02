import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import { Read } from "../src/core/tools/index.js";
import type { WorkerId } from "../src/core/types.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner, envExampleValueLines } from "../src/impl/egress/pattern-egress-scanner.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { buildAgentEnv, buildClaudeArgs, buildHarnessSettings } from "../src/impl/runner/claude-code-runner.js";
import { EnvFileSecretStore, parseEnvFile } from "../src/impl/secrets/env-file-secret-store.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { secretName } from "../src/interfaces/secret-store.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";
import {
  FakeAuth, FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, config, issueRef, prompts, silent, cleanScanner,
} from "./helpers/fakes.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";

const cred = { name: "CLAUDE_CODE_OAUTH_TOKEN" as const, value: "oauth-value-123456" };
const paths = { home: "/tmp/h", claudeConfigDir: "/tmp/c", path: "/usr/bin" };

describe("G1: agent environment is built from an allowlist", () => {
  it("never inherits the worker's env", () => {
    process.env.GITHUB_TOKEN_TEST_LEAK = "ghp_should_not_leak";
    const env = buildAgentEnv({ env_allowlist: { GIT_AUTHOR_NAME: "bot" } }, cred, paths);
    delete process.env.GITHUB_TOKEN_TEST_LEAK;
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN_TEST_LEAK");
    expect(Object.keys(env)).not.toContain("GITHUB_TOKEN");
    expect(env.GIT_AUTHOR_NAME).toBe("bot");
    expect(env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB).toBe("1");
    expect(env.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(env.HOME).toBe("/tmp/h");
  });

  it("refuses credential-looking names in env_allowlist", () => {
    for (const key of ["GITHUB_TOKEN", "GH_TOKEN", "ANTHROPIC_API_KEY", "DB_PASSWORD", "AWS_SECRET_ACCESS_KEY"]) {
      expect(() => buildAgentEnv({ env_allowlist: { [key]: "x" } }, cred, paths)).toThrow(/G1/);
    }
  });
});

describe("G3/G4: harness settings deny secret paths", () => {
  const settings = buildHarnessSettings({ deny_paths: ["/home/u/.config/software-factory"], writable_paths: ["/repo/.git"] }) as {
    permissions: { deny: string[] };
    sandbox: { enabled: boolean; allowUnsandboxedCommands: boolean; filesystem: { denyRead: string[]; allowWrite: string[] } };
  };

  it("denies the secret dir for file tools (absolute // form) and at OS level", () => {
    expect(settings.permissions.deny).toContain("Read(//home/u/.config/software-factory/**)");
    expect(settings.permissions.deny).toContain("Read(**/.env)");
    expect(settings.sandbox.filesystem.denyRead).toContain("/home/u/.config/software-factory");
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  });

  /**
   * Whether a `Tool(**\/<glob>)` rule matches a file name the way Claude Code's bundled `ignore` package does:
   * `?` is one character, `*` any run, matched case-insensitively against the basename. `[` has no negation
   * there (`^` is escaped, `!` is literal), so the rules may not use classes at all.
   */
  const ruleMatches = (rule: string, tool: string, name: string) => {
    const m = /^(\w+)\(\*\*\/([^/()]+)\)$/.exec(rule);
    if (!m || m[1] !== tool) return false;
    const re = m[2]!.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\?/g, "[^/]").replace(/\*/g, "[^/]*");
    return new RegExp(`^${re}$`, "i").test(name);
  };
  const deniedFor = (tool: string, name: string) => settings.permissions.deny.some((r) => ruleMatches(r, tool, name));

  it("does not deny reading or editing .env.example", () => {
    for (const tool of ["Read", "Edit"]) expect(deniedFor(tool, ".env.example"), tool).toBe(false);
    const envRules = settings.permissions.deny.filter((r) => r.includes(".env"));
    expect(envRules.length).toBeGreaterThan(0);
    for (const r of envRules) expect(r, "no character classes: Claude Code cannot negate them").not.toMatch(/\[/);
  });

  it("still denies reading and editing .env, .env.local and the other .env.* names", () => {
    const names = [
      ".env", ".env.local", ".env.", ".env.e", ".env.prod", ".env.production", ".env.development.local", ".env.example.local",
      ".env.staging", ".env.testing", ".env.secrets", ".env.private", ".env.release", ".env.develop", ".env.preview",
    ];
    for (const tool of ["Read", "Edit"]) {
      for (const name of names) expect(deniedFor(tool, name), `${tool} ${name}`).toBe(true);
    }
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(**/.env)", "Edit(**/.env)"]));
    expect(settings.permissions.deny).not.toContain("Read(**/.env.*)");
  });

  it("blocks credentialed shell paths around the broker (G2)", () => {
    for (const rule of ["Bash(gh:*)", "Bash(git push:*)", "Bash(git credential:*)", "Bash(security:*)", "Bash(mysql:*)"]) {
      expect(settings.permissions.deny).toContain(rule);
    }
  });

  it("passes settings inline and isolates user settings and MCP", () => {
    const args = buildClaudeArgs(
      { deny_paths: [], writable_paths: [], tools: [Read], system_prompt: "s" } as unknown as AgentRunSpec,
      "haiku",
    );
    expect(args).toEqual(expect.arrayContaining(["--setting-sources", "project", "--strict-mcp-config", "--allowedTools", "Read"]));
    expect(args.join(" ")).not.toContain("oauth-value");
  });
});

describe("Secret store", () => {
  /** What the default plugin selection declares (src/plugins.ts); the store loads only declared names. */
  const DECLARED = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "MYSQL_PASSWORD"].map(secretName);

  it("parses only known names and keeps values opaque", async () => {
    const m = parseEnvFile("# c\nGITHUB_TOKEN=ghp_x\nexport CLAUDE_CODE_OAUTH_TOKEN='tok'\nOTHER=1\n", DECLARED);
    expect([...m.keys()].sort()).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"]);
  });

  it("scans the MySQL password but not connection settings like the host (they would block normal output)", () => {
    const m = parseEnvFile("MYSQL_HOST=localhost\nMYSQL_USER=factory\nMYSQL_PASSWORD=pw-value\n", DECLARED);
    expect([...m.keys()]).toEqual(["MYSQL_PASSWORD"]);
  });

  it("a Secret never stringifies to its value", async () => {
    const store = new EnvFileSecretStore("/nonexistent");
    (store as unknown as { loaded: Promise<Map<string, string>> }).loaded = Promise.resolve(new Map([["GITHUB_TOKEN", "ghp_value"]]));
    const s = (await store.get(secretName("GITHUB_TOKEN")))!;
    expect(String(s)).not.toContain("ghp_value");
    expect(JSON.stringify({ s })).not.toContain("ghp_value");
    expect(inspect(s)).not.toContain("ghp_value");
    expect(s.reveal()).toBe("ghp_value");
  });
});

describe("G5: egress scan", () => {
  const scanner = new PatternEgressScanner(async () => ["my-known-secret-value"]);

  it("catches known values and patterns, without echoing them", async () => {
    const r = await scanner.scan("comment", "here: my-known-secret-value and ghp_" + "a".repeat(36));
    expect(r.clean).toBe(false);
    expect(JSON.stringify(r)).not.toContain("my-known-secret-value");
    if (!r.clean) expect(r.findings.map((f) => f.rule).sort()).toEqual(["github_token", "known_secret"]);
  });

  it("passes ordinary text", async () => {
    expect(await scanner.scan("pr", "Fix the lease reaper")).toEqual({ clean: true });
  });
  it("passes every tracked file of this repository, so an agent that reads or edits one is not blocked", async () => {
    // A fixture that looks like a secret (a canary, a key header) fails every run that touches its file.
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const patternsOnly = new PatternEgressScanner(async () => []);
    const flagged: string[] = [];
    for (const f of files) {
      let text: string;
      try {
        text = readFileSync(f, "utf8");
      } catch {
        continue; // a tracked file deleted in the working tree
      }
      if (!(await patternsOnly.scan("pr", text)).clean) flagged.push(f);
    }
    expect(flagged).toEqual([]);
  });
});

describe(".env.example value check", () => {
  it("passes blank values and comment lines", () => {
    const text = [
      "# Secret names only.", "", "   ", "GITHUB_TOKEN=", "export MYSQL_PASSWORD=", 'CLAUDE_CODE_OAUTH_TOKEN=""', "ANTHROPIC_API_KEY=''",
      "SLACK_BOT_TOKEN= # xoxb-, from the Slack app", "  # indented comment", "SLACK_APP_TOKEN =  ", "WINDOWS_LINE=\r", "",
    ].join("\n");
    expect(envExampleValueLines(text)).toEqual([]);
  });

  it("rejects every line that assigns a non-empty value, plain, exported or quoted, and reports line numbers only", () => {
    const text = [
      "# ok", "A_TOKEN=value", "export B_TOKEN=value", 'C_TOKEN="value"', "D_TOKEN='value'", "E_TOKEN = value",
      "F_TOKEN=#value", "G_TOKEN=\"\"value", "not an assignment", "H_TOKEN: value", "OK_TOKEN=",
    ].join("\n");
    const bad = envExampleValueLines(text);
    expect(bad).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(JSON.stringify(bad)).not.toContain("value");
  });
});

describe("G6 (unit): an agent that leaks a canary is stopped before anything leaves", () => {
  it("fails the run, stores no transcript, posts nothing", async () => {
    // Built at runtime: the literal would match the scanner's own canary rule, so any agent run that reads
    // this file would be blocked as a leak.
    const canary = ["sf", "canary", "abcdef123456"].join("-");
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const source = new FakeSource();
    const storage = new MemoryStorage();
    const broker = new FakeBroker();
    const runner = new FakeRunner({ triage: () => ({ output: { problem: canary }, transcript: `found ${canary}` }) });
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
    const worker = new Worker({
      id: "w" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage, clock, config, prompts, log: silent,
      scanner: new PatternEgressScanner(async () => [canary]), toolEnv: {}, awake: new NoKeepAwake(),
    });
    source.queue.push({ kind: "item_requested", source: issueRef(9), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    await worker.tick();
    await controller.tickRuns();

    const item = (await store.getWorkItemBySource("github_issue", "o/r#9"))!;
    const [failed] = await store.listRuns(item.id);
    expect(failed!.outcome).toMatchObject({ status: "failed", error_code: "egress_blocked" });
    expect(storage.data.size).toBe(0);
    expect(broker.calls).toHaveLength(0);
    const runs = await store.listRuns(item.id);
    expect(JSON.stringify(runs)).not.toContain(canary);
    expect(JSON.stringify(source.comments)).not.toContain(canary);
  });
});

describe("Tool broker", () => {
  async function setup() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    const posted: string[] = [];
    const client = {
      commentOnce: async (_r: unknown, _n: number, body: string) => {
        posted.push(body);
        return { created: true };
      },
    } as unknown as GitHubClient;
    const broker = new GitHubToolBroker({
      client, store, clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/",
      credentials: { token: async () => null },
      scanner: new PatternEgressScanner(async () => ["leaky-secret-value"]),
    });
    const ctx = { run_id: run.id, work_item_id: item.id, lease_token: run.lease!.token };
    return { clock, store, broker, ctx, posted };
  }
  const comment = { number: 1, body: "x", marker: "m" };

  it("rejects calls from a run that lost its lease (fencing)", async () => {
    const { broker, ctx } = await setup();
    const r = await broker.call({ ...ctx, lease_token: ctx.lease_token + 1 }, "github.comment", comment);
    expect(r).toMatchObject({ ok: false, error_code: "lease_lost" });
  });

  it("host sleep: accepts the current token after lease expiry while the run is still running", async () => {
    const { broker, ctx, clock, posted } = await setup();
    clock.advance(60_001 * 5);
    expect(await broker.call(ctx, "github.comment", comment)).toEqual({ ok: true, content: { created: true } });
    expect(posted).toEqual(["x"]);
  });

  it("rejects the old token after the reaper requeued the run, and after a reclaim", async () => {
    const { broker, ctx, clock, store } = await setup();
    clock.advance(60_001);
    expect(await store.expireLeases(3)).toEqual([ctx.run_id]);
    expect(await broker.call(ctx, "github.comment", comment)).toMatchObject({ ok: false, error_code: "lease_lost" });

    const again = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    expect(again.lease!.token).toBe(ctx.lease_token + 1);
    expect(await broker.call(ctx, "github.comment", comment)).toMatchObject({ ok: false, error_code: "lease_lost" });
    expect(await broker.call({ ...ctx, lease_token: again.lease!.token }, "github.comment", comment)).toMatchObject({ ok: true });
  });

  it("pushes only factory branches", async () => {
    const { broker, ctx } = await setup();
    const r = await broker.call(ctx, "github.push_branch", { workdir: "/x", branch: "main", base_ref: "main" });
    expect(r).toMatchObject({ ok: false, error_code: "branch_not_allowed" });
  });

  it("egress-scans comments before posting", async () => {
    const { broker, ctx, posted } = await setup();
    const r = await broker.call(ctx, "github.comment", { number: 1, body: "leaky-secret-value", marker: "m" });
    expect(r).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(posted).toHaveLength(0);
  });
});

describe("Tool broker push: .env.example at HEAD must hold no values", () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
  const commit = (dir: string, files: Record<string, string>, msg: string) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, "add", "-A");
    git(dir, "-c", "user.name=bot", "-c", "user.email=bot@example.com", "commit", "--quiet", "-m", msg);
  };
  // Built at runtime: no scanner pattern or known value matches it, so only the value check can stop it.
  const VALUE = ["plain", "looking", "value", "42"].join("-");

  async function setup() {
    const root = mkdtempSync(join(tmpdir(), "sf-env-example-push-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    const workdir = join(root, "run");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, repo);
    commit(repo, { "README.md": "hi\n", ".env.example": "# names only\nGITHUB_TOKEN=\n" }, "init");
    git(repo, "push", "--quiet", "origin", "main");
    git(repo, "fetch", "--quiet", "origin");
    git(root, "clone", "--quiet", origin, workdir);
    git(workdir, "checkout", "--quiet", "-b", "factory/wi_env");

    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
    const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
    const ctx = { run_id: run.id, work_item_id: item.id, lease_token: run.lease!.token };
    const broker = new GitHubToolBroker({
      client: {} as GitHubClient, store, clock, repo: { owner: "o", name: "r" }, branchPrefix: "factory/", repoPath: repo,
      credentials: { token: async () => ({ reveal: () => "not-a-real-token" }) } as unknown as GitHubCredentials,
      scanner: new PatternEgressScanner(async () => ["leaky-secret-value"]),
    });
    const push = () => broker.call(ctx, "github.push_branch", { workdir, branch: "factory/wi_env", base_ref: "main" });
    const pushed = () => git(origin, "for-each-ref", "refs/heads/factory/wi_env") !== "";
    return { workdir, push, pushed };
  }

  it("pushes when .env.example has names and blank values only", async () => {
    const { workdir, push, pushed } = await setup();
    commit(workdir, { ".env.example": "# names only\nGITHUB_TOKEN=\nexport MYSQL_PASSWORD=\nSLACK_BOT_TOKEN=\"\"\n" }, "add a name");
    expect(await push()).toMatchObject({ ok: true });
    expect(pushed()).toBe(true);
  });

  it("refuses with egress_blocked, and runs no git push, when .env.example assigns a value", async () => {
    for (const line of [`GITHUB_TOKEN=${VALUE}`, `export GITHUB_TOKEN=${VALUE}`, `GITHUB_TOKEN="${VALUE}"`]) {
      const { workdir, push, pushed } = await setup();
      commit(workdir, { ".env.example": `# names only\n${line}\n` }, "leak");
      const r = await push();
      expect(r).toMatchObject({ ok: false, error_code: "egress_blocked" });
      expect(JSON.stringify(r)).not.toContain(VALUE);
      expect(pushed()).toBe(false);
    }
  });

  it("checks HEAD, not only the diff: a value fixed in a later commit passes, one added in an earlier commit does not", async () => {
    const a = await setup();
    commit(a.workdir, { ".env.example": `GITHUB_TOKEN=${VALUE}\n` }, "leak");
    commit(a.workdir, { "src/x.txt": "x\n" }, "unrelated");
    expect(await a.push()).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(a.pushed()).toBe(false);

    const b = await setup();
    commit(b.workdir, { ".env.example": `GITHUB_TOKEN=${VALUE}\n` }, "leak");
    commit(b.workdir, { ".env.example": "GITHUB_TOKEN=\n" }, "fix");
    expect(await b.push()).toMatchObject({ ok: true });
  });

  it("refuses a value in a .env.example in a subfolder, and a committed .env.example symlink", async () => {
    const a = await setup();
    commit(a.workdir, { "pkg/.env.example": `A_TOKEN=${VALUE}\n` }, "leak");
    expect(await a.push()).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(a.pushed()).toBe(false);

    const b = await setup();
    rmSync(join(b.workdir, ".env.example"));
    symlinkSync("README.md", join(b.workdir, ".env.example"));
    commit(b.workdir, {}, "link");
    expect(await b.push()).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(b.pushed()).toBe(false);
  });
});

describe("G3/G4: deny paths from the real config", () => {
  it("cover the secret dir, the store, and admin credential files", async () => {
    const { loadConfig } = await import("../src/compose.js");
    const loaded = await loadConfig(new URL("..", import.meta.url).pathname);
    const home = process.env.HOME ?? "";
    for (const p of [loaded.secretsFile.replace(/\/[^/]+$/, ""), `${loaded.stateDir}/db`, `${home}/.my.cnf`, `${home}/.mylogin.cnf`]) {
      expect(loaded.config.deny_paths).toContain(p);
    }
  });
});

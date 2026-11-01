import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { Worker } from "../src/core/worker.js";
import type { WorkerId } from "../src/core/types.js";
import { GitHubToolBroker } from "../src/impl/broker/github-tool-broker.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
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

  it("blocks credentialed shell paths around the broker (G2)", () => {
    for (const rule of ["Bash(gh:*)", "Bash(git push:*)", "Bash(git credential:*)", "Bash(security:*)", "Bash(mysql:*)"]) {
      expect(settings.permissions.deny).toContain(rule);
    }
  });

  it("passes settings inline and isolates user settings and MCP", () => {
    const args = buildClaudeArgs(
      { deny_paths: [], writable_paths: [], harness_tools: ["Read"], system_prompt: "s" } as unknown as AgentRunSpec,
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
});

describe("G6 (unit): an agent that leaks a canary is stopped before anything leaves", () => {
  it("fails the run, stores no transcript, posts nothing", async () => {
    const canary = "sf-canary-abcdef123456";
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

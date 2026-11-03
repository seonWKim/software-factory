import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunKind } from "../src/core/types.js";
import type { AgentRunSpec } from "../src/interfaces/agent-runner.js";
import { ClaudeCodeRunner, buildClaudeArgs } from "../src/impl/runner/claude-code-runner.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { FakeSandbox } from "./helpers/fakes.js";

// Design §5 Pause: session persistence for implement, review and resolve runs, off for triage and update;
// `--resume <id>` continues a stored session on the same host. Sessions and run folders go when the run ends.

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

function spec(role: RunKind, session?: AgentRunSpec["session"]): AgentRunSpec {
  return {
    role,
    tools: [],
    deny_paths: [],
    writable_paths: [],
    system_prompt: "s",
    sandbox: { id: "sbx", workdir: "/runs/r1" },
    ...(session ? { session } : {}),
  } as unknown as AgentRunSpec;
}

const sessionFlags = (args: string[]) => args.filter((a) => a === "--no-session-persistence" || a === "--session-id" || a === "--resume");
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("claude-code runner: session arguments", () => {
  for (const role of ["implement", "review", "resolve"] as const) {
    it(`${role}: persistence on, under the given session id; --resume on a resume`, () => {
      const fresh = buildClaudeArgs(spec(role, { id: ID, resume: false }), "m");
      expect(sessionFlags(fresh)).toEqual(["--session-id"]);
      expect(after(fresh, "--session-id")).toBe(ID);
      const resumed = buildClaudeArgs(spec(role, { id: ID, resume: true }), "m");
      expect(sessionFlags(resumed)).toEqual(["--resume"]);
      expect(after(resumed, "--resume")).toBe(ID);
    });
  }

  for (const role of ["triage", "update"] as const) {
    it(`${role}: persistence off, even when a session is named`, () => {
      expect(sessionFlags(buildClaudeArgs(spec(role, { id: ID, resume: true }), "m"))).toEqual(["--no-session-persistence"]);
      expect(sessionFlags(buildClaudeArgs(spec(role), "m"))).toEqual(["--no-session-persistence"]);
    });
  }

  it("no session named, or an id that is not a UUID: persistence off, and the id never reaches an argument", () => {
    expect(sessionFlags(buildClaudeArgs(spec("implement"), "m"))).toEqual(["--no-session-persistence"]);
    const bad = buildClaudeArgs(spec("implement", { id: "../../etc", resume: true }), "m");
    expect(sessionFlags(bad)).toEqual(["--no-session-persistence"]);
    expect(bad).not.toContain("../../etc");
  });
});

describe("claude-code runner: stored sessions", () => {
  function runner() {
    const config = mkdtempSync(join(tmpdir(), "sf-cc-"));
    const r = new ClaudeCodeRunner({
      sandbox: new FakeSandbox(), secrets: { get: async () => null } as never, claudeConfigDir: config,
      homesDir: join(config, "homes"), models: { cheap: "c", standard: "s", strong: "x" },
    });
    return { r, config };
  }

  it("finds a readable session in any project folder, and removes it with its side folder", async () => {
    const { r, config } = runner();
    expect(await r.hasSession(ID)).toBe(false);
    const dir = join(config, "projects", "-runs-sbx-1");
    mkdirSync(join(dir, ID), { recursive: true });
    writeFileSync(join(dir, `${ID}.jsonl`), "{}\n");
    expect(await r.hasSession(ID)).toBe(true);
    await r.removeSession(ID);
    expect(existsSync(join(dir, `${ID}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, ID))).toBe(false);
    expect(await r.hasSession(ID)).toBe(false);
    await r.removeSession(ID); // idempotent
  });

  it("an unreadable session file is not resumable", async () => {
    if (process.getuid?.() === 0) return; // root reads anything
    const { r, config } = runner();
    const dir = join(config, "projects", "p");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${ID}.jsonl`), "{}\n");
    chmodSync(join(dir, `${ID}.jsonl`), 0o000);
    expect(await r.hasSession(ID)).toBe(false);
  });

  it("an id that is not a UUID names no file", async () => {
    const { r } = runner();
    expect(await r.hasSession("../x")).toBe(false);
    await r.removeSession("../x");
  });
});

describe("NoOpSandbox.reattach", () => {
  function git(cwd: string, ...args: string[]) {
    return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  }

  it("returns the same folder while it exists, with the work in it; null once destroyed, or for any other id", async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-reattach-"));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, repo);
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", ".");
    git(repo, "-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "init");
    git(repo, "push", "--quiet", "origin", "main");

    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_1", base_ref: "main" });
    writeFileSync(join(h.workdir, "work.txt"), "half done\n");

    const again = await sbx.reattach(h.id);
    expect(again).toEqual({ id: h.id, workdir: h.workdir });
    expect(existsSync(join(again!.workdir, "work.txt"))).toBe(true);
    expect(await sbx.reattach("sbx_00000000")).toBeNull();
    expect(await sbx.reattach("../repo")).toBeNull();

    await sbx.destroy(h);
    expect(await sbx.reattach(h.id)).toBeNull();
  });
});

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STORE_BRANCH } from "../src/interfaces/tool-broker.js";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalToolBroker } from "../src/impl/broker/local-tool-broker.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { issue, newStore, system, w1 } from "./helpers/store.js";

// The local broker (design 05-sources, local startup): a run's branch becomes a local branch of the factory repo.
// It pushes to no remote and calls no forge, and it is a full guard: lease, branch prefix, trusted git, egress scan.

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
const SECRET = "leaky-secret-value";
const BRANCH = "factory/wi_local";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "sf-local-broker-"));
  // The factory repo has a remote, so the test can see that nothing reaches it.
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  const workdir = join(root, "run");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, repo);
  commit(repo, { "README.md": "hi\n" }, "init");
  git(repo, "push", "--quiet", "origin", "main");
  git(root, "clone", "--quiet", repo, workdir);
  git(workdir, "checkout", "--quiet", "-b", BRANCH);

  const { store } = await newStore(new FakeClock());
  const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "implement", idempotency_key: "k" } });
  const run = (await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 }))!;
  const ctx = { run_id: run.id, work_item_id: item.id, lease_token: run.lease!.token };
  const broker = new LocalToolBroker({ store, scanner: new PatternEgressScanner(async () => [SECRET]), branchPrefix: "factory/", repoPath: repo });
  const remoteRefs = () => git(origin, "for-each-ref");
  const localRef = (branch: string) => git(repo, "for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`);
  return { repo, workdir, broker, ctx, remoteRefs, localRef, push: (branch = BRANCH) => broker.call(ctx, STORE_BRANCH, { workdir, branch, base_ref: "main" }) };
}

describe("local broker", { timeout: 30_000 }, () => {
  it("commits the run's branch to a local branch of the factory repo; the remote is untouched", async () => {
    const f = await setup();
    commit(f.workdir, { "src/gate.ts": "export const gate = 1;\n" }, "add the gate");
    const before = f.remoteRefs();
    const r = await f.push();
    const head = git(f.workdir, "rev-parse", "HEAD");
    // `forge: false`: the factory repo's branch is the change; the worker records no push for outbound.
    expect(r).toEqual({ ok: true, content: { sha: head, forge: false } });
    expect(f.localRef(BRANCH)).toBe(head);
    expect(f.remoteRefs()).toBe(before);
    expect(git(f.repo, "rev-parse", "refs/remotes/origin/main")).toBe(git(f.repo, "rev-parse", "main"));
  });

  it("serves the branch store only: no PR, preflight or comment tool, so nothing can reach a forge", async () => {
    const f = await setup();
    expect(f.broker.allTools().map((t) => t.name)).toEqual([STORE_BRANCH]);
    for (const name of ["github.push_branch", "github.open_pr", "forge.preflight"]) {
      expect(await f.broker.call(f.ctx, name, {})).toMatchObject({ ok: false, error_code: "unknown_tool" });
    }
  });

  it("refuses a branch without the branch prefix and writes no branch", async () => {
    const f = await setup();
    commit(f.workdir, { "src/gate.ts": "x\n" }, "x");
    expect(await f.push("main")).toMatchObject({ ok: false, error_code: "branch_not_allowed" });
    expect(await f.push("feature/x")).toMatchObject({ ok: false, error_code: "branch_not_allowed" });
    expect(f.localRef("feature/x")).toBe("");
    expect(git(f.repo, "rev-parse", "main")).not.toBe(git(f.workdir, "rev-parse", "HEAD"));
  });

  it("refuses a planted secret in the diff or in a commit message with egress_blocked, and writes no branch", async () => {
    const inDiff = await setup();
    commit(inDiff.workdir, { "src/config.ts": `export const token = "${SECRET}";\n` }, "config");
    const r = await inDiff.push();
    expect(r).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
    expect(inDiff.localRef(BRANCH)).toBe("");

    const inMessage = await setup();
    commit(inMessage.workdir, { "src/x.ts": "x\n" }, `uses ${SECRET}`);
    expect(await inMessage.push()).toMatchObject({ ok: false, error_code: "egress_blocked" });
    expect(inMessage.localRef(BRANCH)).toBe("");
  });

  it("refuses a run folder whose git config could run a program, and a lost lease", async () => {
    const f = await setup();
    commit(f.workdir, { "src/x.ts": "x\n" }, "x");
    git(f.workdir, "config", "core.fsmonitor", "touch /tmp/pwned");
    expect(await f.push()).toMatchObject({ ok: false, error_code: "untrusted_git_config" });
    expect(f.localRef(BRANCH)).toBe("");
    const stale = await f.broker.call({ ...f.ctx, lease_token: f.ctx.lease_token + 1 }, "github.push_branch", { workdir: f.workdir, branch: BRANCH, base_ref: "main" });
    expect(stale).toMatchObject({ ok: false, error_code: "lease_lost" });
  });
});

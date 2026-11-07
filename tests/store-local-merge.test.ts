import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/compose.js";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { BACKENDS, system } from "./helpers/store.js";

// The local merge on a shared store (design 05-sources, Local items; enterprise): two controllers, standing in for
// two replicas, apply `factory merge` to the same local change at once. The base branch moves by one conditional
// ref update and the item closes by one conditional store transition, so there is one merge and one closed row.

const ME = "local:me@example.com" as UserId;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const commit = (dir: string, file: string, msg: string) => {
  writeFileSync(join(dir, file), `${msg}\n`);
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", msg);
};

describe.each(BACKENDS)("local merge on a shared store: $name", ({ make }) => {
  it("two controllers merging the same local change at once give one merge into main and one merged item", { timeout: 60_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "sf-store-local-merge-"));
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "-b", "main", repo);
    commit(repo, "README.md", "init");
    git(repo, "checkout", "--quiet", "--detach");
    const { store, clock } = await make();
    const project = localProject({ owner: "o", name: "r" });
    const cfg: FactoryConfig = {
      ...config, project, local_only: true,
      repo: { ...config.repo, path: repo, install_command: ["sh", "-c", "exit 0"], test_command: ["sh", "-c", "exit 0"] },
    };
    const created = await runLocalCli(
      { store, identity: { user: ME, from: "git user.email" }, project: async () => project.key, read: async () => "b", newId: () => "id1" },
      { action: "create", title: "t", bodyFile: "b" },
    );
    const id = created.lines[0] as WorkItemId;
    // The item's local branch, reviewed and waiting for its merge.
    git(repo, "checkout", "--quiet", "-b", `factory/${id}`, "main");
    commit(repo, "change.txt", "the change");
    git(repo, "checkout", "--quiet", "--detach");
    const item = (await store.getWorkItem(id))!;
    const moved = await store.transition({
      id, expected_version: item.version, actor: system, reason: "review_passed",
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" },
    });
    expect(moved.ok).toBe(true);
    const mainBefore = git(repo, "rev-parse", "main");

    const auth = new LocalAuthProvider(store, [new StaticGrant({ roles: {}, deny: {} })]);
    const replica = (n: number) => new Controller({
      store, sources: [new LocalSource(store)], auth, local_auth: auth, clock, config: cfg, log: silent, scanner: cleanScanner,
      sandbox: new NoOpSandbox(join(root, `wt${n}`), undefined, undefined, { local: true }), repeated_failure_rule: false,
    });
    const who = { provider: "local" as const, subject: "me@example.com" };
    await Promise.all([replica(1).mergeLocal(id, who, "k1"), replica(2).mergeLocal(id, who, "k2")]);

    const main = git(repo, "rev-parse", "main");
    // One merge commit on main, of the base before and the branch.
    expect(git(repo, "rev-list", "--count", "--merges", `${mainBefore}..main`)).toBe("1");
    expect(git(repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, git(repo, "rev-parse", `factory/${id}`)]);
    // One closed item at that merge, by one transition.
    expect(await store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect((await store.listStateChanges(id)).filter((c) => c.reason === "local_merged")).toHaveLength(1);
  });
});

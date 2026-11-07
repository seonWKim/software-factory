import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId } from "../src/core/types.js";
import type { GitHubClient } from "../src/impl/github/github-client.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
import { REGISTRY, createPlugin } from "../src/plugins.js";
import type { Forge } from "../src/interfaces/forge.js";
import { FakeAuth, cleanScanner, config, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The local forge (design §4, merge command; issue #246): a merge puts the item's branch on the base branch of the
// factory repo, in git's object store only, with no GitHub call, and never touches the person's own checkout.

const WRITER = "github:1" as UserId;
const IDENTITY = { name: "bot", email: "bot@example.com" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "p", GIT_AUTHOR_EMAIL: "p@x", GIT_COMMITTER_NAME: "p", GIT_COMMITTER_EMAIL: "p@x" } }).trim();
}

/** A repo with `main`, the person's own branch `mine` checked out with uncommitted edits, and one factory branch. */
function repoWithBranch(branch: string, file = "feature.txt", content = "feature\n") {
  const repo = mkdtempSync(join(tmpdir(), "sf-local-forge-"));
  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "base");
  git(repo, "checkout", "--quiet", "-b", branch);
  writeFileSync(join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "--quiet", "-m", "factory change");
  const head = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "-b", "mine", "main");
  writeFileSync(join(repo, "README.md"), "base\nmy edit\n");
  writeFileSync(join(repo, "notes.txt"), "untracked\n");
  return { repo, head };
}

/** The person's checkout as they see it: branch, HEAD and status. */
const checkout = (repo: string) => ({
  branch: git(repo, "symbolic-ref", "HEAD"),
  head: git(repo, "rev-parse", "HEAD"),
  status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
});

/** A GitHub client that fails on any use: the local forge must make no GitHub call. */
const NO_GITHUB = new Proxy({}, {
  get: (_t, key) => (key === "then" ? undefined : () => {
    throw new Error("GitHub call");
  }),
}) as unknown as GitHubClient;

/** The local forge as startup builds it, from `plugins.forge: "local"`, over `repo`. */
async function localForge(repo: string): Promise<Forge> {
  const loaded = { config: { ...config, repo: { ...config.repo, path: repo }, agent_git_identity: IDENTITY } };
  return createPlugin(REGISTRY, "forge", "local", { loaded, repo: { owner: "o", name: "r" }, extraScanValues: [], github: NO_GITHUB } as never);
}

/**
 * A local item waiting for a human merge, then its repo (`make`, given the item's branch `factory/<id>`) with the
 * branch's head recorded as the reviewed head, then the controller over the local forge of that repo.
 */
async function harness(make: (branch: string) => { repo: string; head: string } = (b) => repoWithBranch(b)) {
  const { store, clock } = await newStore();
  const actor = { kind: "system" as const, id: "system:test" };
  const { item } = await store.createWorkItem(
    { source: { type: "local", id: "local:1", link: "" }, requester_id: WRITER, project: PROJECT_KEY, problem: "p", resources: [] },
    actor,
  );
  const branch = `factory/${item.id}`;
  const { repo, head } = make(branch);
  const r = await store.transition({
    id: item.id, expected_version: item.version, actor, reason: "setup",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", pr_number: 7, tier: 2 },
  });
  if (!r.ok) throw new Error("setup failed");
  await store.recordPrHead({ id: item.id, expected_head: null, head_sha: head, manual: null });
  const it = (await store.getWorkItem(item.id))!;
  const forge = await localForge(repo);
  const controller = new Controller({ store, sources: [], forge, auth: new FakeAuth(), clock, config: { ...config, forge_merge: true }, log: silent, scanner: cleanScanner });
  const merge = async (key = "m1") => {
    const { request } = await store.recordAppCommandRequest({ key, actor: WRITER, command: "merge", args: { work_item_id: it.id } });
    await controller.tickCommands();
    return (await store.getAppCommandRequest(request.seq))!;
  };
  return { store, controller, forge, it, merge, repo, head, branch };
}

describe("local forge: merge", () => {
  it("puts the branch's commits on the base branch and closes the item, with no GitHub call", async () => {
    const h = await harness();
    const { repo, head } = h;
    const mainBefore = git(repo, "rev-parse", "refs/heads/main");
    const r = await h.merge();

    expect(r.refusal).toBeNull();
    const main = git(repo, "rev-parse", "refs/heads/main");
    expect(main).not.toBe(mainBefore);
    expect(git(repo, "rev-list", "--parents", "-n", "1", main).split(" ").slice(1)).toEqual([mainBefore, head]);
    expect(git(repo, "show", "refs/heads/main:feature.txt")).toBe("feature");
    const item = (await h.store.getWorkItem(h.it.id))!;
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: main });
    expect((await h.store.listStateChanges(h.it.id)).at(-1)).toMatchObject({ reason: "merged_by_command", actor: { kind: "user", id: WRITER } });
  });

  it("never touches the person's own checkout: its branch, HEAD and status are the same before and after", async () => {
    const h = await harness();
    const before = checkout(h.repo);
    expect(before.status).not.toBe("");
    await h.merge();
    expect((await h.store.getWorkItem(h.it.id))!.stage).toBe("CLOSED");
    expect(checkout(h.repo)).toEqual(before);
  });

  it("a second merge makes no second merge commit", async () => {
    const h = await harness();
    const { repo } = h;
    await h.merge();
    const main = git(repo, "rev-parse", "refs/heads/main");
    const again = await h.merge("m2");
    expect(again.refusal).toBeNull();
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(main);
  });

  it("refuses, writing no ref, while the base branch is checked out", async () => {
    const h = await harness((b) => {
      const made = repoWithBranch(b);
      git(made.repo, "stash", "--include-untracked", "--quiet");
      git(made.repo, "checkout", "--quiet", "main");
      return made;
    });
    const { repo } = h;
    const before = checkout(repo);
    const r = await h.merge();
    expect(r.refusal).toMatch(/`main` is checked out in a working tree of this repository/);
    expect(checkout(repo)).toEqual(before);
    expect(await h.store.getWorkItem(h.it.id)).toEqual(h.it);
  });

  it("refuses when the branch has commits after the reviewed head", async () => {
    const h = await harness();
    const { repo, head, branch } = h;
    git(repo, "branch", "--quiet", "-f", branch, git(repo, "commit-tree", `${head}^{tree}`, "-p", head, "-m", "later"));
    const mainBefore = git(repo, "rev-parse", "refs/heads/main");
    const r = await h.merge();
    expect(r.refusal).toMatch(/commits arrived after the reviewed head/);
    expect(git(repo, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(await h.store.getWorkItem(h.it.id)).toEqual(h.it);
  });
});

describe("local forge: what it reads", () => {
  it("reports a conflicting branch as not mergeable, and its size", async () => {
    const branch = "factory/wi_conflict";
    const { repo, head } = repoWithBranch(branch, "README.md", "theirs\n");
    git(repo, "stash", "--include-untracked", "--quiet");
    git(repo, "checkout", "--quiet", "main");
    writeFileSync(join(repo, "README.md"), "ours\n");
    git(repo, "commit", "--quiet", "-am", "ours");
    git(repo, "checkout", "--quiet", "mine");
    const forge = new LocalForge({ repo, base: "main", identity: IDENTITY });
    expect(await forge.prMergeState(7, branch)).toEqual({ state: "open", head_sha: head, mergeable: false, merge_sha: null, lines: 2, files: 1 });
    const r = await forge.mergePr({ pr_number: 7, branch, base_ref: "main", head_sha: head });
    expect(r).toEqual({ merged: false, reason: "the branch does not merge cleanly into `main`" });
  });

  it("has no PR events, passed checks, and refs of its own type", async () => {
    const forge = new LocalForge({ repo: "/nowhere", base: "main", identity: IDENTITY });
    expect(await forge.poll(null)).toEqual({ events: [], next_cursor: "" });
    expect(await forge.prChecks()).toEqual({ state: "passed" });
    expect(forge.prNumberOf(forge.prRef(7))).toBe(7);
    expect(forge.prNumberOf({ type: "local", id: "local:7", link: "" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { Sandbox } from "../../src/interfaces/sandbox.js";

// RFC 0023 R2: the Sandbox contract (src/interfaces/sandbox.ts), run over every implementation by
// sandbox.contract.test.ts. The worker creates a run folder per run, resolves its base, reattaches a paused run's
// folder and destroys it at every end; feature tests do all of that on FakeSandbox, so it must keep the same
// promises as NoOpSandbox. What a command prints is scripted in FakeSandbox, so command output is not part of the
// contract beyond the base ref every run reads.

/** One sandbox under test, over a factory repo whose base branch is `base_ref`. */
export interface SandboxUnderTest {
  sandbox: Sandbox;
  repo: string;
  base_ref: string;
  /** The environment for exec: nothing is inherited (G1), so a real git needs PATH. */
  env: Record<string, string>;
  /**
   * Puts a factory branch `name` on the factory repo's origin (local mode: a local branch) with one commit off the
   * base that writes `files`; returns its commit. Only for an implementation with fetchBranch or mergeCheck.
   */
  branch?(name: string, files: Record<string, string>): Promise<string>;
}

/** An id of the form NoOpSandbox makes, that no create here made. */
const NEVER_MADE = "sbx_00000000";

export function sandboxContract(
  make: () => Promise<SandboxUnderTest>,
  opts: { reattach: boolean; fetchBranch: boolean; mergeCheck: boolean },
): void {
  describe("create", () => {
    // Bug: two runs share one folder (or id), so one run's agent writes into the other's checkout.
    it("gives each run its own id and folder", async () => {
      const { sandbox, repo, base_ref } = await make();
      const a = await sandbox.create({ repo, branch: "factory/contract-a", base_ref });
      const b = await sandbox.create({ repo, branch: "factory/contract-b", base_ref });
      expect(a.id).not.toBe(b.id);
      expect(a.workdir).not.toBe(b.workdir);
    });

    // Bug: create resolves its base from another ref than updateBase, so the gates diff against one base and the
    // sync before a push merges another.
    it("reports the same base commit as updateBase", async () => {
      const { sandbox, repo, base_ref } = await make();
      const h = await sandbox.create({ repo, branch: null, base_ref });
      expect(h.base_sha).toBeTruthy();
      expect(h.base_sha).toBe(await sandbox.updateBase({ repo, base_ref }));
    });

    // Bug: the run folder's origin/<base> is not the factory repo's (a stale or agent-made ref), so a worker that
    // resolves the base in the folder (runner.ts, no base_sha) diffs against the wrong commit.
    it("gives a folder whose origin/<base> is the base commit", async () => {
      const { sandbox, repo, base_ref, env } = await make();
      const h = await sandbox.create({ repo, branch: "factory/contract", base_ref });
      const r = await sandbox.exec(h, ["git", "rev-parse", "--verify", "--end-of-options", `origin/${base_ref}^{commit}`], { env });
      expect(r.exit_code).toBe(0);
      expect(r.stdout.trim()).toBe(h.base_sha);
    });
  });

  describe("reattach and destroy", () => {
    // Bug: a paused run resumed on this host gets another folder, or a stale base_sha the caller did not keep.
    it.skipIf(!opts.reattach)("reattaches a live folder by its id, same folder, no base_sha", async () => {
      const { sandbox, repo, base_ref } = await make();
      const h = await sandbox.create({ repo, branch: "factory/contract", base_ref });
      const again = await sandbox.reattach!(h.id);
      expect(again).toEqual({ id: h.id, workdir: h.workdir });
    });

    // Bug: a resume reuses a folder that was destroyed, or one this host never made.
    it.skipIf(!opts.reattach)("is null for a destroyed folder and for an id never made here", async () => {
      const { sandbox, repo, base_ref } = await make();
      const h = await sandbox.create({ repo, branch: "factory/contract", base_ref });
      await sandbox.destroy(h);
      expect(await sandbox.reattach!(h.id)).toBeNull();
      expect(await sandbox.reattach!(NEVER_MADE)).toBeNull();
    });

    // Bug: a second destroy (the worker destroys at every end, a retry included) throws, or destroy removes
    // another run's folder.
    it.skipIf(!opts.reattach)("destroys idempotently, and only the given folder", async () => {
      const { sandbox, repo, base_ref } = await make();
      const a = await sandbox.create({ repo, branch: "factory/contract-a", base_ref });
      const b = await sandbox.create({ repo, branch: "factory/contract-b", base_ref });
      await sandbox.destroy(a);
      await sandbox.destroy(a);
      expect(await sandbox.reattach!(b.id)).toEqual({ id: b.id, workdir: b.workdir });
    });
  });

  describe("fetchBranch", () => {
    // Bug: a missing PR branch throws (the merge check stops for every item) or names some other commit.
    it.skipIf(!opts.fetchBranch)("is null when origin has no such branch, and the branch's commit when it has", async () => {
      const { sandbox, repo, branch } = await make();
      expect(await sandbox.fetchBranch!({ repo, branch: "factory/contract-missing" })).toBeNull();
      const sha = await branch!("factory/contract-one", { "one.txt": "one\n" });
      expect(await sandbox.fetchBranch!({ repo, branch: "factory/contract-one" })).toBe(sha);
    });
  });

  describe("mergeCheck", () => {
    // Bug: a clean merge reported as a conflict, a conflict missed, or paths repeated or unsorted (the controller
    // compares them between checks to tell a new conflict from a known one).
    it.skipIf(!opts.mergeCheck)("reports a clean merge as mergeable, and a conflict with each path once, sorted", async () => {
      const { sandbox, repo, base_ref, branch } = await make();
      const base = await sandbox.updateBase({ repo, base_ref });
      const one = await branch!("factory/contract-one", { "b.txt": "one\n", "a.txt": "one\n" });
      const two = await branch!("factory/contract-two", { "b.txt": "two\n", "a.txt": "two\n" });
      if (opts.fetchBranch) {
        await sandbox.fetchBranch!({ repo, branch: "factory/contract-one" });
        await sandbox.fetchBranch!({ repo, branch: "factory/contract-two" });
      }
      expect(await sandbox.mergeCheck!({ repo, head_sha: one, base_sha: base })).toEqual({ mergeable: true, conflicts: [] });
      expect(await sandbox.mergeCheck!({ repo, head_sha: two, base_sha: one })).toEqual({ mergeable: false, conflicts: ["a.txt", "b.txt"] });
    });
  });
}

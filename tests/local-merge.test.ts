import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// The local merge's reply says how to run the result (design 04-gate-commands, restart): with `repo.restart_command`
// set, the Restart app button and `factory restart`; without it, the repo's README.md and bin/ when they exist, else
// that no run command is set. Startup never fails for its absence.

const ME = "local:me@example.com" as UserId;

async function mergedReply(o: { restart_command?: string[]; entries?: string[] | null }) {
  const { store, clock } = await newStore();
  const cfg: FactoryConfig = { ...config, repo: { ...config.repo, ...(o.restart_command ? { restart_command: o.restart_command } : {}) } };
  const asked: (readonly string[])[] = [];
  const entries = o.entries === null ? {} : { repo_entries: async (names: readonly string[]) => (asked.push(names), names.filter((n) => (o.entries ?? []).includes(n))) };
  const controller = new ControllerRole({ store, sources: [new FakeSource()], auth: new FakeAuth(), clock, config: cfg, log: silent, scanner: cleanScanner, ...entries });
  const actor = { kind: "system" as const, id: "system:test" };
  const { item } = await store.createWorkItem({ source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: ME, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
  const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" } });
  if (!r.ok) throw new Error("setup failed");
  const it: WorkItem = r.item;
  expect(await (await controller.unit("local-merge")).merged(it.id, ME, "k1", { sha: "abcdef0123456789", already: false, not_updated: [] }, {})).toBe("landed");
  const bodies = (await store.listItemMessages(it.id)).filter((m) => m.marker === "<!-- factory:local-merged:k1 -->").map((m) => m.body);
  expect(bodies).toHaveLength(1);
  return { body: bodies[0]!, asked, item: (await store.getWorkItem(it.id))! };
}

describe("the local merge reply: how to run the result", () => {
  it("with repo.restart_command: points to Restart app and `factory restart <id>`, and reads nothing in the repo", async () => {
    const { body, asked, item } = await mergedReply({ restart_command: ["bin/restart"], entries: ["README.md", "bin"] });
    expect(item).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
    expect(body).toContain(`press Restart app on the item's page or run \`factory restart ${item.id}\``);
    expect(body).not.toContain("No run command is set");
    expect(asked).toEqual([]);
  });

  it("without it: names README.md and bin/ when the repo has them, after the merge line", async () => {
    const { body, asked } = await mergedReply({ entries: ["README.md", "bin"] });
    expect(body).toMatch(/^Merged `/);
    expect(body).toContain("To run the merged code, see `README.md` and the scripts in `bin/` in the repository.");
    expect(body).toContain("No run command is set");
    expect(asked).toEqual([["README.md", "bin"]]);
  });

  it("without it and with neither entry, or no way to look: says only that no run command is set", async () => {
    for (const entries of [[], null]) {
      const { body } = await mergedReply({ entries });
      expect(body).toContain("No run command is set");
      expect(body).not.toContain("README.md");
      expect(body).not.toContain("`bin/`");
    }
  });
});

// The red-main revert on the sandbox (design 03-risk): one automatic merge at the tip of the local base, reverted with
// git's own message, conditionally on the base at the merge and its first parent the green base; the item's branch
// gets the change back on top of the revert. A repeat finds it done.
describe("NoOpSandbox.revertLocal", () => {
  const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
  const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  const IDENTITY = { name: "factory", email: "factory@example.com" };

  /** A repo whose main is a merge of `factory/wi_1` (one file changed) onto `green`. */
  function merged() {
    const root = mkdtempSync(join(tmpdir(), "sf-revert-"));
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "-b", "main", repo);
    writeFileSync(join(repo, "a.txt"), "green\n");
    git(repo, "add", "-A");
    git(repo, ...ident, "commit", "--quiet", "-m", "init");
    const green = git(repo, "rev-parse", "main");
    git(repo, "checkout", "--quiet", "-b", "factory/wi_1");
    writeFileSync(join(repo, "a.txt"), "broken\n");
    git(repo, ...ident, "commit", "--quiet", "-am", "the change");
    const head = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "--quiet", "--detach");
    git(repo, "checkout", "--quiet", "main");
    git(repo, ...ident, "merge", "--quiet", "--no-ff", "-m", "Merge factory/wi_1 into main", "factory/wi_1");
    const merge = git(repo, "rev-parse", "main");
    const sandbox = new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true });
    const spec = { repo, base_ref: "main", merge_sha: merge, parent: green, branch: "factory/wi_1", identity: IDENTITY };
    return { repo, green, head, merge, sandbox, spec };
  }

  it("reverts the merge with git's message, moves the branch on top of it, and a repeat changes nothing", async () => {
    const { repo, green, merge, sandbox, spec } = merged();
    const r = await sandbox.revertLocal(spec);
    expect(r).toMatchObject({ reverted: true, already: false, branch_reapplied: true });
    const sha = git(repo, "rev-parse", "main");
    expect(r.reverted && r.sha).toBe(sha);
    expect(git(repo, "rev-parse", "main^1")).toBe(merge);
    expect(git(repo, "rev-parse", "main^{tree}")).toBe(git(repo, "rev-parse", `${green}^{tree}`));
    expect(git(repo, "show", "-s", "--format=%B", "main")).toBe(`Revert "Merge factory/wi_1 into main"\n\nThis reverts commit ${merge}, reversing\nchanges made to ${green}.`);
    expect(git(repo, "show", "-s", "--format=%an <%ae>", "main")).toBe("factory <factory@example.com>");
    // The owner's clean checkout of main follows the base.
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("green\n");
    expect(git(repo, "rev-parse", "factory/wi_1^1")).toBe(sha);
    expect(git(repo, "rev-parse", "factory/wi_1^{tree}")).toBe(git(repo, "rev-parse", `${merge}^{tree}`));
    const branch = git(repo, "rev-parse", "factory/wi_1");
    expect(await sandbox.revertLocal(spec)).toEqual({ reverted: true, sha, already: true, branch_reapplied: false });
    expect(git(repo, "rev-parse", "main")).toBe(sha);
    expect(git(repo, "rev-parse", "factory/wi_1")).toBe(branch);
  });

  it("refuses a merge whose first parent is not the green base, and a base not at the merge; nothing moves", async () => {
    const { repo, head, merge, sandbox, spec } = merged();
    expect(await sandbox.revertLocal({ ...spec, parent: head })).toMatchObject({ reverted: false, refused: expect.stringContaining("not the green base") });
    expect(git(repo, "rev-parse", "main")).toBe(merge);
    writeFileSync(join(repo, "b.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, ...ident, "commit", "--quiet", "-m", "later");
    const later = git(repo, "rev-parse", "main");
    expect(await sandbox.revertLocal(spec)).toMatchObject({ reverted: false, refused: expect.stringContaining("not at the merge") });
    expect(git(repo, "rev-parse", "main")).toBe(later);
    expect(git(repo, "rev-parse", "factory/wi_1")).toBe(head);
  });

  it("leaves a branch that moved on since the merge as it is", async () => {
    const { repo, sandbox, spec } = merged();
    git(repo, "branch", "-f", "factory/wi_1", "main");
    const moved = git(repo, "rev-parse", "factory/wi_1");
    expect(await sandbox.revertLocal(spec)).toMatchObject({ reverted: true, branch_reapplied: false });
    expect(git(repo, "rev-parse", "factory/wi_1")).toBe(moved);
  });
});

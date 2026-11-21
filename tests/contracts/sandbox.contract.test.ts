import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe } from "vitest";
import { NoOpSandbox } from "../../src/impl/sandbox/noop-sandbox.js";
import type { Sandbox } from "../../src/interfaces/sandbox.js";
import { FakeSandbox } from "../helpers/fakes/runner.js";
import { git, gitTemplate } from "../helpers/git-fixture.js";
import { type SandboxUnderTest, sandboxContract } from "./sandbox.contract.js";

// NoOpSandbox runs real git on temp repos: `remote` over a factory repo cloned from a bare origin, `local` (no forge
// plugin) over a factory repo with no remote. No other Sandbox implementation exists yet; a Docker or gVisor one that
// needs a tool missing on the host would be added here behind it.skipIf with the reason.

const ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null" };

/** One commit off main on a new branch `name` writing `files`; pushed to origin and dropped locally when `push`. */
function commitBranch(repo: string, name: string, files: Record<string, string>, push: boolean): string {
  git(repo, "checkout", "--quiet", "-b", name, "main");
  for (const [path, text] of Object.entries(files)) writeFileSync(join(repo, path), text);
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", name);
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "--quiet", "main");
  if (push) {
    git(repo, "push", "--quiet", "origin", name);
    git(repo, "branch", "--quiet", "-D", name);
  }
  return sha;
}

function noop(mode: "remote" | "local"): (copy: () => string) => () => Promise<SandboxUnderTest> {
  return (copy) => async () => {
    const root = copy();
    const repo = join(root, "repo");
    const sandbox: Sandbox = new NoOpSandbox(join(root, "worktrees"), undefined, undefined, { local: mode === "local" });
    return { sandbox, repo, base_ref: "main", env: ENV, branch: async (name, files) => commitBranch(repo, name, files, mode === "remote") };
  };
}

/** The factory repo: `repo` on main with one commit; for `remote`, cloned from the bare `origin.git`. */
function build(mode: "remote" | "local"): (root: string) => void {
  return (root) => {
    const repo = join(root, "repo");
    if (mode === "remote") {
      git(root, "init", "--quiet", "--bare", "-b", "main", "origin.git");
      git(root, "clone", "--quiet", join(root, "origin.git"), "repo");
    } else {
      git(root, "init", "--quiet", "-b", "main", "repo");
    }
    writeFileSync(join(repo, "README.md"), "contract\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "init");
    if (mode === "remote") git(repo, "push", "--quiet", "origin", "main");
  };
}

const IMPLEMENTATIONS = [
  { name: "NoOpSandbox (remote)", build: build("remote"), make: noop("remote"), reattach: true, fetchBranch: true, mergeCheck: true },
  { name: "NoOpSandbox (local)", build: build("local"), make: noop("local"), reattach: true, fetchBranch: true, mergeCheck: true },
  {
    name: "FakeSandbox",
    build: () => {},
    make: () => async (): Promise<SandboxUnderTest> => ({ sandbox: new FakeSandbox(), repo: "/repo", base_ref: "main", env: ENV }),
    reattach: true,
    fetchBranch: false,
    mergeCheck: false,
  },
];

// Real git per case: well under a second alone, slower when the whole suite shares the host.
describe.each(IMPLEMENTATIONS)("Sandbox contract: $name", { timeout: 30_000 }, ({ build, make, ...opts }) => {
  const { copy } = gitTemplate(build);
  sandboxContract(make(copy), opts);
});

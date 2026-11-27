import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { localProject } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import { LocalForge } from "../src/impl/forge/local-forge.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { Sandbox } from "../src/interfaces/sandbox.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";

// The red-main check after an automatic merge (design 03-risk) runs the UI check by the merge check's rule: only when
// the merge's own change, the diff from the tip's first parent to the tip, touches one of `repo.ui_check.paths`.
// Each command appends its name to a log, so the test reads what ran and in what order.

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const ident = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
const commitIn = (dir: string, files: Record<string, string>, msg: string) => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, ...ident, "commit", "--quiet", "-m", msg);
};

/**
 * A repo whose main ends in a merge of `feature`: main moved to `onMain` after the branch forked, and the branch
 * changed `onBranch`. The merge's own change (first parent to tip) is `onBranch`; `onMain` is only in the diff from the
 * second parent.
 */
function mergedRepo(onBranch: Record<string, string>, onMain: Record<string, string> = { "notes/main.md": "main\n" }) {
  const root = mkdtempSync(join(tmpdir(), "sf-redmain-ui-"));
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "-b", "main", repo);
  commitIn(repo, { "README.md": "hi\n" }, "init");
  git(repo, "checkout", "--quiet", "-b", "feature");
  commitIn(repo, onBranch, "the change");
  git(repo, "checkout", "--quiet", "main");
  commitIn(repo, onMain, "on main");
  git(repo, ...ident, "merge", "--quiet", "--no-ff", "-m", "Merge feature", "feature");
  git(repo, "checkout", "--quiet", "--detach");
  return { root, repo };
}

async function redMain(repo: string, root: string, wrap: (s: NoOpSandbox) => Sandbox = (s) => s) {
  const log = join(root, "ran.log");
  writeFileSync(log, "");
  const step = (name: string) => ["sh", "-c", `echo ${name} >> '${log}'`];
  const cfg: FactoryConfig = {
    ...config,
    project: localProject({ owner: "o", name: "r" }),
    local_only: true,
    repo: { ...config.repo, path: repo, install_command: step("install"), test_command: step("checks"), ui_check: { command: step("ui"), paths: ["web/", "src/ui/"] } },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const sandbox = wrap(new NoOpSandbox(join(root, "wt"), undefined, undefined, { local: true }));
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config: cfg, log: silent, scanner: cleanScanner,
    sandbox, repeated_failure_rule: false, settings: new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store }),
    check_env: { PATH: process.env.PATH ?? "" }, links: new LocalForge(cfg.branch_prefix, null),
  });
  // A passing round reads only the item's project (the green base it stores).
  await (await controller.unit("local-merge")).redMainCheck({ id: "wi_1", project: cfg.project.key } as never);
  return readFileSync(log, "utf8").split("\n").filter((l) => l !== "");
}

/** The sandbox with `localChangedFiles` replaced by `read` (undefined: a sandbox without the read). */
const changedRead = (read: (() => Promise<string[] | null>) | undefined) => (s: NoOpSandbox): Sandbox =>
  new Proxy(s, { get: (t, k) => (k === "localChangedFiles" ? read : Reflect.get(t, k, t)) });

describe("red main: the UI check by its paths", { timeout: 60_000 }, () => {
  it("a merge that changes no ui_check path runs the install command and the checks, not the UI check", async () => {
    const { root, repo } = mergedRepo({ "src/core/x.ts": "x\n" });
    const ran = await redMain(repo, root);
    expect(ran).toContain("install");
    expect(ran).toContain("checks");
    expect(ran.indexOf("install")).toBeLessThan(ran.indexOf("checks"));
    expect(ran).not.toContain("ui");
  });

  it("a merge that changes a ui_check path runs the UI check after the checks", async () => {
    const { root, repo } = mergedRepo({ "src/ui/page.ts": "p\n" });
    const ran = await redMain(repo, root);
    expect(ran).toContain("ui");
    expect(ran.indexOf("install")).toBeLessThan(ran.indexOf("checks"));
    expect(ran.indexOf("checks")).toBeLessThan(ran.indexOf("ui"));
  });

  it("the changed files are the merge's own change, from its first parent: a UI file only on main's side runs no UI check", async () => {
    // Main touched web/ after the branch forked: in the diff from the second parent, not in the merge's own change.
    const { root, repo } = mergedRepo({ "src/core/x.ts": "x\n" }, { "web/app.css": "a\n" });
    expect(await redMain(repo, root)).not.toContain("ui");
    // The other way round: the branch's UI change is the merge's own change.
    const other = mergedRepo({ "web/app.css": "a\n" }, { "src/core/x.ts": "x\n" });
    expect(await redMain(other.repo, other.root)).toContain("ui");
  });

  it("when the changed files cannot be read, the UI check runs", async () => {
    const cases = [
      changedRead(async () => null),
      changedRead(async () => { throw new Error("git diff failed"); }),
      changedRead(undefined),
    ];
    for (const wrap of cases) {
      const { root, repo } = mergedRepo({ "src/core/x.ts": "x\n" });
      const ran = await redMain(repo, root, wrap);
      expect(ran).toContain("ui");
      expect(ran.indexOf("checks")).toBeLessThan(ran.indexOf("ui"));
    }
  });
});

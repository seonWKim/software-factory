import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExecResult } from "../src/interfaces/sandbox.js";
import { EMPTY_HOOKS_DIR, NoOpSandbox, type ProcessRunner } from "../src/impl/sandbox/noop-sandbox.js";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function repoWithOrigin() {
  const root = mkdtempSync(join(tmpdir(), "sf-sbx-"));
  const origin = join(root, "origin.git");
  const repo = join(root, "repo");
  git(root, "init", "--quiet", "--bare", "-b", "main", origin);
  git(root, "clone", "--quiet", origin, repo);
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "hi\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "init");
  git(repo, "push", "--quiet", "origin", "main");
  return { root, repo, origin };
}

describe("NoOpSandbox", () => {
  it("creates its own clone on a new branch from base, runs commands with only the given env, and destroys it without a trace", async () => {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_1", base_ref: "main" });
    expect(existsSync(join(h.workdir, "README.md"))).toBe(true);

    const r = await sbx.exec(h, ["sh", "-c", 'echo "$SECRET_FROM_WORKER-$ONLY"'], { env: { PATH: process.env.PATH!, ONLY: "x" } });
    expect(r.stdout.trim()).toBe("-x");
    expect((await sbx.exec(h, ["git", "branch", "--show-current"], { env: { PATH: process.env.PATH! } })).stdout.trim()).toBe(
      "factory/wi_1",
    );

    // Its own clone: the git folder is inside the run folder, and the factory repo has no worktree for it.
    expect(statSync(join(h.workdir, ".git")).isDirectory()).toBe(true);
    expect(git(h.workdir, "rev-parse", "--path-format=absolute", "--git-common-dir").trim()).toBe(realpathSync(join(h.workdir, ".git")));
    expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(h.id);
    expect(h.base_sha).toBe(git(repo, "rev-parse", "origin/main").trim());

    await sbx.destroy(h);
    expect(existsSync(h.workdir)).toBe(false);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    expect(git(repo, "branch", "--list")).not.toContain("factory/wi_1");
    await sbx.destroy(h); // idempotent: a second destroy is a no-op
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  it("checks out base detached for a read-only run, with the factory repo's origin/<base> as base_sha", async () => {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: null, base_ref: "main" });
    expect(git(h.workdir, "rev-parse", "HEAD").trim()).toBe(h.base_sha);
    expect(git(h.workdir, "branch", "--show-current").trim()).toBe("");
    await sbx.destroy(h);
  });

  it("refuses to point a clone at a hooks folder someone put a file in", async () => {
    const { root, repo } = repoWithOrigin();
    const worktrees = join(root, "worktrees");
    const sbx = new NoOpSandbox(worktrees);
    await sbx.destroy(await sbx.create({ repo, branch: null, base_ref: "main" }));
    const hooks = join(worktrees, EMPTY_HOOKS_DIR);
    chmodSync(hooks, 0o755);
    writeFileSync(join(hooks, "pre-commit"), "#!/bin/sh\n");
    await expect(sbx.create({ repo, branch: null, base_ref: "main" })).rejects.toThrow(/not empty/);
  });

  it("resumes from the remote branch when it exists", async () => {
    const { root, repo } = repoWithOrigin();
    git(repo, "checkout", "--quiet", "-b", "factory/wi_2");
    writeFileSync(join(repo, "work.txt"), "w\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "work");
    git(repo, "push", "--quiet", "origin", "factory/wi_2");
    git(repo, "checkout", "--quiet", "main");

    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_2", base_ref: "main" });
    expect(existsSync(join(h.workdir, "work.txt"))).toBe(true);
    await sbx.destroy(h);
  });

  describe("updateBase", () => {
    const ok = (stdout = ""): ExecResult => ({ exit_code: 0, signal: null, stdout, stderr: "", timed_out: false });
    const fail = (stderr: string): ExecResult => ({ exit_code: 1, signal: null, stdout: "", stderr, timed_out: false });
    const isFetch = (cmd: readonly string[]) => cmd.includes("fetch");
    const noWait = async () => {};

    it("fetches only the base branch, with no --prune", async () => {
      const calls: (readonly string[])[] = [];
      const run: ProcessRunner = async (cmd) => {
        calls.push(cmd);
        return ok(isFetch(cmd) ? "" : "abc\n");
      };
      const sbx = new NoOpSandbox("/nowhere", run, noWait);
      expect(await sbx.updateBase({ repo: "/repo-refspec", base_ref: "main" })).toBe("abc");
      const fetches = calls.filter(isFetch);
      expect(fetches).toEqual([
        ["git", "-C", "/repo-refspec", "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
      ]);
    });

    it("never runs two fetches for the same repo at once", async () => {
      let inFlight = 0;
      let max = 0;
      const run: ProcessRunner = async (cmd) => {
        if (!isFetch(cmd)) return ok("abc\n");
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return ok();
      };
      const sbx = new NoOpSandbox("/nowhere", run, noWait);
      const other = new NoOpSandbox("/nowhere", run, noWait);
      await Promise.all([
        sbx.updateBase({ repo: "/repo-serial", base_ref: "main" }),
        sbx.updateBase({ repo: "/repo-serial", base_ref: "main" }),
        other.updateBase({ repo: "/repo-serial", base_ref: "main" }),
      ]);
      expect(max).toBe(1);
    });

    it("keeps serializing after a failed fetch", async () => {
      let first = true;
      const run: ProcessRunner = async (cmd) => {
        if (isFetch(cmd) && first) {
          first = false;
          return fail("fatal: repository not found");
        }
        return ok("abc\n");
      };
      const sbx = new NoOpSandbox("/nowhere", run, noWait);
      const [a, b] = await Promise.allSettled([
        sbx.updateBase({ repo: "/repo-failchain", base_ref: "main" }),
        sbx.updateBase({ repo: "/repo-failchain", base_ref: "main" }),
      ]);
      expect(a.status).toBe("rejected");
      expect(b).toEqual({ status: "fulfilled", value: "abc" });
    });

    for (const msg of [
      "error: cannot lock ref 'refs/remotes/origin/main': is at 1 but expected 2",
      "error: update_ref failed for ref 'refs/remotes/origin/main': incorrect old value provided",
      "error: unable to update local ref",
    ]) {
      it(`retries a ref-lock failure (${msg.slice(0, 30)}...) and succeeds when a later attempt works`, async () => {
        let fetches = 0;
        const waits: number[] = [];
        const run: ProcessRunner = async (cmd) => {
          if (!isFetch(cmd)) return ok("abc\n");
          fetches++;
          return fetches < 3 ? fail(msg) : ok();
        };
        const sbx = new NoOpSandbox("/nowhere", run, async (ms) => void waits.push(ms));
        expect(await sbx.updateBase({ repo: "/repo-retry", base_ref: "main" })).toBe("abc");
        expect(fetches).toBe(3);
        expect(waits).toHaveLength(2);
      });
    }

    it("throws a persistent ref-lock error after 3 retries, in the usual message format", async () => {
      let fetches = 0;
      const run: ProcessRunner = async (cmd) => {
        if (!isFetch(cmd)) return ok("abc\n");
        fetches++;
        return fail("error: cannot lock ref 'refs/remotes/origin/main'\n");
      };
      const sbx = new NoOpSandbox("/nowhere", run, noWait);
      await expect(sbx.updateBase({ repo: "/repo-persist", base_ref: "main" })).rejects.toThrow(
        new Error("git fetch failed: error: cannot lock ref 'refs/remotes/origin/main'"),
      );
      expect(fetches).toBe(4);
    });

    it("throws any other git error on the first attempt", async () => {
      let fetches = 0;
      const run: ProcessRunner = async (cmd) => {
        if (!isFetch(cmd)) return ok("abc\n");
        fetches++;
        return fail("fatal: repository not found");
      };
      const sbx = new NoOpSandbox("/nowhere", run, noWait);
      await expect(sbx.updateBase({ repo: "/repo-other", base_ref: "main" })).rejects.toThrow(
        "git fetch failed: fatal: repository not found",
      );
      expect(fetches).toBe(1);
    });

    it("create's fetch keeps --prune for all origin branches, serialized and retried", async () => {
      const { root, repo } = repoWithOrigin();
      let lockFailures = 1;
      const fetches: (readonly string[])[] = [];
      const real = (await import("../src/impl/process/run-process.js")).runProcess;
      const run: ProcessRunner = async (cmd, opts) => {
        if (isFetch(cmd) && cmd[2] === repo) {
          fetches.push(cmd);
          if (lockFailures-- > 0) return fail("error: cannot lock ref 'refs/remotes/origin/main'");
        }
        return real(cmd, opts);
      };
      const sbx = new NoOpSandbox(join(root, "worktrees"), run, noWait);
      const h = await sbx.create({ repo, branch: null, base_ref: "main" });
      expect(fetches).toEqual([
        ["git", "-C", repo, "fetch", "--quiet", "--prune", "origin"],
        ["git", "-C", repo, "fetch", "--quiet", "--prune", "origin"],
      ]);
      await sbx.destroy(h);
    });

    it("changes only refs/remotes/origin/<base>", async () => {
      // A symref (origin/HEAD) is compared by its target, not by the commit it resolves to.
      const refs = (cwd: string) =>
        git(cwd, "for-each-ref", "--format=%(refname) %(if)%(symref)%(then)-> %(symref)%(else)%(objectname)%(end)", "refs/remotes/origin/");
      const { root, repo, origin } = repoWithOrigin();
      for (const b of ["feature-a", "feature-b"]) git(repo, "push", "--quiet", "origin", `main:${b}`);
      git(repo, "fetch", "--quiet", "origin");
      const before = refs(repo);

      // The remote moves main and feature-a and deletes feature-b; only main may change locally.
      const pusher = join(root, "pusher");
      git(root, "clone", "--quiet", origin, pusher);
      git(pusher, "config", "user.email", "t@example.com");
      git(pusher, "config", "user.name", "t");
      git(pusher, "commit", "--quiet", "--allow-empty", "-m", "move");
      git(pusher, "push", "--quiet", "origin", "HEAD:main", "HEAD:feature-a", ":feature-b");
      const newMain = git(origin, "rev-parse", "main").trim();

      const sbx = new NoOpSandbox(join(root, "worktrees"));
      expect(await sbx.updateBase({ repo, base_ref: "main" })).toBe(newMain);
      const after = refs(repo);
      const withoutMain = (s: string) => s.split("\n").filter((l) => !l.startsWith("refs/remotes/origin/main ")).join("\n");
      expect(withoutMain(after)).toBe(withoutMain(before));
      expect(git(repo, "rev-parse", "refs/remotes/origin/main").trim()).toBe(newMain);
    });

    it("10 parallel calls all succeed against a remote whose branches are moving", async () => {
      const { root, repo, origin } = repoWithOrigin();
      const pusher = join(root, "pusher");
      git(root, "clone", "--quiet", origin, pusher);
      git(pusher, "config", "user.email", "t@example.com");
      git(pusher, "config", "user.name", "t");
      git(pusher, "commit", "--quiet", "--allow-empty", "-m", "base");
      git(pusher, "push", "--quiet", "origin", "HEAD:main");
      const mainSha = git(origin, "rev-parse", "main").trim();

      let moving = true;
      const mover = (async () => {
        const { runProcess } = await import("../src/impl/process/run-process.js");
        const env = { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: "/dev/null", HOME: root };
        for (let i = 0; moving && i < 50; i++) {
          await runProcess(["git", "commit", "--quiet", "--allow-empty", "-m", `m${i}`], { cwd: pusher, env });
          await runProcess(["git", "push", "--quiet", "--force", "origin", `HEAD:side-${i % 3}`], { cwd: pusher, env });
        }
      })();

      const sbx = new NoOpSandbox(join(root, "worktrees"));
      const results = await Promise.all(Array.from({ length: 10 }, () => sbx.updateBase({ repo, base_ref: "main" })));
      moving = false;
      await mover;
      expect(results).toEqual(Array(10).fill(mainSha));
    }, 30_000);
  });
});

describe("NoOpSandbox run folder with a read-only node_modules", () => {
  // Runs vitest on one small passing test in a NoOpSandbox run folder whose node_modules is read-only, with `extra`
  // appended to the run folder's own `npm test` command (package.json `scripts.test`). Restores write access before
  // the run folder is destroyed, so nothing the owner has is left read-only.
  async function vitestInReadOnlyRunFolder(extra: string[]) {
    const { root, repo } = repoWithOrigin();
    const sbx = new NoOpSandbox(join(root, "worktrees"));
    const h = await sbx.create({ repo, branch: "factory/wi_ro", base_ref: "main" });
    // The shared node_modules: a folder of links to the owner's packages, so its top level can be made read-only
    // without touching the owner's files. It already has a `.vite-temp`, as a shared node_modules that has run vite
    // once does: then Vite's `mkdir -p` succeeds and its EACCES fallback never runs.
    const real = dirname(dirname(createRequire(import.meta.url).resolve("vitest/package.json")));
    const nm = join(h.workdir, "node_modules");
    const viteTemp = join(nm, ".vite-temp");
    mkdirSync(nm);
    mkdirSync(viteTemp);
    for (const e of readdirSync(real).filter((n) => !n.startsWith("."))) symlinkSync(join(real, e), join(nm, e));
    // The run folder is a clone of the factory repo: its package.json makes vitest.config.ts an ES module, which is
    // the case where Vite writes the bundled config to node_modules/.vite-temp.
    await sbx.copyIn(h, join(process.cwd(), "package.json"), "package.json");
    await sbx.copyIn(h, join(process.cwd(), "vitest.config.ts"), "vitest.config.ts");
    mkdirSync(join(h.workdir, "tests"));
    writeFileSync(
      join(h.workdir, "tests", "small.test.ts"),
      'import { expect, it } from "vitest";\nit("passes", () => { expect(1 + 1).toBe(2); });\n',
    );
    const script = (JSON.parse(readFileSync(join(h.workdir, "package.json"), "utf8")) as { scripts: { test: string } }).scripts.test;
    const [bin, ...args] = script.split(/\s+/);
    expect(bin).toBe("vitest");
    const before = readdirSync(nm).sort();
    chmodSync(viteTemp, 0o555);
    chmodSync(nm, 0o555);
    try {
      const r = await sbx.exec(h, ["node", join(real, "vitest", "vitest.mjs"), ...args, ...extra], {
        env: { PATH: process.env.PATH!, HOME: root, TMPDIR: tmpdir(), CI: "1" },
      });
      return {
        r,
        added: readdirSync(nm).filter((n) => !before.includes(n)),
        tempFiles: readdirSync(viteTemp),
        cache: existsSync(join(h.workdir, ".vite-cache")),
      };
    } finally {
      chmodSync(nm, 0o755);
      chmodSync(viteTemp, 0o755);
      await sbx.destroy(h);
    }
  }

  // Known gap (#225): with the default `bundle` config loader, Vite writes the bundled vitest.config.ts to
  // node_modules/.vite-temp before any setting in vitest.config.ts applies, so `npm test` as it stands fails here
  // (EPERM on the host, EACCES in this fake). Only the command can change that (`--configLoader runner`), and
  // package.json is outside this change. When `scripts.test` gains the flag, this test fails: turn `it.fails` into `it`.
  it.fails("runs the run folder's own `npm test` command to a pass, writing nothing under node_modules", async () => {
    const { r, added, tempFiles } = await vitestInReadOnlyRunFolder([]);
    expect(r.stderr + r.stdout).toContain("1 passed");
    expect(r.exit_code).toBe(0);
    expect(added).toEqual([]);
    expect(tempFiles).toEqual([]);
  });

  it("with --configLoader runner, passes and writes nothing under node_modules, its cache going to .vite-cache in the run folder", async () => {
    const { r, added, tempFiles, cache } = await vitestInReadOnlyRunFolder(["--configLoader", "runner"]);
    expect(r.stderr + r.stdout).toContain("1 passed");
    expect(r.exit_code).toBe(0);
    expect(added).toEqual([]);
    expect(tempFiles).toEqual([]);
    expect(cache).toBe(true);
  });
});

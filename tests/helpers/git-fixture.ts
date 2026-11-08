import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, beforeAll } from "vitest";

// Shared git fixtures for the tests that run real git (issue #469): one git call with a fixed identity and no
// global config, and a template layout built once per file that each test copies.

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "agent", GIT_AUTHOR_EMAIL: "agent@example.com",
  GIT_COMMITTER_NAME: "agent", GIT_COMMITTER_EMAIL: "agent@example.com",
};

/** Runs git in `cwd` with a fixed identity and no global config; returns its trimmed stdout. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
}

const tempDir = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

/** Every git folder's `config` under `dir`: a `.git` folder's, and a bare repository's (it holds HEAD). */
function gitConfigs(dir: string): string[] {
  const found: string[] = [];
  if (existsSync(join(dir, "HEAD")) && existsSync(join(dir, "config"))) found.push(join(dir, "config"));
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory() && e.name !== "objects" && e.name !== "refs") found.push(...gitConfigs(join(dir, e.name)));
  }
  return found;
}

/**
 * Registers a template in the current suite (a describe, or the file): `build(root)` runs once in beforeAll to
 * create the layout, and afterAll removes the template and every copy. `copy()` gives a test its own folder with
 * the same layout, as a realpath (the macOS tmp folder is a symlink); the template's path is rewritten to the copy
 * in each git config, so remote URLs point at the copy and no test shares a repository.
 */
export function gitTemplate(build: (root: string) => void): { copy: () => string } {
  let template = "";
  const copies: string[] = [];
  beforeAll(() => {
    template = tempDir("sf-git-template-");
    build(template);
  });
  afterAll(() => {
    for (const dir of [template, ...copies]) if (dir) rmSync(dir, { recursive: true, force: true });
  });
  return {
    copy: () => {
      const root = tempDir("sf-git-");
      copies.push(root);
      cpSync(template, root, { recursive: true, verbatimSymlinks: true });
      for (const config of gitConfigs(root)) {
        const text = readFileSync(config, "utf8");
        if (text.includes(template)) writeFileSync(config, text.replaceAll(template, root));
        // A copied index holds the template's file stats (inode, ctime), so plumbing such as diff-files sees every
        // file as changed and the first porcelain call rewrites the index. Refresh it so the copy is a clean clone.
        if (basename(dirname(config)) === ".git") git(dirname(dirname(config)), "update-index", "-q", "--refresh");
      }
      return root;
    },
  };
}

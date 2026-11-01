import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTPUT_CAP,
  TOOLS,
  type GuardPolicyInput,
  type ToolContext,
  type ToolResult,
  guardPolicy,
} from "../src/core/tools/index.js";
import { NoOpSandbox } from "../src/impl/sandbox/noop-sandbox.js";
import type { ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";

// Part 1 of 3 for #58: the shared file and shell tools and their guards, run against the real NoOpSandbox.
// macOS: tmpdir() is under /var, a symlink to /private/var. `raw` is the path as tmpdir() gives it, `root`
// is its canonical form; tests use both, so a guard that compares only one form fails here.

const SECRET = "TOP-SECRET-CONTENT-7f3a";
const OUTSIDE = "OUTSIDE-CONTENT-91be";

let raw: string;
let root: string;
let sbx: NoOpSandbox;
let h: SandboxHandle;
let workdir: string; // canonical
let denied: string; // outside the workdir, in deny_paths
let outside: string; // outside the workdir, not denied, not writable
let writable: string; // outside the workdir, in writable_paths

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
}

function policyInput(over: Partial<GuardPolicyInput> = {}): GuardPolicyInput {
  return {
    workdir: h.workdir,
    deny_paths: [denied, join(workdir, "vault")],
    writable_paths: [writable],
    env_allowlist: { GIT_AUTHOR_NAME: "factory" },
    ...over,
  };
}

function ctx(over: Partial<GuardPolicyInput> = {}, sandbox: Sandbox = sbx): ToolContext {
  return { sandbox, handle: h, policy: guardPolicy(policyInput(over)) };
}

function tool(name: string) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
}

/** Runs a tool and asserts the call resolves (never throws), whatever the outcome. */
async function call(name: string, input: unknown, c: ToolContext = ctx()): Promise<ToolResult> {
  const p = tool(name).run(input, c);
  await expect(p).resolves.toHaveProperty("ok");
  return p;
}

function refused(r: ToolResult) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error("expected a refusal");
  expect(typeof r.error).toBe("string");
  return r;
}

function content(r: ToolResult): string {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.content;
}

beforeAll(async () => {
  raw = mkdtempSync(join(tmpdir(), "sf-tools-"));
  root = realpathSync(raw);
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

  // The sandbox gets the non-canonical path, as the factory would on macOS.
  sbx = new NoOpSandbox(join(raw, "worktrees"));
  h = await sbx.create({ repo, branch: "factory/wi_tools", base_ref: "main" });
  workdir = realpathSync(h.workdir);

  denied = join(root, "secrets");
  mkdirSync(denied);
  writeFileSync(join(denied, "key.txt"), `${SECRET}\n`);
  outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "plain.txt"), `${OUTSIDE}\n`);
  writable = join(root, "writable");
  mkdirSync(writable);

  // Glob/Grep fixtures: a denied folder and a .env inside the workdir, next to an allowed file.
  mkdirSync(join(workdir, "src"));
  writeFileSync(join(workdir, "src", "a.txt"), "needle visible\n");
  mkdirSync(join(workdir, "vault"));
  writeFileSync(join(workdir, "vault", "inner.txt"), `needle ${SECRET}\n`);
  writeFileSync(join(workdir, ".env"), `needle ${SECRET}\n`);
  // Symlinks into denied paths, and a dangling one pointing outside.
  symlinkSync(join(denied, "key.txt"), join(workdir, "link-to-secret"));
  symlinkSync(denied, join(workdir, "link-to-denied-dir"));
  // A symlink to a denied path inside the workdir: only the deny check (not the root check) can stop it.
  symlinkSync(join(workdir, "vault", "inner.txt"), join(workdir, "link-to-vault"));
  symlinkSync(join(outside, "created-through-dangling.txt"), join(workdir, "dangling"));
});

afterAll(async () => {
  if (h) await sbx.destroy(h);
});

describe("tool specs", () => {
  it("exports exactly six tools with their capabilities, each a full ToolSpec", () => {
    expect(TOOLS.map((t) => [t.name, t.capability])).toEqual([
      ["Read", "read"],
      ["Glob", "read"],
      ["Grep", "read"],
      ["Write", "write"],
      ["Edit", "write"],
      ["Bash", "exec"],
    ]);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.input_schema).toMatchObject({ type: "object", properties: expect.any(Object), required: expect.any(Array) });
      expect(typeof t.run).toBe("function");
    }
  });

  it("caps output at 64 KiB", () => {
    expect(OUTPUT_CAP).toBe(64 * 1024);
  });
});

describe("guardPolicy", () => {
  it("normalizes paths against the workdir and builds the shell env from the allowlist only", () => {
    process.env.GITHUB_TOKEN = "ghp_policy_test_value";
    try {
      const p = guardPolicy({
        workdir: "/w/run/",
        deny_paths: ["/home/u/.ssh/../.aws", "/w/run/vault/"],
        writable_paths: ["cache", "/tmp/x/./y"],
        env_allowlist: { GIT_AUTHOR_NAME: "factory" },
      });
      expect(p.workdir).toBe("/w/run");
      expect(p.deny_paths).toEqual(["/home/u/.aws", "/w/run/vault"]);
      expect(p.writable_paths).toEqual(["/w/run/cache", "/tmp/x/y"]);
      expect(p.env.GIT_AUTHOR_NAME).toBe("factory");
      expect(p.env.PATH).toBeTruthy();
      expect(Object.values(p.env)).not.toContain("ghp_policy_test_value");
      expect(p.env).not.toHaveProperty("GITHUB_TOKEN");
      expect(p.env_refusal).toBeNull();
      expect(p.invalid).toBeNull();
      expect(p.output_cap).toBe(OUTPUT_CAP);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("marks a secret-looking env_allowlist key as a refusal and keeps it out of the env", () => {
    const p = guardPolicy({ workdir: "/w", deny_paths: [], writable_paths: [], env_allowlist: { MY_API_KEY: "x", OK: "1" } });
    expect(p.env_refusal).toMatch(/MY_API_KEY/);
    expect(p.env).not.toHaveProperty("MY_API_KEY");
  });

  it("marks a relative workdir as invalid", () => {
    expect(guardPolicy({ workdir: "run", deny_paths: [], writable_paths: [], env_allowlist: {} }).invalid).toMatch(/absolute/);
  });
});

describe("Read", () => {
  it("reads a file in the workdir by relative and absolute path, with line numbers", async () => {
    expect(content(await call("Read", { file_path: "README.md" }))).toContain("hi");
    expect(content(await call("Read", { file_path: join(workdir, "src", "a.txt") }))).toMatch(/^1\tneedle visible/);
    // The non-canonical form of the workdir is the same place.
    expect(content(await call("Read", { file_path: join(h.workdir, "README.md") }))).toContain("hi");
  });

  it("refuses a file under a deny_paths entry and returns none of its content", async () => {
    for (const file_path of [join(denied, "key.txt"), join(raw, "secrets", "key.txt")]) {
      const r = refused(await call("Read", { file_path }));
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    // The deny entry given in non-canonical form still covers the canonical path.
    const c = ctx({ deny_paths: [join(raw, "secrets")], writable_paths: [denied] });
    expect(JSON.stringify(refused(await call("Read", { file_path: join(denied, "key.txt") }, c)))).not.toContain(SECRET);
  });

  it("refuses a denied path even when it is inside writable_paths", async () => {
    const c = ctx({ writable_paths: [denied] });
    expect(JSON.stringify(refused(await call("Read", { file_path: join(denied, "key.txt") }, c)))).not.toContain(SECRET);
  });

  it("refuses a .. path that resolves outside the workdir and writable_paths", async () => {
    const rel = relative(workdir, join(outside, "plain.txt"));
    expect(rel.startsWith("..")).toBe(true);
    for (const file_path of [rel, `src/../${rel}`, join(workdir, rel)]) {
      expect(JSON.stringify(refused(await call("Read", { file_path })))).not.toContain(OUTSIDE);
    }
  });

  it("refuses a .env file in the workdir", async () => {
    expect(JSON.stringify(refused(await call("Read", { file_path: ".env" })))).not.toContain(SECRET);
  });

  it("refuses a symlink in the workdir that points into a denied path", async () => {
    for (const file_path of ["link-to-secret", "link-to-denied-dir/key.txt", "link-to-vault"]) {
      expect(JSON.stringify(refused(await call("Read", { file_path })))).not.toContain(SECRET);
    }
  });

  it("cuts output over the cap and marks it truncated", async () => {
    writeFileSync(join(workdir, "big.txt"), "x".repeat(OUTPUT_CAP * 3 + 5));
    const r = await call("Read", { file_path: "big.txt" });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(content(r)).toHaveLength(OUTPUT_CAP);
  });

  it("returns offset and limit lines", async () => {
    writeFileSync(join(workdir, "lines.txt"), "one\ntwo\nthree\nfour\n");
    const c = content(await call("Read", { file_path: "lines.txt", offset: 2, limit: 2 }));
    expect(c).toBe("2\ttwo\n3\tthree");
  });

  it("refuses a missing file, a directory, a bad input and a path with control characters", async () => {
    refused(await call("Read", { file_path: "nope.txt" }));
    refused(await call("Read", { file_path: "src" }));
    refused(await call("Read", {}));
    refused(await call("Read", null));
    refused(await call("Read", { file_path: "a\nb" }));
  });
});

describe("Write", () => {
  it("writes a file in the workdir, creating folders", async () => {
    const r = await call("Write", { file_path: "new/dir/file.txt", content: "hello\n" });
    expect(r.ok).toBe(true);
    expect(readFileSync(join(workdir, "new", "dir", "file.txt"), "utf8")).toBe("hello\n");
  });

  it("writes into a writable_paths entry", async () => {
    expect((await call("Write", { file_path: join(writable, "out.txt"), content: "w" })).ok).toBe(true);
    expect(readFileSync(join(writable, "out.txt"), "utf8")).toBe("w");
    const rel = relative(workdir, join(writable, "rel.txt"));
    expect((await call("Write", { file_path: rel, content: "r" })).ok).toBe(true);
    expect(readFileSync(join(writable, "rel.txt"), "utf8")).toBe("r");
  });

  it("refuses a target outside the workdir and writable_paths, and creates nothing there", async () => {
    const rel = relative(workdir, join(outside, "w1.txt"));
    refused(await call("Write", { file_path: rel, content: "x" }));
    refused(await call("Write", { file_path: join(outside, "w2.txt"), content: "x" }));
    refused(await call("Write", { file_path: join(outside, "sub", "w3.txt"), content: "x" }));
    expect(existsSync(join(outside, "w1.txt"))).toBe(false);
    expect(existsSync(join(outside, "w2.txt"))).toBe(false);
    expect(existsSync(join(outside, "sub"))).toBe(false);
  });

  it("refuses a target under a deny_paths entry", async () => {
    refused(await call("Write", { file_path: "vault/new.txt", content: "x" }));
    expect(existsSync(join(workdir, "vault", "new.txt"))).toBe(false);
  });

  it("refuses to write through a symlink into a denied path, or through a dangling symlink", async () => {
    refused(await call("Write", { file_path: "link-to-secret", content: "overwritten" }));
    expect(readFileSync(join(denied, "key.txt"), "utf8")).toBe(`${SECRET}\n`);
    refused(await call("Write", { file_path: "link-to-denied-dir/new.txt", content: "x" }));
    expect(existsSync(join(denied, "new.txt"))).toBe(false);
    refused(await call("Write", { file_path: "link-to-vault", content: "overwritten" }));
    expect(readFileSync(join(workdir, "vault", "inner.txt"), "utf8")).toBe(`needle ${SECRET}\n`);
    refused(await call("Write", { file_path: "dangling", content: "x" }));
    expect(existsSync(join(outside, "created-through-dangling.txt"))).toBe(false);
  });

  it("refuses a bad input", async () => {
    refused(await call("Write", { file_path: "x.txt" }));
    refused(await call("Write", { content: "x" }));
  });
});

describe("Edit", () => {
  it("replaces a unique string, and every occurrence with replace_all", async () => {
    writeFileSync(join(workdir, "edit.txt"), "alpha beta alpha\n");
    refused(await call("Edit", { file_path: "edit.txt", old_string: "alpha", new_string: "x" })); // not unique
    expect((await call("Edit", { file_path: "edit.txt", old_string: "beta", new_string: "gamma" })).ok).toBe(true);
    expect(readFileSync(join(workdir, "edit.txt"), "utf8")).toBe("alpha gamma alpha\n");
    expect((await call("Edit", { file_path: "edit.txt", old_string: "alpha", new_string: "a", replace_all: true })).ok).toBe(true);
    expect(readFileSync(join(workdir, "edit.txt"), "utf8")).toBe("a gamma a\n");
    refused(await call("Edit", { file_path: "edit.txt", old_string: "missing", new_string: "y" }));
    refused(await call("Edit", { file_path: "edit.txt", old_string: "a", new_string: "a" }));
  });

  it("refuses a .. path outside the workdir and writable_paths", async () => {
    const rel = relative(workdir, join(outside, "plain.txt"));
    const r = refused(await call("Edit", { file_path: rel, old_string: "OUTSIDE", new_string: "changed" }));
    expect(JSON.stringify(r)).not.toContain(OUTSIDE);
    expect(readFileSync(join(outside, "plain.txt"), "utf8")).toBe(`${OUTSIDE}\n`);
  });

  it("refuses a denied file and a symlink into a denied path", async () => {
    for (const file_path of [join(denied, "key.txt"), "link-to-secret", "link-to-denied-dir/key.txt", "link-to-vault"]) {
      const r = refused(await call("Edit", { file_path, old_string: "TOP", new_string: "x" }));
      expect(JSON.stringify(r)).not.toContain(SECRET);
    }
    expect(readFileSync(join(denied, "key.txt"), "utf8")).toBe(`${SECRET}\n`);
  });

  it("refuses a missing file and a bad input", async () => {
    refused(await call("Edit", { file_path: "nope.txt", old_string: "a", new_string: "b" }));
    refused(await call("Edit", { file_path: "edit.txt" }));
  });
});

describe("Glob and Grep", () => {
  it("Glob lists allowed files and nothing under a denied path", async () => {
    const out = content(await call("Glob", { pattern: "**/*" }));
    expect(out).toContain(join(workdir, "src", "a.txt"));
    expect(out).not.toContain("vault");
    expect(out).not.toContain(".env");
    expect(out).not.toContain(".git/");
    expect(content(await call("Glob", { pattern: "src/*.txt" }))).toBe(join(workdir, "src", "a.txt"));
    expect(content(await call("Glob", { pattern: "*.md" }))).toBe(join(workdir, "README.md"));
  });

  it("Grep returns matching lines from allowed files and nothing from under a denied path", async () => {
    const out = content(await call("Grep", { pattern: "needle" }));
    expect(out).toContain("needle visible");
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("vault");
    expect(out).not.toContain(".env");
    const files = content(await call("Grep", { pattern: "needle", output_mode: "files_with_matches" }));
    expect(files).toBe(join(workdir, "src", "a.txt"));
    expect(content(await call("Grep", { pattern: "NEEDLE", ignore_case: true, glob: "*.txt" }))).toContain("needle visible");
  });

  it("Glob and Grep refuse a denied, outside or symlinked search root", async () => {
    for (const path of ["vault", denied, outside, "link-to-denied-dir"]) {
      expect(JSON.stringify(refused(await call("Glob", { pattern: "**/*", path })))).not.toContain("key.txt");
      expect(JSON.stringify(refused(await call("Grep", { pattern: "needle|TOP", path })))).not.toContain(SECRET);
    }
  });

  it("Grep finds nothing and says so; bad inputs are refused", async () => {
    expect(content(await call("Grep", { pattern: "no-such-string-anywhere-zzz" }))).toBe("");
    refused(await call("Grep", {}));
    refused(await call("Glob", {}));
  });
});

describe("Bash", () => {
  it("runs a command in the workdir with only the allowlisted env", async () => {
    process.env.GITHUB_TOKEN = "ghp_should_never_appear_123";
    try {
      const out = content(await call("Bash", { command: "env; pwd" }));
      expect(out).toContain("GIT_AUTHOR_NAME=factory");
      expect(out).not.toContain("GITHUB_TOKEN");
      expect(out).not.toContain("ghp_should_never_appear_123");
      expect(out).toContain(workdir);
    } finally {
      delete process.env.GITHUB_TOKEN;
    }
  });

  it("reports a non-zero exit code in the content", async () => {
    const out = content(await call("Bash", { command: "echo out; echo err >&2; exit 3" }));
    expect(out).toContain("out");
    expect(out).toContain("err");
    expect(out).toContain("exit code 3");
  });

  it("refuses when env_allowlist has a secret-looking key", async () => {
    for (const word of ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL", "API_KEY", "PRIVATE", "token"]) {
      const c = ctx({ env_allowlist: { [`MY_${word}_X`]: "v" } });
      const r = refused(await call("Bash", { command: "touch bash-ran.txt" }, c));
      expect(r.error).toMatch(new RegExp(`MY_${word}_X`));
    }
    expect(existsSync(join(workdir, "bash-ran.txt"))).toBe(false);
  });

  it("cuts output over the cap and marks it truncated", async () => {
    const r = await call("Bash", { command: `head -c ${OUTPUT_CAP * 3} /dev/zero | tr '\\0' y` });
    expect(r).toMatchObject({ ok: true, truncated: true });
    expect(content(r)).toHaveLength(OUTPUT_CAP);
  });

  it("refuses on timeout and on a bad input", async () => {
    refused(await call("Bash", { command: "sleep 5", timeout_ms: 100 }));
    refused(await call("Bash", {}));
  });
});

describe("shell metacharacters in file names", () => {
  it("are passed as arguments, never spliced into a shell string", async () => {
    const name = "a$(touch PWNED1);touch PWNED2;`touch PWNED3`'\"b.txt";
    expect((await call("Write", { file_path: name, content: "meta\n" })).ok).toBe(true);
    expect(readFileSync(join(workdir, name), "utf8")).toBe("meta\n");
    expect(content(await call("Read", { file_path: name }))).toContain("meta");
    expect((await call("Edit", { file_path: name, old_string: "meta", new_string: "edited" })).ok).toBe(true);
    expect(content(await call("Glob", { pattern: "a*b.txt" }))).toContain(name);
    expect(content(await call("Grep", { pattern: "$(touch PWNED4)|edited", glob: "a*" }))).toContain("edited");
    for (const marker of ["PWNED1", "PWNED2", "PWNED3", "PWNED4"]) {
      expect(existsSync(join(workdir, marker))).toBe(false);
      expect(existsSync(join(process.cwd(), marker))).toBe(false);
    }
  });
});

describe("sandbox failures", () => {
  const throwing: Sandbox = {
    create: () => Promise.reject(new Error("no")),
    updateBase: () => Promise.reject(new Error("no")),
    exec: () => Promise.reject(new Error("sandbox is gone")),
    copyIn: () => Promise.reject(new Error("no")),
    copyOut: () => Promise.reject(new Error("no")),
    destroy: () => Promise.resolve(),
  };
  const failing: Sandbox = {
    ...throwing,
    exec: (): Promise<ExecResult> => Promise.resolve({ exit_code: 1, signal: null, stdout: "", stderr: "boom", timed_out: false }),
  };

  for (const [label, sandbox] of [["throws", throwing], ["fails", failing]] as const) {
    it(`every tool returns {ok:false} when the sandbox ${label}`, async () => {
      const inputs: Record<string, unknown> = {
        Read: { file_path: "README.md" },
        Glob: { pattern: "**/*" },
        Grep: { pattern: "x" },
        Write: { file_path: "f.txt", content: "x" },
        Edit: { file_path: "README.md", old_string: "hi", new_string: "ho" },
        Bash: { command: "true" },
      };
      for (const t of TOOLS) {
        const r = await call(t.name, inputs[t.name], ctx({}, sandbox));
        if (t.name === "Bash" && label === "fails") {
          // A command that exits non-zero is a result, not a sandbox failure.
          expect(content(r)).toContain("exit code 1");
        } else {
          refused(r);
        }
      }
    });
  }

  it("every tool refuses with a relative workdir", async () => {
    for (const t of TOOLS) refused(await call(t.name, { file_path: "README.md", pattern: "x", command: "true" }, ctx({ workdir: "rel" })));
  });
});

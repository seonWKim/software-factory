// The run-side install cache (design 05-sandbox.md): a run folder's repo.install_command step clones the
// node_modules cached for its package-lock.json from `<state_dir>/run-deps/<hash>/node_modules` and skips the
// install; a miss installs once and stores the result through a temporary name; the cache keeps the 3 most recently
// used entries. A fake exec (real `cp`/`rm`/`touch` in temp folders, never `npm ci`) and a temp state dir.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RUN_DEPS_KEEP, cachedInstall, cloneArgv, isInstallCommand, prune } from "../src/worker/install-cache.js";
import type { ExecResult, Sandbox, SandboxHandle } from "../src/interfaces/sandbox.js";
import type { Logger } from "../src/core/log.js";
import type { ToolchainConfig } from "../src/core/config.js";
import { config } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { issue, system } from "./helpers/store.js";

const hashOf = (lock: string) => createHash("sha256").update(lock).digest("hex").slice(0, 16);

/** A temp state dir and run folders, and an exec that runs each command for real in the run folder (except `fails`). */
function world() {
  const root = mkdtempSync(join(tmpdir(), "sf-install-cache-"));
  const state = join(root, "state");
  const cache = join(state, "run-deps");
  const calls: string[][] = [];
  const fails: ((argv: readonly string[]) => boolean)[] = [];
  const warnings: string[] = [];
  const sandbox = {
    exec: async (h: SandboxHandle, argv: readonly string[]): Promise<ExecResult> => {
      calls.push([...argv]);
      if (fails.some((f) => f(argv))) return { exit_code: 1, signal: null, stdout: "", stderr: "cp: clone not supported", timed_out: false };
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd: h.workdir, encoding: "utf8" });
      return { exit_code: r.status, signal: null, stdout: r.stdout, stderr: r.stderr, timed_out: false };
    },
  } as unknown as Sandbox;
  const log = { info: () => {}, warn: (m: string) => warnings.push(m), error: () => {}, debug: () => {} } as unknown as Logger;
  const w = { d: { install_cache: cache, sandbox, toolEnv: {}, log } };
  /** A run folder with `lock` as its package-lock.json. */
  const folder = (name: string, lock: string): SandboxHandle => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package-lock.json"), lock);
    return { id: name, workdir: dir };
  };
  let installs = 0;
  /** The install command: writes node_modules/pkg/index.js (`ok`), or fails halfway (`!ok`). */
  const install = (h: SandboxHandle, ok = true) => async () => {
    installs++;
    mkdirSync(join(h.workdir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(h.workdir, "node_modules", "pkg", "index.js"), `installed ${installs}`);
    return { failed: ok ? null : { how: "exited 1" } };
  };
  return { root, state, cache, calls, fails, warnings, w, folder, install, installs: () => installs };
}

const isCp = (argv: readonly string[]) => argv[0] === "cp";

describe("install cache: clone argv", () => {
  it("is `cp -c -R` on macOS and `cp --reflink=auto -R` on Linux", () => {
    expect(cloneArgv("darwin", "/a/node_modules", "node_modules")).toEqual(["cp", "-c", "-R", "--", "/a/node_modules", "node_modules"]);
    expect(cloneArgv("linux", "/a/node_modules", "node_modules")).toEqual(["cp", "--reflink=auto", "-R", "--", "/a/node_modules", "node_modules"]);
  });

  it("only repo.install_command goes through the cache, not a custom warm_command", () => {
    expect(isInstallCommand(["npm", "ci"], ["npm", "ci"])).toBe(true);
    expect(isInstallCommand(["./gradlew", "dependencies"], ["npm", "ci"])).toBe(false);
    expect(isInstallCommand(["npm", "ci", "--x"], ["npm", "ci"])).toBe(false);
  });
});

describe("install cache: a run folder's install step", () => {
  it("a miss installs once and stores node_modules under the lock hash; a second run with the same lock clones it and does not install", async () => {
    const x = world();
    const a = x.folder("a", "lock-1");
    expect(await cachedInstall(x.w, a, x.install(a))).toEqual({ failed: null });
    expect(x.installs()).toBe(1);
    const entry = join(x.cache, hashOf("lock-1"), "node_modules");
    expect(readFileSync(join(entry, "pkg", "index.js"), "utf8")).toBe("installed 1");

    const b = x.folder("b", "lock-1");
    expect(await cachedInstall(x.w, b, x.install(b))).toBeNull();
    expect(x.installs()).toBe(1);
    expect(x.calls).toContainEqual(cloneArgv(process.platform, entry, "node_modules"));
    expect(lstatSync(join(b.workdir, "node_modules")).isDirectory()).toBe(true);
    expect(lstatSync(join(b.workdir, "node_modules")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(b.workdir, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed 1");
  });

  it("deleting one run folder leaves another run folder's node_modules working", async () => {
    const x = world();
    const a = x.folder("a", "lock-1");
    await cachedInstall(x.w, a, x.install(a));
    const b = x.folder("b", "lock-1");
    const c = x.folder("c", "lock-1");
    await cachedInstall(x.w, b, x.install(b));
    await cachedInstall(x.w, c, x.install(c));
    rmSync(b.workdir, { recursive: true, force: true });
    rmSync(a.workdir, { recursive: true, force: true });
    expect(readFileSync(join(c.workdir, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed 1");
  });

  it("a failed install stores nothing, and no temporary folder is left", async () => {
    const x = world();
    const a = x.folder("a", "lock-1");
    expect(await cachedInstall(x.w, a, x.install(a, false))).toEqual({ failed: { how: "exited 1" } });
    expect(existsSync(join(x.cache, hashOf("lock-1")))).toBe(false);
    expect(existsSync(x.cache) ? readdirSync(x.cache) : []).toEqual([]);
    const b = x.folder("b", "lock-1");
    await cachedInstall(x.w, b, x.install(b));
    expect(x.installs()).toBe(2);
  });

  it("a changed package-lock.json installs once and caches the new hash", async () => {
    const x = world();
    for (const [name, lock] of [["a", "lock-1"], ["b", "lock-2"], ["c", "lock-2"]] as const) {
      const h = x.folder(name, lock);
      await cachedInstall(x.w, h, x.install(h));
    }
    expect(x.installs()).toBe(2);
    expect(existsSync(join(x.cache, hashOf("lock-1"), "node_modules"))).toBe(true);
    expect(existsSync(join(x.cache, hashOf("lock-2"), "node_modules"))).toBe(true);
  });

  it("a clone that fails (not supported, or a sandbox that cannot see host paths) runs the install command and goes on", async () => {
    const x = world();
    const a = x.folder("a", "lock-1");
    await cachedInstall(x.w, a, x.install(a));
    x.fails.push(isCp);
    const b = x.folder("b", "lock-1");
    expect(await cachedInstall(x.w, b, x.install(b))).toEqual({ failed: null });
    expect(x.installs()).toBe(2);
    expect(x.warnings.some((m) => m.includes("clone failed"))).toBe(true);
    expect(readFileSync(join(b.workdir, "node_modules", "pkg", "index.js"), "utf8")).toBe("installed 2");
  });

  it("writes through a temporary name: a copy that fails leaves no entry and no temporary folder", async () => {
    const x = world();
    x.fails.push((argv) => isCp(argv) && argv.at(-1)!.includes(".tmp-"));
    const a = x.folder("a", "lock-1");
    expect(await cachedInstall(x.w, a, x.install(a))).toEqual({ failed: null });
    expect(readdirSync(x.cache)).toEqual([]);
    expect(x.warnings.some((m) => m.includes("storing failed"))).toBe(true);
  });

  it("stores by cloning into a temporary folder, then renames it into place", async () => {
    const x = world();
    const a = x.folder("a", "lock-1");
    await cachedInstall(x.w, a, x.install(a));
    const copy = x.calls.find(isCp)!;
    expect(copy.at(-2)).toBe("node_modules");
    expect(copy.at(-1)).toMatch(new RegExp(`/run-deps/\\.tmp-${hashOf("lock-1")}-[^/]+/node_modules$`));
    expect(readdirSync(x.cache)).toEqual([hashOf("lock-1")]);
  });

  it("a temporary folder in the cache is never read as an entry", async () => {
    const x = world();
    mkdirSync(join(x.cache, `.tmp-${hashOf("lock-1")}-partial`, "node_modules"), { recursive: true });
    const a = x.folder("a", "lock-1");
    await cachedInstall(x.w, a, x.install(a));
    expect(x.installs()).toBe(1);
  });

  it("no cache dir, or no package-lock.json: the install command runs as before", async () => {
    const x = world();
    const { install_cache: _unused, ...rest } = x.w.d;
    const none = { d: rest };
    const a = x.folder("a", "lock-1");
    await cachedInstall(none, a, x.install(a));
    expect(x.calls).toEqual([]);
    const b = x.folder("b", "lock-1");
    rmSync(join(b.workdir, "package-lock.json"));
    await cachedInstall(x.w, b, x.install(b));
    expect(x.installs()).toBe(2);
    expect(existsSync(x.cache)).toBe(false);
  });
});

describe("install cache: pruning", () => {
  const past = (s: number) => new Date(s * 1000);

  it(`storing a new entry keeps the ${RUN_DEPS_KEEP} most recently used; a hit counts as a use`, async () => {
    const x = world();
    for (const [n, lock] of ["lock-1", "lock-2", "lock-3"].entries()) {
      const h = x.folder(`f${n}`, lock);
      await cachedInstall(x.w, h, x.install(h));
      utimesSync(join(x.cache, hashOf(lock)), past(1000 + n), past(1000 + n));
    }
    // lock-1 is the oldest entry; a hit on it makes lock-2 the least recently used.
    const hit = x.folder("hit", "lock-1");
    expect(await cachedInstall(x.w, hit, x.install(hit))).toBeNull();
    const h = x.folder("f4", "lock-4");
    await cachedInstall(x.w, h, x.install(h));
    const kept = readdirSync(x.cache);
    expect(kept).toContain(hashOf("lock-1"));
    expect(kept).toContain(hashOf("lock-4"));
    expect(kept).not.toContain(hashOf("lock-2"));
    expect(kept.filter((n) => !n.startsWith("."))).toHaveLength(RUN_DEPS_KEEP);
  });

  it("never touches the updater's deps/ beside it", async () => {
    const x = world();
    const updater = join(x.state, "deps", "abc", "node_modules");
    mkdirSync(updater, { recursive: true });
    for (const n of ["a", "b", "c", "d", "e"]) mkdirSync(join(x.cache, n), { recursive: true });
    await prune(x.cache);
    expect(existsSync(updater)).toBe(true);
    expect(readdirSync(join(x.state, "deps"))).toEqual(["abc"]);
  });
});

// The three install points (merge check, resolve gates, warm step) through the fake sandbox of the pipeline: its
// `cp` into the cache makes the target folder, so the store sees a copied node_modules.
describe("install cache: the merge check, the resolve gates and the warm step use it", () => {
  async function cached(cfg: Parameters<typeof pipeline>[0] = {}) {
    const f = await pipeline(cfg);
    const cache = join(mkdtempSync(join(tmpdir(), "sf-run-deps-")), "run-deps");
    for (const w of [f.w1, f.w2]) Object.assign(w.d, { install_cache: cache });
    f.sandbox.files["package-lock.json"] = "lock-1";
    const exec = f.sandbox.exec.bind(f.sandbox);
    f.sandbox.exec = async (h, cmd, o) => {
      if (cmd[0] === "cp" && cmd.at(-1)!.startsWith(cache)) mkdirSync(cmd.at(-1)!, { recursive: true });
      return exec(h, cmd, o);
    };
    const entry = join(cache, hashOf("lock-1"), "node_modules");
    return { f, entry, installs: () => f.sandbox.commands.filter((c) => c === "npm ci").length };
  }

  async function mergeCheck(f: Awaited<ReturnType<typeof pipeline>>, n: number) {
    const { item } = await f.store.createWorkItem(issue(n), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup", patch: {},
      enqueue: { kind: "merge-check", idempotency_key: `mc-${n}`, input: { merge_check: { base_ref: "main", branches: [`factory/${item.id}`] } } },
    });
    if (!moved.ok) throw new Error("setup");
    expect(await f.w1.tick()).toBe(true);
    return (await f.runs(moved.item, "merge-check"))[0]!.outcome;
  }

  it("merge check: the second run with the same lock does not run the install command, and its checks pass", async () => {
    const { f, entry, installs } = await cached();
    expect(await mergeCheck(f, 1)).toMatchObject({ status: "succeeded", data: { result: "green" } });
    expect(installs()).toBe(1);
    expect(existsSync(entry)).toBe(true);
    const before = f.sandbox.commands.length;
    expect(await mergeCheck(f, 2)).toMatchObject({ status: "succeeded", data: { result: "green" } });
    expect(installs()).toBe(1);
    const second = f.sandbox.commands.slice(before);
    expect(second).toContain(cloneArgv(process.platform, entry, "node_modules").join(" "));
    expect(second).toContain("npm test");
  });

  async function resolveRun(f: Awaited<ReturnType<typeof pipeline>>) {
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup",
      patch: { stage: "RUNNING", change_ref: "42", allowed_paths: ["src/"] },
      enqueue: { kind: "resolve", idempotency_key: `${item.id}:resolve:l0:r1`, input: { notes: "" } },
    });
    if (!moved.ok) throw new Error("setup");
    await f.w1.tick();
    return (await f.runs(moved.item, "resolve"))[0]!.outcome;
  }

  it("resolve gates: a miss installs and stores; a cached lock clones instead, then the checks run", async () => {
    const miss = await cached();
    expect(await resolveRun(miss.f)).toMatchObject({ status: "succeeded" });
    expect(miss.installs()).toBe(1);
    expect(existsSync(miss.entry)).toBe(true);

    const hit = await cached();
    mkdirSync(hit.entry, { recursive: true });
    expect(await resolveRun(hit.f)).toMatchObject({ status: "succeeded" });
    expect(hit.installs()).toBe(0);
    expect(hit.f.sandbox.commands).toContain(cloneArgv(process.platform, hit.entry, "node_modules").join(" "));
    expect(hit.f.sandbox.commands).toContain("npm test");
  });

  it("warm step: a warm_command that is the install command installs in the implement run and clones in the review run", async () => {
    const toolchain: ToolchainConfig = { caches: [], env: {}, warm_command: ["npm", "ci"] };
    const { f, entry, installs } = await cached({ config: { toolchain } });
    await f.submit();
    await f.step();
    expect(f.agentCalls("review")).toBe(1);
    expect(installs()).toBe(1);
    expect(f.sandbox.commands).toContain(cloneArgv(process.platform, entry, "node_modules").join(" "));
  });

  it("warm step: a custom warm_command runs as it is and never touches the cache", async () => {
    const toolchain: ToolchainConfig = { caches: [], env: {}, warm_command: ["./gradlew", "dependencies"] };
    const { f, entry } = await cached({ config: { toolchain, repo: { ...config.repo } } });
    await f.submit();
    await f.step();
    expect(f.sandbox.commands.filter((c) => c === "./gradlew dependencies").length).toBe(2);
    expect(f.sandbox.commands.some((c) => c.startsWith("cp "))).toBe(false);
    expect(existsSync(entry)).toBe(false);
  });
});

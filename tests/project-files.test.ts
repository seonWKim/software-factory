// Project files (design 02-tasks, project files): the tree, read and save routes over a project's base folder. The path
// guard refuses `..`, an absolute path and a symlink inside the folder that points outside, for read and for write, and
// each refusal reads and writes nothing outside. Hidden names (.git, node_modules, .env*, key files) are skipped and
// refused; large and binary files open read-only and refuse a save.

import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import {
  MAX_EDIT_BYTES, PROJECT_FILE_READ_PATH, PROJECT_FILE_WRITE_PATH, PROJECT_TREE_PATH, isHiddenName, pathSegments,
} from "../src/ui/project-files.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ACTOR = "local:owner@example.com" as UserId;
const SECRET = "outside secret";
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A base folder with files and folders, a sibling folder outside it with a secret file, and a project set to the base. */
async function setup(opts: { actor?: UserId | null; folder?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-files-")));
  dirs.push(root);
  const base = join(root, "base");
  const outside = join(root, "outside");
  await mkdir(join(base, "src", "lib"), { recursive: true });
  await mkdir(join(base, "docs"));
  await mkdir(join(base, ".git"));
  await mkdir(join(base, "node_modules"));
  await mkdir(outside);
  await writeFile(join(base, "README.md"), "# hello\n");
  await writeFile(join(base, "a.txt"), "a\n");
  await writeFile(join(base, "src", "main.ts"), "export {};\n");
  await writeFile(join(base, ".env"), "TOKEN=x\n");
  await writeFile(join(base, "server.pem"), "key\n");
  await writeFile(join(base, ".git", "config"), "[core]\n");
  await writeFile(join(outside, "secret.txt"), SECRET);
  await symlink(join(outside, "secret.txt"), join(base, "out-link.txt"));
  await symlink(outside, join(base, "out-dir"));
  await symlink(join(base, "src"), join(base, "src-link"));
  const clock = new FakeClock(new Date("2026-11-19T12:00:00"));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: opts.actor === undefined ? ACTOR : opts.actor, source: "environment" as const, token },
  };
  await store.createProject({ id: "pj_home", name: "Home", created_by: ACTOR });
  if (opts.folder !== false) await store.setProjectFolder("pj_home", base);
  const post = async (url: string, body: unknown, over: Partial<UiRequest> = {}) => {
    const r = await respond(d, {
      method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token, body: JSON.stringify(body), ...over,
    });
    return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
  };
  const tree = (path: string) => post(PROJECT_TREE_PATH, { project: "home", path });
  const read = (path: string) => post(PROJECT_FILE_READ_PATH, { project: "home", path });
  const save = (path: string, text: string) => post(PROJECT_FILE_WRITE_PATH, { project: "home", path, text });
  return { d, store, base, outside, post, tree, read, save };
}

const OUT_PATHS = (outside: string) => [
  ["a .. segment", "../outside/secret.txt"],
  ["a .. segment after a folder", "src/../../outside/secret.txt"],
  ["an absolute path", join(outside, "secret.txt")],
  ["a symlink to a file outside", "out-link.txt"],
  ["a path through a symlink to a folder outside", "out-dir/secret.txt"],
] as const;

describe("the path guard", () => {
  it("takes a relative path's segments and refuses absolute, .., ., empty and hidden parts", () => {
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("src/lib/x.ts")).toEqual(["src", "lib", "x.ts"]);
    for (const bad of ["/etc/passwd", "../x", "a/../b", "./a", "a//b", "a/", ".git/config", "node_modules/x", ".env.local", "id_rsa", "a\\b", "a\0b", 7]) {
      expect(pathSegments(bad), String(bad)).toBeNull();
    }
    expect(isHiddenName(".env")).toBe(true);
    expect(isHiddenName("cert.pem")).toBe(true);
    expect(isHiddenName("README.md")).toBe(false);
  });

  it("refuses a read that leaves the base folder and answers none of the outside file", async () => {
    const s = await setup();
    for (const [what, path] of OUT_PATHS(s.outside)) {
      const r = await s.read(path);
      expect(r.status, what).toBe(400);
      expect(JSON.stringify(r.body), what).not.toContain(SECRET);
      expect(r.body.text, what).toBeUndefined();
    }
  });

  it("refuses a save that leaves the base folder and writes nothing outside", async () => {
    const s = await setup();
    for (const [what, path] of OUT_PATHS(s.outside)) {
      const r = await s.save(path, "overwritten");
      expect(r.status, what).toBe(400);
      expect(await readFile(join(s.outside, "secret.txt"), "utf8"), what).toBe(SECRET);
    }
  });

  it("refuses a tree read that leaves the base folder and lists nothing outside", async () => {
    const s = await setup();
    for (const path of ["..", "../outside", s.outside, "out-dir"]) {
      const r = await s.tree(path);
      expect(r.status, path).toBe(400);
      expect(r.body.entries, path).toBeUndefined();
    }
  });

  it("refuses hidden and key files by path, for read and for write", async () => {
    const s = await setup();
    for (const path of [".env", ".git/config", "server.pem"]) {
      expect((await s.read(path)).status, path).toBe(400);
      expect((await s.save(path, "x")).status, path).toBe(400);
    }
    expect(await readFile(join(s.base, ".env"), "utf8")).toBe("TOKEN=x\n");
  });
});

describe("POST /api/v1/projects/files/tree", () => {
  it("lists one level, folders first, skipping hidden folders, key files and links that leave the folder", async () => {
    const s = await setup();
    const r = await s.tree("");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      folder: s.base,
      path: "",
      entries: [
        { name: "docs", kind: "dir" }, { name: "src", kind: "dir" }, { name: "src-link", kind: "dir" },
        { name: "README.md", kind: "file" }, { name: "a.txt", kind: "file" },
      ],
    });
  });

  it("lists a folder's children on request", async () => {
    const s = await setup();
    expect((await s.tree("src")).body).toEqual({ folder: s.base, path: "src", entries: [{ name: "lib", kind: "dir" }, { name: "main.ts", kind: "file" }] });
    expect((await s.tree("src/lib")).body).toMatchObject({ entries: [] });
    expect((await s.tree("missing")).status).toBe(404);
    expect((await s.tree("a.txt")).status).toBe(400);
  });

  it("answers folder null and reads nothing for a project with no base folder", async () => {
    const s = await setup({ folder: false });
    expect(await s.tree("")).toEqual({ status: 200, body: { folder: null, path: "", entries: [] } });
    expect((await s.read("a.txt")).status).toBe(409);
    expect((await s.save("a.txt", "x")).status).toBe(409);
    expect(await readFile(join(s.base, "a.txt"), "utf8")).toBe("a\n");
  });

  it("refuses an unknown or archived project", async () => {
    const s = await setup();
    expect((await s.post(PROJECT_TREE_PATH, { project: "nope", path: "" })).status).toBe(404);
    expect((await s.post(PROJECT_TREE_PATH, { project: "Not A Slug", path: "" })).status).toBe(400);
    await s.store.archiveProject("pj_home");
    expect((await s.tree("")).status).toBe(400);
  });
});

describe("POST /api/v1/projects/files/read and /write", () => {
  it("reads a text file and saves it to disk", async () => {
    const s = await setup();
    expect(await s.read("src/main.ts")).toEqual({ status: 200, body: { path: "src/main.ts", text: "export {};\n", size: 11, read_only: null } });
    expect(await s.save("src/main.ts", "export const x = 1;\n")).toEqual({ status: 200, body: { path: "src/main.ts", size: 20 } });
    expect(await readFile(join(s.base, "src", "main.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await s.read("src-link/main.ts")).body).toMatchObject({ text: "export const x = 1;\n" });
  });

  it("creates nothing: a save to a missing file is 404 and a folder is refused", async () => {
    const s = await setup();
    expect((await s.save("new.txt", "x")).status).toBe(404);
    await expect(readFile(join(s.base, "new.txt"))).rejects.toThrow();
    expect((await s.save("src", "x")).status).toBe(400);
    expect((await s.read("")).status).toBe(400);
  });

  it("opens a file larger than about 1 MB read-only with its first part, and refuses a save to it", async () => {
    const s = await setup();
    const big = "x".repeat(MAX_EDIT_BYTES + 10);
    await writeFile(join(s.base, "big.log"), big);
    const r = await s.read("big.log");
    expect(r.body).toMatchObject({ size: MAX_EDIT_BYTES + 10, read_only: "large" });
    expect((r.body.text as string).length).toBe(MAX_EDIT_BYTES);
    expect((await s.save("big.log", "small")).status).toBe(409);
    expect(await readFile(join(s.base, "big.log"), "utf8")).toBe(big);
  });

  it("opens a binary file read-only with no text, and refuses a save to it", async () => {
    const s = await setup();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]);
    await writeFile(join(s.base, "logo.png"), bytes);
    expect((await s.read("logo.png")).body).toEqual({ path: "logo.png", text: null, size: 7, read_only: "binary" });
    expect((await s.save("logo.png", "text")).status).toBe(409);
    expect(await readFile(join(s.base, "logo.png"))).toEqual(bytes);
  });

  it("refuses a text larger than about 1 MB and a body without text, writing nothing", async () => {
    const s = await setup();
    expect((await s.save("a.txt", "y".repeat(MAX_EDIT_BYTES + 1))).status).toBe(413);
    expect((await s.post(PROJECT_FILE_WRITE_PATH, { project: "home", path: "a.txt", text: 5 })).status).toBe(400);
    expect((await s.post(PROJECT_FILE_WRITE_PATH, { project: "home", path: "a.txt" })).status).toBe(400);
    expect(await readFile(join(s.base, "a.txt"), "utf8")).toBe("a\n");
  });

  it("a save needs the commands actor (503 without it); the reads do not", async () => {
    const s = await setup({ actor: null });
    expect((await s.tree("")).status).toBe(200);
    expect((await s.read("a.txt")).status).toBe(200);
    expect((await s.save("a.txt", "changed")).status).toBe(503);
    expect(await readFile(join(s.base, "a.txt"), "utf8")).toBe("a\n");
  });
});

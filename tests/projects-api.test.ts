// The project file routes' guards and the set-folder route (design 02-tasks, project files). Every route (tree read, file
// read, file write, set folder) runs the task routes' guards in their order: Host, Origin, Content-Type, the page's CSRF
// token, body size, JSON; each refusal comes before any file or store access. The set-folder route stores the resolved real
// path, and refuses with nothing stored a relative, missing or file path, and an unknown or archived project.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UserId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { HealthMonitor } from "../src/ui/health.js";
import { PROJECT_FILE_READ_PATH, PROJECT_FILE_WRITE_PATH, PROJECT_FOLDER_PATH, PROJECT_TREE_PATH } from "../src/ui/project-files.js";
import { type ApiDeps, type UiRequest, respond } from "../src/ui/server.js";
import { newCsrfToken } from "../src/ui/settings-api.js";
import { newStore } from "./helpers/store.js";

const HOST = "127.0.0.1:4310";
const ACTOR = "local:owner@example.com" as UserId;
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function setup(opts: { actor?: UserId | null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sf-folder-")));
  dirs.push(root);
  await mkdir(join(root, "repo"));
  await writeFile(join(root, "repo", "a.txt"), "a\n");
  const clock = new FakeClock(new Date("2026-11-19T12:00:00"));
  const { store } = await newStore(clock);
  const token = newCsrfToken();
  const d: ApiDeps = {
    store, scanner: new PatternEgressScanner(async () => []), clock, lease_ms: 300_000, health: new HealthMonitor(async () => [], clock),
    commands: { actor: opts.actor === undefined ? ACTOR : opts.actor, source: "environment" as const, token },
  };
  await store.createProject({ id: "pj_home", name: "Home", created_by: ACTOR });
  await store.createProject({ id: "pj_old", name: "Old", created_by: ACTOR });
  await store.archiveProject("pj_old");
  const post = (url: string, body: unknown, over: Partial<UiRequest> = {}) =>
    respond(d, {
      method: "POST", url, host: HOST, origin: `http://${HOST}`, contentType: "application/json", csrfToken: token,
      body: typeof body === "string" ? body : JSON.stringify(body), ...over,
    });
  const folder = (project: string, path: unknown) => post(PROJECT_FOLDER_PATH, { project, folder: path });
  const stored = async () => (await store.getProject("pj_home"))!.base_folder;
  return { d, store, root, post, folder, stored };
}

describe("POST /api/v1/projects/folder", () => {
  it("stores the resolved real path and answers it", async () => {
    const s = await setup();
    await symlink(join(s.root, "repo"), join(s.root, "repo-link"));
    const r = await s.folder("home", join(s.root, "repo-link", ".", "..", "repo-link"));
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ project: "home", folder: join(s.root, "repo") });
    expect(await s.stored()).toBe(join(s.root, "repo"));
  });

  it("refuses a relative path, a missing path and a file, storing nothing", async () => {
    const s = await setup();
    for (const path of ["repo", "./repo", join(s.root, "missing"), join(s.root, "repo", "a.txt"), "", 42]) {
      const r = await s.folder("home", path);
      expect(r.status, String(path)).toBe(400);
    }
    expect(await s.stored()).toBeNull();
  });

  it("refuses an unknown or archived project, storing nothing", async () => {
    const s = await setup();
    expect((await s.folder("nope", join(s.root, "repo"))).status).toBe(404);
    expect((await s.folder("old", join(s.root, "repo"))).status).toBe(400);
    expect((await s.store.getProject("pj_old"))!.base_folder).toBeNull();
  });

  it("needs the commands actor: 503 without it, storing nothing", async () => {
    const s = await setup({ actor: null });
    expect((await s.folder("home", join(s.root, "repo"))).status).toBe(503);
    expect(await s.stored()).toBeNull();
  });

  it("refuses unknown and missing fields", async () => {
    const s = await setup();
    expect((await s.post(PROJECT_FOLDER_PATH, { project: "home" })).status).toBe(400);
    expect((await s.post(PROJECT_FOLDER_PATH, { project: "home", folder: s.root, extra: 1 })).status).toBe(400);
    expect(await s.stored()).toBeNull();
  });
});

describe("the project file routes' guards, in the task routes' order", () => {
  const ROUTES = [PROJECT_TREE_PATH, PROJECT_FILE_READ_PATH, PROJECT_FILE_WRITE_PATH, PROJECT_FOLDER_PATH];
  const status = (r: { status: number }) => r.status;

  it("each refusal comes in order: Host, Origin, Content-Type, CSRF token, JSON", async () => {
    const s = await setup();
    for (const url of ROUTES) {
      const body = { project: "home", path: "a.txt", folder: join(s.root, "repo"), text: "x" };
      // Each request breaks every later guard too, so the status names the first guard that runs.
      expect(status(await s.post(url, "not json", { host: "evil.example", origin: "https://evil.example", contentType: "text/plain", csrfToken: "stale" })), url).toBe(403);
      const origin = await s.post(url, "not json", { origin: "https://evil.example", contentType: "text/plain", csrfToken: "stale" });
      expect([status(origin), JSON.parse(origin.body).error], url).toEqual([403, "Origin must be this page's own origin."]);
      expect(status(await s.post(url, "not json", { contentType: "text/plain", csrfToken: "stale" })), url).toBe(415);
      const csrf = await s.post(url, "not json", { csrfToken: "stale" });
      expect([status(csrf), JSON.parse(csrf.body).code], url).toEqual([403, "stale_csrf"]);
      expect(status(await s.post(url, "not json", { bodyTooLarge: true })), url).toBe(413);
      expect(status(await s.post(url, "not json")), url).toBe(400);
      expect(status(await s.post(url, body, { csrfToken: undefined })), url).toBe(403);
    }
    expect(await s.stored()).toBeNull();
  });

  it("a GET to a project file route is not served: the reads are POSTs behind the CSRF token", async () => {
    const s = await setup();
    for (const url of ROUTES) {
      const r = await respond(s.d, { method: "GET", url: `${url}?project=home&path=a.txt`, host: HOST });
      expect(r.status, url).not.toBe(200);
      expect(r.body, url).not.toContain("a\\n");
    }
  });
});

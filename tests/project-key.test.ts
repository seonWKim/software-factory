import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROJECT_RETRY_MS, build, loadConfig, resolveProject, resolvedConfig, startupProject } from "../src/compose.js";
import { Controller } from "../src/core/controller.js";
import {
  UNKNOWN_PROJECT_LABEL, assertProjectKey, githubProjectKey, isLegacyProject, isProjectKey, projectKeyCursor, projectLabel, projectLabelCursor,
} from "../src/core/project.js";
import { readProjectLabel, saveProject, saveProjectLabel } from "../src/core/project-labels.js";
import { type FactoryConfig, cliUserConfig } from "../src/core/config.js";
import type { UserId } from "../src/core/types.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { PatternEgressScanner } from "../src/impl/egress/pattern-egress-scanner.js";
import { GitHubClient, GitHubError, webHost } from "../src/impl/github/github-client.js";
import { SqlFactoryStore } from "../src/impl/store/sql/sql-factory-store.js";
import { SqliteDriver } from "../src/impl/store/sqlite/sqlite-driver.js";
import { HealthMonitor } from "../src/ui/health.js";
import { projectKeyChecks } from "../src/ui/factory-status.js";
import { NO_FILTERS } from "../src/ui/filters.js";
import { type UiDeps, renderIndex, renderItem } from "../src/ui/pages.js";
import type { Secret } from "../src/interfaces/secret-store.js";
import { FakeAuth, FakeForge, FakeSource, PROJECT, alice, cleanScanner, config, issueRef, recordingLog, triageSpec } from "./helpers/fakes.js";
import { issue, system, w1 } from "./helpers/store.js";

// Projects are keyed by GitHub's repository node ID (design 2026-11-01): `github:github.com:<node id>`, with
// `github.com/owner/name` only as a label refreshed from GitHub at startup.

const NODE_ID = "R_kgDOrepo1";
const KEY = `github:github.com:${NODE_ID}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

/** A store over a driver the test can also query directly, to see the rows as written. */
async function rawStore(clock = new FakeClock()) {
  const driver = new SqliteDriver(":memory:");
  const store = new SqlFactoryStore(driver, clock);
  await store.migrate();
  const projects = async () => [
    ...(await driver.all("SELECT project FROM controller_work_items")).map((r) => String(r.project)),
    ...(await driver.all("SELECT project FROM controller_unreviewed_merges")).map((r) => String(r.project)),
  ];
  return { driver, store, clock, projects };
}

describe("ProjectRef: key and label", () => {
  it("the key is provider, host and node ID; the label is host/owner/name", () => {
    expect(githubProjectKey("github.com", NODE_ID)).toBe(KEY);
    expect(projectLabel("github.com", "o", "r")).toBe("github.com/o/r");
    expect(isProjectKey(KEY)).toBe(true);
    expect(isProjectKey("o/r")).toBe(false);
    expect(isLegacyProject("o/r")).toBe(true);
    expect(isLegacyProject(KEY)).toBe(false);
    expect(() => assertProjectKey("o/r")).toThrow(/project key/);
    expect(() => githubProjectKey("github.com", "bad id/x")).toThrow("not a repository node ID");
  });

  it("a cli_user that is no user ID is refused with a forge-neutral example", () => {
    expect(() => cliUserConfig({ cli_user: "alice" })).toThrow("(<provider>:<id>, e.g. local:<name>)");
  });

  it("the web host comes from the API base URL (github.com, or a GHES host)", () => {
    expect(webHost("https://api.github.com")).toBe("github.com");
    expect(webHost("https://ghe.example.com/api/v3")).toBe("ghe.example.com");
  });
});

describe("GitHubClient.repoIdentity", () => {
  const credentials = { token: async () => ({ reveal: () => "t" }) as unknown as Secret };

  it("returns the node ID and the path GitHub reports now (a renamed repo's new path)", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ node_id: NODE_ID, full_name: "new-owner/new-name" }), { status: 200 });
    });
    const id = await new GitHubClient(credentials).repoIdentity({ owner: "o", name: "r" });
    expect(urls).toEqual(["https://api.github.com/repos/o/r"]);
    expect(id).toEqual({ node_id: NODE_ID, owner: "new-owner", name: "new-name", host: "github.com" });
  });

  it("throws when GitHub's answer has no node_id", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ full_name: "o/r" }), { status: 200 }));
    await expect(new GitHubClient(credentials).repoIdentity({ owner: "o", name: "r" })).rejects.toThrow(/node_id/);
  });
});

describe("startup resolution", () => {
  it("resolves the configured repo to its key and current label", async () => {
    const ref = await resolveProject({ repoIdentity: async () => ({ node_id: NODE_ID, owner: "o", name: "r", host: "github.com" }) }, { owner: "o", name: "r" });
    expect(ref).toEqual({ key: KEY, label: "github.com/o/r" });
  });

  it("a repo that cannot be resolved fails with a message naming the configured repo and the reason", async () => {
    const failing = { repoIdentity: async () => Promise.reject(new Error("GitHub GET /repos/o/r → 404 Not Found")) };
    const err = await resolveProject(failing, { owner: "o", name: "r" }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain("o/r");
    expect(err?.message).toContain("404 Not Found");
  });

  /** A config dir like the checked-in one, on SQLite. */
  function root(): string {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const dir = mkdtempSync(join(tmpdir(), "sf-project-"));
    mkdirSync(join(dir, "prompts"));
    for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
    const file = { ...real, store: { type: "sqlite" }, plugins: { ...(real.plugins as object), awake: "none" }, state_dir: "state", worktrees_dir: "wt" };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify(file));
    writeFileSync(join(dir, "secrets.env"), "GITHUB_TOKEN=gh\n");
    vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets.env"));
    return dir;
  }

  it("build() on a first start stops with the configured repo and the reason when GitHub says 401 (bad credentials)", async () => {
    const loaded = await loadConfig(root());
    const { owner, name } = loaded.config.repo;
    const failing = { repoIdentity: async () => Promise.reject(new GitHubError(401, "GitHub GET /repos/o/r → 401 Bad credentials")) };
    const err = await build(loaded, { clock: new FakeClock(), repoLookup: failing }).then(() => null, (e: Error) => e);
    expect(err?.message).toContain(`${owner}/${name}`);
    expect(err?.message).toContain("Bad credentials");
  });

  /** What GitHub answers an installation whose hourly calls are used up (the 2026-11-07 startup crash). */
  const rateLimited = () => new GitHubError(403, "GitHub GET /repos/o/r → 403 API rate limit exceeded for installation ID 1");

  it("build() with the key stored starts while GitHub is rate limited, and the controller processes local commands", async () => {
    const dir = root();
    const file = JSON.parse(readFileSync(join(dir, "factory.config.json"), "utf8")) as { plugins: Record<string, unknown> };
    writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...file, plugins: { ...file.plugins, source: "local" } }));
    const loaded = await loadConfig(dir);
    // An earlier start resolved the key through GitHub and stored it.
    const first = await build(loaded, { clock: new FakeClock(), repoLookup: { repoIdentity: async (r) => ({ node_id: NODE_ID, ...r, host: "github.com" }) } });
    const { item } = await first.store.createWorkItem(
      { source: { type: "local", id: "local-1", link: "local:local-1" }, requester_id: "local:owner" as UserId, project: first.project.key, problem: "p", resources: [] },
      system,
    );
    await first.close();

    const lookups: string[] = [];
    const limited = { repoIdentity: async (r: { owner: string; name: string }) => (lookups.push(`${r.owner}/${r.name}`), Promise.reject(rateLimited())) };
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: limited });
    try {
      expect(built.project).toEqual({ key: KEY, label: `github.com/${loaded.config.repo.owner}/${loaded.config.repo.name}` });
      await built.store.appendCliCommand({ key: "k1", actor: "local:alice", command: "help", args: { item: item.id } });
      await built.controller.tickIntake();
      expect((await built.store.listItemMessages(item.id)).length).toBe(1);
    } finally {
      await built.close();
    }
    // One background read, its failure logged: the start did not wait on it.
    expect(lookups).toHaveLength(1);
  });

  it("build() on a first start waits and retries while GitHub is rate limited, then stores the key", async () => {
    const loaded = await loadConfig(root());
    const clock = new FakeClock();
    let calls = 0;
    const lookup = {
      repoIdentity: async (r: { owner: string; name: string }) => (++calls <= 2 ? Promise.reject(rateLimited()) : { node_id: NODE_ID, ...r, host: "github.com" }),
    };
    let built: Awaited<ReturnType<typeof build>> | null = null;
    const starting = build(loaded, { clock, repoLookup: lookup }).then((b) => (built = b));
    for (let i = 0; i < 100 && built === null; i++) {
      await new Promise((r) => setTimeout(r, 5));
      clock.advance(PROJECT_RETRY_MS * 20);
    }
    await starting;
    try {
      expect(calls).toBe(3);
      expect(built!.project.key).toBe(KEY);
      expect(await built!.store.getCursor(projectKeyCursor(loaded.config.repo))).toBe(KEY);
    } finally {
      await built!.close();
    }
  });

  it("build() on a first start stops when its signal aborts while GitHub is down", async () => {
    const loaded = await loadConfig(root());
    const stop = new AbortController();
    const failing = { repoIdentity: async () => Promise.reject(new GitHubError(503, "GitHub GET /repos/o/r → 503 Service Unavailable")) };
    const starting = build(loaded, { clock: new FakeClock(), repoLookup: failing, signal: stop.signal }).then(() => null, (e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20));
    stop.abort(new Error("stopped"));
    expect(await starting).toMatchObject({ message: "stopped" });
  });

  it("a store from before the key cursor finds the key by its label, with no GitHub answer, and stores the key", async () => {
    const f = await rawStore();
    await saveProjectLabel(f.store, { key: KEY, label: "github.com/o/r" });
    await f.store.createWorkItem({ ...issue(1), project: KEY }, system);
    const log = recordingLog();
    const { project, refreshed } = await startupProject({
      store: f.store, lookup: { repoIdentity: async () => Promise.reject(rateLimited()) }, repo: { owner: "o", name: "r" }, clock: f.clock, log,
    });
    await refreshed;
    expect(project).toEqual({ key: KEY, label: "github.com/o/r" });
    expect(await f.store.getCursor(projectKeyCursor({ owner: "o", name: "r" }))).toBe(KEY);
    expect(log.lines.filter((l) => l.level === "warn").map((l) => l.msg)).toEqual(["GitHub unreachable at startup; using the stored project key"]);
  });

  it("health warns while the configured repo's key is not stored, and not once it is", async () => {
    const f = await rawStore();
    const repo = { owner: "o", name: "r" };
    expect(await projectKeyChecks(f.store, repo)).toEqual([{ ok: false, warn: true, msg: expect.stringContaining("o/r not stored yet") }]);
    await saveProject(f.store, repo, { key: KEY, label: "github.com/o/r" });
    expect(await projectKeyChecks(f.store, repo)).toEqual([]);
  });

  it("build() uses the key for writes and stores the label refreshed from GitHub", async () => {
    const loaded = await loadConfig(root());
    const lookup = { repoIdentity: async () => ({ node_id: NODE_ID, owner: "renamed", name: "repo", host: "github.com" }) };
    const built = await build(loaded, { clock: new FakeClock(), repoLookup: lookup });
    try {
      expect(built.project).toEqual({ key: KEY, label: "github.com/renamed/repo" });
      expect(await built.store.getCursor(projectLabelCursor(KEY))).toBe("github.com/renamed/repo");
    } finally {
      await built.close();
    }
  });

  it("per-project settings written under owner/name apply under the key", () => {
    const loaded = { ...config, settings: { ...config.settings, projects: { "o/r": { max_attempts: 1 } } } };
    const c = resolvedConfig(loaded, PROJECT);
    expect(c.settings.projects).toEqual({ [PROJECT.key]: { max_attempts: 1 } });
  });
});

describe("writes use the key", () => {
  it("intake and a controller transition write only the key; the store refuses owner/name", async () => {
    const f = await rawStore();
    const source = new FakeSource();
    const forge = new FakeForge(source);
    const controller = new Controller({ store: f.store, source, forge, auth: new FakeAuth(), clock: f.clock, config, log: recordingLog(), scanner: cleanScanner });
    source.queue.push({ kind: "item_requested", source: issueRef(7), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    const run = (await f.store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
    await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: triageSpec } });
    await controller.tickRuns();
    // A merge of a PR no item knows writes an unreviewed_merges row.
    forge.queue.push({ kind: "change_merged", change_ref: "77", head_branch: "feature/x", merge_sha: "m77", merger: alice });
    await controller.tickIntake();

    expect(await f.projects()).toEqual([PROJECT.key, PROJECT.key]);
    expect((await f.store.listStateChanges((await f.store.listWorkItems(1))[0]!.id)).length).toBeGreaterThan(1);
    await expect(f.store.createWorkItem({ ...issue(8), project: "o/r" }, system)).rejects.toThrow(/project key/);
    await expect(f.store.recordUnreviewedMerge({ project: "o/r", change_ref: "1", merge_sha: "m", merger_id: null })).rejects.toThrow(/project key/);
    expect(await f.projects()).toEqual([PROJECT.key, PROJECT.key]);
  });

  it("after a rename (same node ID, new path) lookups by key still find the items created before it", async () => {
    const f = await rawStore();
    await saveProjectLabel(f.store, { key: KEY, label: "github.com/o/r" });
    const { item } = await f.store.createWorkItem({ ...issue(1), project: KEY }, system);
    await f.store.transition({ id: item.id, expected_version: 1, patch: { change_ref: "12", merge_sha: "m12" }, actor: system, reason: "x" });

    // Startup after the rename: GitHub returns the same node ID under the new path.
    const renamed = await resolveProject({ repoIdentity: async () => ({ node_id: NODE_ID, owner: "new-owner", name: "r2", host: "github.com" }) }, { owner: "o", name: "r" });
    expect(renamed.key).toBe(KEY);
    expect(await saveProjectLabel(f.store, renamed)).toBe(true);
    expect(await saveProjectLabel(f.store, renamed)).toBe(false); // a second startup changes nothing
    expect(await readProjectLabel(f.store, KEY)).toBe("github.com/new-owner/r2");

    expect((await f.store.getWorkItemByPr(renamed.key, "12"))?.id).toBe(item.id);
    expect((await f.store.getWorkItemByMergeSha(renamed.key, "m12"))?.id).toBe(item.id);
  });
});

describe("the label, never the key, is shown", () => {
  function uiDeps(store: SqlFactoryStore, clock: FakeClock): UiDeps {
    return {
      store,
      scanner: new PatternEgressScanner(async () => []),
      clock,
      lease_ms: 60_000,
      health: new HealthMonitor(async () => [{ ok: true, msg: "ok" }], clock),
    };
  }

  it("the dashboard shows the project's label and links PRs through it; the raw key never appears", async () => {
    const f = await rawStore();
    await saveProjectLabel(f.store, { key: KEY, label: "github.com/o/r" });
    const { item } = await f.store.createWorkItem({ ...issue(1), project: KEY }, system);
    await f.store.transition({ id: item.id, expected_version: 1, patch: { change_ref: "42", stage: "REVIEW" }, actor: system, reason: "x" });

    const index = await renderIndex(uiDeps(f.store, f.clock), { ...NO_FILTERS });
    const page = (await renderItem(uiDeps(f.store, f.clock), item.id))!;
    for (const html of [index, page]) {
      expect(html).toContain("github.com/o/r");
      expect(html).toContain(`href="https://github.com/o/r/pull/42"`);
      expect(html).not.toContain(KEY);
      expect(html).not.toContain(NODE_ID);
    }
  });

  it("a project with no stored label shows a fixed text, not the key", async () => {
    const f = await rawStore();
    const { item } = await f.store.createWorkItem({ ...issue(1), project: KEY }, system);
    await f.store.transition({ id: item.id, expected_version: 1, patch: { change_ref: "42" }, actor: system, reason: "x" });
    const page = (await renderItem(uiDeps(f.store, f.clock), item.id))!;
    expect(page).toContain(UNKNOWN_PROJECT_LABEL);
    expect(page).toContain("PR #42");
    expect(page).not.toContain(NODE_ID);
  });

  it("comments and log lines name the project by its label, never the key", async () => {
    const f = await rawStore();
    const log = recordingLog();
    const source = new FakeSource();
    const forge = new FakeForge(source);
    const cfg: FactoryConfig = { ...config, project: { key: KEY, label: "github.com/o/r" } };
    const controller = new Controller({ store: f.store, source, forge, auth: new FakeAuth(), clock: f.clock, config: cfg, log, scanner: cleanScanner });

    // Startup line, then intake, triage, a rejection and an unreviewed merge: every path that comments or logs.
    const stop = new AbortController();
    stop.abort();
    await controller.run(stop.signal);
    source.queue.push({ kind: "item_requested", source: issueRef(7), requester: alice, title: "t", body: "b" });
    await controller.tickIntake();
    const run = (await f.store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: 60_000 }))!;
    await f.store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec: triageSpec } });
    await controller.tickRuns();
    forge.queue.push({ kind: "change_merged", change_ref: "77", head_branch: "feature/x", merge_sha: "m77", merger: alice });
    await controller.tickIntake();

    expect(log.lines.find((l) => l.msg === "controller started")?.fields).toEqual({ project: "github.com/o/r" });
    expect(source.comments.length).toBeGreaterThan(0);
    const text = JSON.stringify({ logs: log.lines, comments: source.comments.map((c) => [c.source, c.body, c.marker]) });
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(NODE_ID);
  });
});

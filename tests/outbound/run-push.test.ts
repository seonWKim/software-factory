import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitHubForge } from "../../src/impl/github/github-forge.js";
import type { Secret } from "../../src/interfaces/secret-store.js";
import { ControllerRole } from "../../src/runtime/roles/controller-role.js";
import { FakeAuth, cleanScanner, pipeline, silent } from "../helpers/fakes.js";
import { issue, system } from "../helpers/store.js";

// RFC 0015 M7, a run's push and PR: the implement run's last step stores its branch in the factory repo and records
// keyed push and pr intents; outbound pushes and opens the PR; the PR delivery puts the PR on the item and queues
// the review. These fail if a push or PR bypasses outbound, runs twice, or the item does not advance.

type F = Awaited<ReturnType<typeof pipeline>>;

async function actions(f: F) {
  const rows = await f.store.db.all("SELECT action, target, intent_key, delivered_at, delivered_ref FROM outbound_actions WHERE action IN ('push', 'pr') ORDER BY seq");
  return rows.map((r) => ({
    action: String(r.action), destination: (JSON.parse(String(r.target)) as { type: string; id: string }),
    key: String(r.intent_key), delivered: r.delivered_at !== null, ref: (r.delivered_ref as string | null) ?? null,
  }));
}

describe("an implement run's push and PR leave through outbound", () => {
  it("the worker writes nothing to the forge; outbound pushes the stored sha, then opens the PR, and the item goes to review", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    await f.step();
    const branch = `factory/${it0.id}`;
    // The worker's only branch write is the store in the factory repo; every forge write is outbound's (no ctx).
    expect(f.broker.stores.map((c) => (c.args as { branch: string }).branch)).toEqual([branch]);
    expect(f.broker.calls.filter((c) => c.ctx !== undefined).map((c) => c.name)).toEqual([]);
    const [push, pr] = await actions(f);
    expect(push).toMatchObject({ action: "push", destination: { type: "git", id: `w1:${branch}` }, delivered: true });
    expect(pr).toMatchObject({ action: "pr", destination: { type: "git", id: `w1:${branch}` }, delivered: true, ref: "42" });
    expect(f.forge.pushes).toEqual([{ repo: f.config.repo.path, branch, sha: expect.stringMatching(/^[0-9a-f]{40}$/) }]);
    expect(push!.key).toBe(`push:${branch}:${f.forge.pushes[0]!.sha}`);
    expect(f.forge.prOpens.map((p) => p.branch)).toEqual([branch]);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42", change_url: f.forge.prRef(42).link });
    expect((await f.runs(it0, "review")).length).toBeGreaterThan(0);
  });

  it("a failed push holds its destination: no PR until it is delivered, no failed run and no claim pause; the retry advances the item", async () => {
    const f = await pipeline();
    f.forge.pushErrors = [new Error("forge_auth: The requested URL returned error: 403")];
    const it0 = await f.submit();
    await f.step();
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "outbound", blocked_reason: "pr_pending" });
    expect((await f.runs(it0, "implement")).map((r) => r.outcome?.status)).toEqual(["succeeded"]);
    expect(f.forge.pushes).toHaveLength(1);
    expect(f.forge.prOpens).toEqual([]);
    expect(await f.store.getClaimPause("forge_auth")).toBeNull();

    // Before its backoff ends nothing is sent again.
    await f.controller.tickOutbox();
    expect(f.forge.pushes).toHaveLength(1);
    f.clock.advance(f.config.retry_max_ms);
    await f.controller.tickOutbox();
    expect(f.forge.pushes).toHaveLength(2);
    expect(f.forge.prOpens).toHaveLength(1);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42", blocked_on: "none" });
  });

  it("a PR outbound delivered before the run's result was applied goes on the item with the result", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    await f.w1.tick(); // triage
    await f.controller.tickRuns();
    await f.w1.tick(); // implement: its intents are stored, its result not applied yet
    // Outbound (another tick, another replica) delivers the push and the PR first.
    await f.store.db.run("UPDATE outbound_actions SET delivered_at = ?, outcome = 'sent', delivered_ref = CASE WHEN action = 'pr' THEN '42' ELSE NULL END WHERE action IN ('push', 'pr')", [
      f.clock.now().toISOString(),
    ]);
    await f.controller.tickRuns();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42", blocked_on: "none" });
  });

  it("a PR delivered while the run's result is decided (its handler found the item not waiting yet) still goes on the item", async () => {
    const f = await pipeline();
    const it0 = await f.submit();
    await f.w1.tick(); // triage
    await f.controller.tickRuns();
    await f.w1.tick(); // implement: its intents are stored, its result not applied yet
    const results = await f.controller.unit("run-results");
    const k = (results as unknown as { c: { k: { actionByKey(key: string): Promise<{ delivered_ref: string | null } | null> } } }).c.k;
    const read = k.actionByKey.bind(k);
    let raced = false;
    k.actionByKey = async (key) => {
      const seen = await read(key);
      if (!raced && key.startsWith("pr:")) {
        raced = true;
        // Outbound delivers the PR now, and its DeliveryCompleted handler runs before the result commits the wait.
        await f.store.db.run("UPDATE outbound_actions SET delivered_at = ?, outcome = 'sent', delivered_ref = CASE WHEN action = 'pr' THEN '42' ELSE NULL END WHERE action IN ('push', 'pr')", [
          f.clock.now().toISOString(),
        ]);
        await results.prDelivered(it0.id, "42", null);
        expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
      }
      return seen;
    };
    await f.controller.tickRuns();
    expect(raced).toBe(true);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42", blocked_on: "none" });
  });

  it("a host's push waits for that host's outbound: another host's replica on a shared store leaves it", async () => {
    const f = await pipeline();
    const other = new ControllerRole({
      store: f.store, source: f.source, forge: f.forge, auth: new FakeAuth(), clock: f.clock, config: f.config, log: silent,
      scanner: cleanScanner, replica_id: "otherhost:1", git_host: { id: "otherhost", flush_all: false },
    });
    const it0 = await f.submit();
    await f.w1.tick();
    await other.tickRuns();
    await f.w1.tick();
    await other.tickRuns();
    expect(await f.item(it0)).toMatchObject({ blocked_on: "outbound", blocked_reason: "pr_pending" });
    expect(f.forge.pushes).toEqual([]);
    // A controller that flushes every host's (solo; here one with no git host) sends it.
    await f.controller.tickOutbox();
    expect(f.forge.pushes).toHaveLength(1);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", change_ref: "42" });
  });
});

describe("an update or resolve run's push leaves through outbound", () => {
  /** An item with PR 42 and one queued resolve run, as after `/resolve`. */
  async function resolving(f: F) {
    const { item } = await f.store.createWorkItem(issue(7), system);
    const moved = await f.store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test_setup",
      patch: { stage: "RUNNING", change_ref: "42", allowed_paths: ["src/"] },
      enqueue: { kind: "resolve", idempotency_key: "resolve-1" },
    });
    if (!moved.ok) throw new Error("setup");
    return moved.item;
  }

  it("the review of a resolve run's head waits for its push: a held push queues no review until it is delivered", async () => {
    const f = await pipeline();
    f.forge.pushErrors = [new Error("network_unavailable: could not reach github.com")];
    const it0 = await resolving(f);
    await f.w1.tick();
    await f.controller.tickRuns();
    const [run] = await f.runs(it0, "resolve");
    expect(run!.outcome).toMatchObject({ status: "succeeded", data: { result: "pushed", push_intent: expect.stringMatching(/^push:/) } });
    // The worker stored the merge; outbound's push failed, so the item waits and no review reads the old head.
    expect(f.broker.calls.filter((c) => c.ctx !== undefined)).toEqual([]);
    expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "outbound", blocked_reason: "push_pending" });
    expect(await f.runs(it0, "review")).toEqual([]);

    f.clock.advance(f.config.retry_max_ms);
    await f.controller.tickOutbox();
    expect(f.forge.pushes).toHaveLength(2);
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "none" });
    expect((await f.runs(it0, "review")).map((r) => r.idempotency_key)).toEqual([`${it0.id}:review:after-resolve:${run!.id}`]);
    // Delivered again (a redelivery) or applied again: one review.
    await f.controller.tickOutbox();
    await f.controller.applyRun(run!);
    expect(await f.runs(it0, "review")).toHaveLength(1);
  });

  it("a push delivered before the resolve result is applied queues the review with the result", async () => {
    const f = await pipeline();
    const it0 = await resolving(f);
    await f.w1.tick();
    await f.store.db.run("UPDATE outbound_actions SET delivered_at = ?, outcome = 'sent' WHERE action = 'push'", [f.clock.now().toISOString()]);
    await f.controller.tickRuns();
    expect(await f.item(it0)).toMatchObject({ stage: "REVIEW", blocked_on: "none" });
    expect(await f.runs(it0, "review")).toHaveLength(1);
  });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
}

describe("GitHubForge.pushBranch from the factory repo", { timeout: 30_000 }, () => {
  function setup() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-push-")));
    const origin = join(root, "origin.git");
    const repo = join(root, "repo");
    git(root, "init", "--quiet", "--bare", "-b", "main", origin);
    git(root, "clone", "--quiet", origin, repo);
    git(repo, "config", "user.email", "t@example.com");
    git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "--quiet", "-m", "a");
    const sha = git(repo, "rev-parse", "HEAD");
    // The run's last step left the commit on the staging ref only.
    git(repo, "update-ref", "refs/factory/outbound/factory/wi_1", sha);
    git(repo, "checkout", "--quiet", "--detach");
    git(repo, "branch", "-D", "main");
    const token = { token: async () => ({ reveal: () => "not-a-real-token" }) as unknown as Secret };
    const forge = new GitHubForge({} as never, { owner: "o", name: "r" }, "factory/", "main", {} as never, null, token);
    return { origin, repo, sha, forge };
  }

  it("pushes the sha to the branch, then reconciles: a branch already at the sha is not pushed again", async () => {
    const s = setup();
    expect(await s.forge.pushBranch({ repo: s.repo, branch: "factory/wi_1", sha: s.sha })).toBe("pushed");
    expect(git(s.origin, "rev-parse", "refs/heads/factory/wi_1")).toBe(s.sha);
    expect(await s.forge.pushBranch({ repo: s.repo, branch: "factory/wi_1", sha: s.sha })).toBe("already");
  });

  it("refuses a branch outside the prefix and a sha that is not one, and pushes nothing", async () => {
    const s = setup();
    await expect(s.forge.pushBranch({ repo: s.repo, branch: "main", sha: s.sha })).rejects.toThrow(/^push_failed: refusing/);
    await expect(s.forge.pushBranch({ repo: s.repo, branch: "factory/wi_1", sha: "HEAD" })).rejects.toThrow(/^push_failed: not a commit sha/);
    expect(git(s.origin, "for-each-ref")).toBe("");
  });
});

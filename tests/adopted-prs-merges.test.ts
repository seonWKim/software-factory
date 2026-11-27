import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { GitHubForge } from "../src/impl/github/github-forge.js";
import type { GitHubCredentials } from "../src/interfaces/github-credentials.js";
import { FakeAuth } from "./helpers/fakes/runner.js";
import { alice, cleanScanner, config, recordingLog } from "./helpers/fakes/config.js";
import { newStore } from "./helpers/store.js";
import { factory, prOpen, prRef } from "./helpers/classifier.js";

// Merges of pull requests the factory did not open are unreviewed merges (design 2026-11-01).

describe("merges of pull requests the factory did not open", () => {
  it("an adopted PR's merge closes its item as CLOSED / completed with the merger as approver of record", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    await f.work();
    await f.poll({ kind: "change_merged", change_ref: "50", head_branch: "feature/x", merge_sha: "m50", merger: alice });
    const it = (await f.item(50))!;
    expect(it).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m50" });
    const last = (await f.store.listStateChanges(it.id)).at(-1)!;
    expect(last).toMatchObject({ reason: "pr_merged", actor: { kind: "user", id: "github:1" } });
    expect(await f.store.listUnreviewedMerges(10)).toEqual([]);
    expect(f.source.statusLabels(prRef(50))).toEqual(["done"]);
  });

  it("an adopted PR closed without a merge closes its item as rejected", async () => {
    const f = await factory();
    await f.poll(prOpen(50));
    await f.poll({ kind: "change_closed", change_ref: "50", head_branch: "feature/x" });
    expect((await f.item(50))!).toMatchObject({ stage: "CLOSED", close_reason: "rejected" });
  });

  it("a merged PR that was never adopted (a fork, or merged before any poll) writes one unreviewed merge and no item", async () => {
    const f = await factory();
    await f.poll(
      { kind: "change_merged", change_ref: "60", head_branch: "feature/x", merge_sha: "m60", merger: alice, fork: true },
      { kind: "change_merged", change_ref: "61", head_branch: "patch-1", merge_sha: "m61", merger: null, title: "Config: 1 worker" },
    );
    await f.poll({ kind: "change_merged", change_ref: "61", head_branch: "patch-1", merge_sha: "m61", merger: null });
    expect(await f.store.listWorkItems(10)).toEqual([]);
    const rows = await f.store.listUnreviewedMerges(10);
    // The PR's title as the forge gave it, kept for the Tasks page's merge rows; none given: null.
    expect(rows.map((r) => [r.change_ref, r.merge_sha, r.merger_id, r.title]).sort()).toEqual([["60", "m60", "github:1", null], ["61", "m61", null, "Config: 1 worker"]]);
  });

  it("a PR closed without a merge and with no item records nothing", async () => {
    const f = await factory();
    await f.poll({ kind: "change_closed", change_ref: "62", head_branch: "feature/x", fork: true });
    expect(await f.store.listWorkItems(10)).toEqual([]);
    expect(await f.store.listUnreviewedMerges(10)).toEqual([]);
  });
});

describe("the first start on a repository with history (design §5, Merges)", () => {
  /** Closed PRs on one page and the merger of each; counts the single-PR reads; every other list is empty. */
  class Repo extends GitHubClient {
    closed: unknown[] = [];
    prReads = 0;
    constructor() {
      super({} as GitHubCredentials, "http://unused");
    }
    override async request<T>(method: string, path: string): Promise<T> {
      if (method !== "GET") return {} as T;
      if (path.startsWith("/repos/o/r/pulls?state=closed")) return (path.includes("page=1") ? this.closed : []) as T;
      if (/^\/repos\/o\/r\/pulls\/\d+$/.test(path)) {
        this.prReads++;
        return { merged_by: { id: 2, login: "bob", type: "User" } } as T;
      }
      return [] as T;
    }
  }
  const merged = (n: number, at: string) => ({
    number: n, merged_at: at, merge_commit_sha: `m${n}`, updated_at: at,
    head: { ref: `feature/${n}`, sha: `h${n}`, repo: { full_name: "o/r" } }, base: { ref: "main", sha: "b" },
  });

  async function start() {
    const clock = new FakeClock("2026-11-07T00:00:00Z");
    const { store } = await newStore(clock);
    const log = recordingLog();
    const repo = new Repo();
    const ctx = { clock, history_since: null, log };
    const source = new GitHubIssueSource(repo, { owner: "o", name: "r" }, "factory", "factory/", "main", undefined, store);
    const forge = new GitHubForge(repo, { owner: "o", name: "r" }, "factory/", "main", source, ctx);
    const controller = new ControllerRole({ store, source, forge, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
    const unreviewed = () => log.lines.filter((l) => l.msg === "unreviewed merge");
    return { clock, store, repo, controller, unreviewed };
  }

  it("50 old merged PRs: no unreviewed merge warning, no row, no per-PR read", async () => {
    const f = await start();
    f.repo.closed = Array.from({ length: 50 }, (_, i) => merged(100 + i, `2026-10-01T00:${String(i).padStart(2, "0")}:00Z`));
    await f.controller.tickIntake();
    expect(f.unreviewed()).toEqual([]);
    expect(await f.store.listUnreviewedMerges(100)).toEqual([]);
    expect(f.repo.prReads).toBe(0);
  });

  it("a PR merged without review after the first start is recorded as an unreviewed merge with one warning", async () => {
    const f = await start();
    f.repo.closed = [merged(1, "2026-10-01T00:00:00Z")];
    await f.controller.tickIntake();
    f.clock.advance(60_000);
    f.repo.closed = [merged(2, "2026-11-07T00:00:30Z"), merged(1, "2026-10-01T00:00:00Z")];
    await f.controller.tickIntake();
    await f.controller.tickIntake();
    expect((await f.store.listUnreviewedMerges(100)).map((r) => [r.change_ref, r.merge_sha])).toEqual([["2", "m2"]]);
    expect(f.unreviewed().map((l) => l.fields?.change_ref)).toEqual(["2"]);
  });
});

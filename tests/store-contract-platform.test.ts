import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { HostSleep, RunId, RunKind, Timestamp, UserId, WorkItemId } from "../src/core/types.js";
import { DEFAULT_COORDINATION } from "../src/core/coordination.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { FactoryStore, ForgeBudget, NewAlert, WorkerProcessReport } from "../src/interfaces/factory-store.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { recordAction } from "../src/outbound/intents.js";
import { type SqlDriver } from "../src/state/index.js";
import { type NewTask, ProjectRefused, localDate } from "../src/core/tasks.js";
import { newStore, human, issue, system, w1, w2, PROJECT_KEY, OTHER_PROJECT_KEY } from "./helpers/store.js";

const LEASE = 60_000;
/** A project label as the cursor `project_label:<key>` stores it, and the PR link the store writes as change_url. */
const LABEL = "github.com/o/r";
const prUrl = (label: string, n: number) => `https://${label}/pull/${n}`;

describe.each([{ name: "sqlite", make: newStore }])("FactoryStore contract: $name", ({ name, make: makeBackend }) => {
  const make = makeBackend;
  describe("source inbox", () => {
    const slack = "slack_thread" as const;
    const ev = (n: number): SourceEvent => ({
      kind: "item_requested",
      source: { type: slack, id: `C1/${n}`, link: `https://slack.example/C1/${n}` },
      requester: { provider: "slack", subject: "U1" },
      title: `t${n}`,
      body: `b${n}`,
    });
    async function leased(store: FactoryStore): Promise<number> {
      const r = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!r.ok) throw new Error(r.reason);
      return r.lease.token;
    }

    it("appends in sequence order and reads back after a cursor", async () => {
      const { store } = await make();
      const token = await leased(store);
      const seqs: number[] = [];
      for (const n of [1, 2, 3]) {
        const r = await store.appendInbox({ source_type: slack, dedupe_key: `k${n}`, event: ev(n), lease_token: token });
        if (!r.ok) throw new Error(r.reason);
        expect(r.duplicate).toBe(false);
        seqs.push(r.row.seq);
      }
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(3);

      const all = await store.listInboxAfter(slack, 0, 10);
      expect(all.map((r) => r.dedupe_key)).toEqual(["k1", "k2", "k3"]);
      expect(all[0]).toMatchObject({ seq: seqs[0], source_type: slack, event: ev(1) });
      expect(typeof all[0]!.received_at).toBe("string");
      expect((await store.listInboxAfter(slack, seqs[0]!, 10)).map((r) => r.dedupe_key)).toEqual(["k2", "k3"]);
      expect((await store.listInboxAfter(slack, 0, 2)).map((r) => r.dedupe_key)).toEqual(["k1", "k2"]);
      expect(await store.listInboxAfter("github_issue", 0, 10)).toEqual([]);
    });

    it("a duplicate dedupe_key is a no-op that reports the stored row", async () => {
      const { store } = await make();
      const token = await leased(store);
      const first = await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: token });
      const again = await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(2), lease_token: token });
      expect(again).toEqual({ ok: true, duplicate: true, row: first.ok && first.row });
      expect(await store.listInboxAfter(slack, 0, 10)).toHaveLength(1);
    });

    it("refuses the write without the listener lease, or with a stale token", async () => {
      const { store, clock } = await make();
      expect(await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: 1 })).toEqual({
        ok: false, reason: "lease_lost",
      });
      const old = await leased(store);
      clock.advance(LEASE + 1);
      const b = await store.acquireListenerLease(slack, "replica-b", LEASE);
      if (!b.ok) throw new Error(b.reason);
      expect(await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: old })).toEqual({
        ok: false, reason: "lease_lost",
      });
      expect(await store.listInboxAfter(slack, 0, 10)).toEqual([]);
      expect((await store.appendInbox({ source_type: slack, dedupe_key: "k1", event: ev(1), lease_token: b.lease.token })).ok).toBe(true);
    });
  });

  describe("listener lease", () => {
    const slack = "slack_thread" as const;

    it("one owner at a time; the token goes up on every take", async () => {
      const { store } = await make();
      const [a, b] = await Promise.all([
        store.acquireListenerLease(slack, "replica-a", LEASE),
        store.acquireListenerLease(slack, "replica-b", LEASE),
      ]);
      const won = [a, b].filter((r) => r.ok);
      expect(won).toHaveLength(1);
      const lost = [a, b].find((r) => !r.ok)!;
      expect(lost).toMatchObject({ ok: false, reason: "held", holder: { token: 1 } });
      // Another source type has its own lease.
      expect((await store.acquireListenerLease("github_issue", "replica-b", LEASE)).ok).toBe(true);
    });

    it("renew extends the lease while the token is current, even past expiry", async () => {
      const { store, clock } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE - 1);
      const r = await store.renewListenerLease(slack, a.lease.token, LEASE);
      expect(r).toMatchObject({ ok: true, lease: { owner: "replica-a", token: a.lease.token } });
      expect(r.ok && r.lease.expires_at).toBe(new Date(clock.now().getTime() + LEASE).toISOString());
      clock.advance(LEASE - 1);
      expect((await store.acquireListenerLease(slack, "replica-b", LEASE)).ok).toBe(false);
      // Expired but not taken: the holder can still renew (host sleep), as with run leases.
      clock.advance(10);
      expect((await store.renewListenerLease(slack, a.lease.token, LEASE)).ok).toBe(true);
    });

    it("another owner takes over after expiry; the old token is refused", async () => {
      const { store, clock } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE);
      const b = await store.acquireListenerLease(slack, "replica-b", LEASE);
      expect(b).toMatchObject({ ok: true, lease: { owner: "replica-b", token: a.lease.token + 1 } });
      expect(await store.renewListenerLease(slack, a.lease.token, LEASE)).toMatchObject({
        ok: false, reason: "lease_lost", holder: { owner: "replica-b" },
      });
      // A stale release changes nothing.
      await store.releaseListenerLease(slack, a.lease.token);
      expect((await store.acquireListenerLease(slack, "replica-c", LEASE)).ok).toBe(false);
    });

    it("release lets another owner take the lease at once", async () => {
      const { store } = await make();
      const a = await store.acquireListenerLease(slack, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      await store.releaseListenerLease(slack, a.lease.token);
      expect(await store.acquireListenerLease(slack, "replica-b", LEASE)).toMatchObject({ ok: true, lease: { owner: "replica-b" } });
    });
  });

  describe("sync leases (migration 39): one sync per project, keyed by name", () => {
    const NAME = `sync:github_issue:${PROJECT_KEY}`;

    it("one owner at a time; the holder's own take keeps its token; another name is its own lease", async () => {
      const { store } = await make();
      const [a, b] = await Promise.all([store.acquireSyncLease(NAME, "replica-a", LEASE), store.acquireSyncLease(NAME, "replica-b", LEASE)]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, reason: "held", holder: { token: 1 } });
      const winner = (a.ok ? a : b) as Extract<typeof a, { ok: true }>;
      // The holder taking it again (a restart with the same id, a second controller in one process) keeps the token.
      expect(await store.acquireSyncLease(NAME, winner.lease.owner, LEASE)).toMatchObject({ ok: true, lease: { token: 1 } });
      expect((await store.acquireSyncLease(`sync:github_issue:${OTHER_PROJECT_KEY}`, "replica-b", LEASE)).ok).toBe(true);
      expect(await store.getSyncLease(NAME)).toMatchObject({ name: NAME, owner: winner.lease.owner, token: 1 });
      expect(await store.getSyncLease("sync:none")).toBeNull();
    });

    it("another owner takes over after expiry with token + 1; the old token's renew, release and fenced writes are refused", async () => {
      const { store, clock } = await make();
      const a = await store.acquireSyncLease(NAME, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE - 1);
      expect((await store.acquireSyncLease(NAME, "replica-b", LEASE)).ok).toBe(false);
      // Renew extends it while the token is current, even past expiry (host sleep), as with the listener lease.
      clock.advance(LEASE);
      expect((await store.renewSyncLease(NAME, a.lease.token, LEASE)).ok).toBe(true);
      clock.advance(LEASE);
      const b = await store.acquireSyncLease(NAME, "replica-b", LEASE);
      expect(b).toMatchObject({ ok: true, lease: { owner: "replica-b", token: a.lease.token + 1 } });
      expect(await store.renewSyncLease(NAME, a.lease.token, LEASE)).toMatchObject({ ok: false, reason: "lease_lost", holder: { owner: "replica-b" } });
      await store.releaseSyncLease(NAME, a.lease.token);
      expect((await store.acquireSyncLease(NAME, "replica-c", LEASE)).ok).toBe(false);
    });

    it("release lets another owner take it at once", async () => {
      const { store } = await make();
      const a = await store.acquireSyncLease(NAME, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      await store.releaseSyncLease(NAME, a.lease.token);
      expect(await store.acquireSyncLease(NAME, "replica-b", LEASE)).toMatchObject({ ok: true, lease: { owner: "replica-b" } });
    });

    it("a delivery claim fenced with a stale token claims nothing; the current token claims it once", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      const target = issue(1).source;
      await store.recordItemMessage({ work_item_id: item.id, marker: "<!-- m -->", body: "b", delivery: { source_type: "github_issue", target } });
      const [row] = await store.listPendingDeliveries(["github_issue"], 10);
      const a = await store.acquireSyncLease(NAME, "replica-a", LEASE);
      if (!a.ok) throw new Error(a.reason);
      clock.advance(LEASE);
      const b = await store.acquireSyncLease(NAME, "replica-b", LEASE);
      if (!b.ok) throw new Error(b.reason);
      expect(await store.claimDelivery(row!.seq, LEASE, { name: NAME, token: a.lease.token })).toBeNull();
      expect(await store.claimDelivery(row!.seq, LEASE, { name: NAME, token: b.lease.token })).not.toBeNull();
      expect(await store.claimDelivery(row!.seq, LEASE, { name: NAME, token: b.lease.token })).toBeNull();
    });
  });

  describe("forge budget (migration 39): a newer reading wins", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 8, 9, 0, s)).toISOString() as Timestamp;
    const reading = (remaining: number, updated_at: Timestamp, project = PROJECT_KEY): ForgeBudget => ({
      project, plugin: "github", remaining, limit: 5000, reset_at: at(59), updated_at,
    });

    it("stores the first reading; a newer one replaces it; an older or equal one changes nothing", async () => {
      const { store } = await make();
      expect(await store.getForgeBudget(PROJECT_KEY, "github")).toBeNull();
      expect(await store.putForgeBudget(reading(4000, at(1)))).toBe(true);
      expect(await store.putForgeBudget(reading(812, at(2)))).toBe(true);
      expect(await store.putForgeBudget(reading(4500, at(1)))).toBe(false);
      // The same write again (a handler run twice) writes nothing new.
      expect(await store.putForgeBudget(reading(812, at(2)))).toBe(false);
      expect(await store.getForgeBudget(PROJECT_KEY, "github")).toEqual(reading(812, at(2)));
      // Each project and plugin is its own row.
      expect(await store.putForgeBudget(reading(10, at(0), OTHER_PROJECT_KEY))).toBe(true);
      expect(await store.getForgeBudget(PROJECT_KEY, "github")).toEqual(reading(812, at(2)));
      expect(await store.getForgeBudget(PROJECT_KEY, "other")).toBeNull();
    });
  });

  describe("posted comment reads (issue #524): by comment ID, and in a time window", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const post = (store: FactoryStore, source_id: string, marker: string, comment_id: string) =>
      store.recordPostedComment({ source_id, marker, comment_id, url: `https://github.com/${source_id.replace("#", "/pull/")}#issuecomment-${comment_id}`, body: "b" });

    it("lists the posted records of one comment ID, oldest first; failed-only rows are left out", async () => {
      const { store, clock } = await make();
      await post(store, "slack:T1:C1:1.1", "m1", "2.2");
      clock.advance(1000);
      await post(store, "slack:T1:C1:1.1", "slack:done:2.2:", "2.2");
      await post(store, "slack:T1:C1:1.1", "m3", "3.3");
      await store.recordCommentFailure("slack:T1:C1:1.1", "m4", 1, 1000);
      const rows = await store.listPostedCommentsById("2.2");
      expect(rows.map((r) => [r.marker, r.source_id])).toEqual([["m1", "slack:T1:C1:1.1"], ["slack:done:2.2:", "slack:T1:C1:1.1"]]);
      expect(await store.listPostedCommentsById("9.9")).toEqual([]);
      expect(await store.listPostedCommentsById("")).toEqual([]);
    });

    it("lists the comments posted on one source prefix within the window, oldest first", async () => {
      const { store, clock } = await make();
      await post(store, "o/r#1", "old", "10");
      clock.advance(DAY);
      await post(store, "o/r#2", "recent", "11");
      await post(store, "x/y#2", "other repo", "12");
      // A repository whose name starts like ours is not ours.
      await post(store, "o/r2#3", "prefix lookalike", "13");
      await store.recordCommentFailure("o/r#4", "failed", 1, 1000);
      clock.advance(DAY);
      await post(store, "o/r#5", "newest", "14");
      expect((await store.listPostedComments("o/r#", 7 * DAY)).map((r) => r.marker)).toEqual(["old", "recent", "newest"]);
      // Older than the window: left out.
      expect((await store.listPostedComments("o/r#", DAY + 1)).map((r) => r.marker)).toEqual(["recent", "newest"]);
      expect(await store.listPostedComments("z/z#", 7 * DAY)).toEqual([]);
    });
  });

  describe("base pushes (RFC 0015 M8): the item's newest push_base action, as the status page reads it", () => {
    it("pending with its batch's failed tries, then pushed or a conflict once delivered; none when the merge stored none", async () => {
      const { store, clock } = await make();
      const db = (store as unknown as { db: SqlDriver }).db;
      const { item } = await store.createWorkItem(issue(1), system);
      const { item: plain } = await store.createWorkItem(issue(2), system);
      const now = clock.now().toISOString();
      const push = (sha: string) => recordAction(db, {
        action: "push_base", target: { type: "git", id: "h:main", link: "" }, work_item_id: item.id, key: `push_base:${item.id}:${sha}`,
        args: { base_ref: "main", merge_sha: sha, message: "m" },
      }, now);
      await push("a".repeat(40));
      expect(await store.getBasePush(plain.id)).toBeNull();
      expect(await store.getBasePush(item.id)).toEqual({ base_ref: "main", merge_sha: "a".repeat(40), attempts: 0, last_error: null, outcome: null, pushed_sha: null });

      const [row] = await db.all("SELECT seq FROM outbound_actions WHERE work_item_id = ?", [item.id]);
      await db.run(
        "INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, attempts, last_error, opened_at, flush_at) VALUES ('b1', 'git:h:main', 'b1', 'failed', 1, 2, 'rate limited', ?, ?)",
        [now, now],
      );
      await db.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, 'b1', 'c1', 1)", [`act_${Number(row!.seq)}`]);
      expect(await store.getBasePush(item.id)).toMatchObject({ attempts: 2, last_error: "rate limited", outcome: null });

      await db.run("UPDATE outbound_actions SET delivered_at = ?, delivered_ref = ? WHERE seq = ?", [now, JSON.stringify({ pushed: "c".repeat(40) }), Number(row!.seq)]);
      expect(await store.getBasePush(item.id)).toMatchObject({ outcome: "pushed", pushed_sha: "c".repeat(40) });
      // A later merge's push is the newest: a conflict once delivered.
      await push("d".repeat(40));
      await db.run("UPDATE outbound_actions SET delivered_at = ?, delivered_ref = ? WHERE intent_key = ?", [now, JSON.stringify({ conflicts: ["x"] }), `push_base:${item.id}:${"d".repeat(40)}`]);
      expect(await store.getBasePush(item.id)).toMatchObject({ merge_sha: "d".repeat(40), outcome: "conflict", pushed_sha: null, attempts: 0 });
    });

    it("a base's backlog: its pushes after its newest pushed one, with the conflicting files of its newest delivered push when that is a conflict", async () => {
      const { store, clock } = await make();
      const db = (store as unknown as { db: SqlDriver }).db;
      const now = clock.now().toISOString();
      let n = 0;
      const push = async (base: string, delivered?: { pushed: string } | { conflicts: string[] }) => {
        const { item } = await store.createWorkItem(issue(100 + ++n), system);
        const key = `push_base:${item.id}:${n}`;
        await recordAction(db, { action: "push_base", target: { type: "git", id: `h:${base}:push`, link: "" }, work_item_id: item.id, key, args: { base_ref: base, merge_sha: String(n), message: "m" } }, now);
        if (delivered) await db.run("UPDATE outbound_actions SET delivered_at = ?, delivered_ref = ? WHERE intent_key = ?", [now, JSON.stringify(delivered), key]);
      };
      const of = async (base: string) => (await store.listBasePushBacklogs()).find((b) => b.base_ref === base) ?? null;
      expect(await of("main")).toBeNull();

      await push("main", { pushed: "p" });
      expect(await of("main")).toBeNull();
      // One pending push: waiting, no conflict.
      await push("main");
      expect(await of("main")).toEqual({ base_ref: "main", waiting: 1, conflicts: null });
      // A conflict, then a pending one after it: both wait, the conflict's files named.
      await push("main", { conflicts: ["a.txt"] });
      await push("main");
      expect(await of("main")).toEqual({ base_ref: "main", waiting: 3, conflicts: ["a.txt"] });
      // A newer conflict replaces the files.
      await push("main", { conflicts: ["b.txt", "c.txt"] });
      expect(await of("main")).toEqual({ base_ref: "main", waiting: 4, conflicts: ["b.txt", "c.txt"] });
      // Another base is its own backlog.
      await push("release", { conflicts: ["r.txt"] });
      expect(await of("release")).toEqual({ base_ref: "release", waiting: 1, conflicts: ["r.txt"] });
      expect(await of("main")).toMatchObject({ waiting: 4 });
      // A push that lands on another base leaves this base's backlog as it is.
      await push("release", { pushed: "r" });
      expect(await of("release")).toBeNull();
      expect(await of("main")).toEqual({ base_ref: "main", waiting: 4, conflicts: ["b.txt", "c.txt"] });
      // A push that lands clears the base: nothing before it waits.
      await push("main", { pushed: "q" });
      expect(await of("main")).toBeNull();
    });
  });

  describe("item thread actor (migration 39)", () => {
    it("keeps the account ID of an entry from a source; the factory's own entries have none", async () => {
      const { store } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      await store.recordItemMessage({ work_item_id: item.id, marker: "github:9", body: "/approve", actor: "github:42" });
      await store.recordItemMessage({ work_item_id: item.id, marker: "<!-- factory:x -->", body: "spec" });
      const [theirs, ours] = await store.listItemMessages(item.id);
      expect(theirs).toMatchObject({ marker: "github:9", actor: "github:42" });
      expect(ours).not.toHaveProperty("actor");
    });
  });

  describe("identity links", () => {
    const slack = (subject: string) => ({ provider: "slack" as const, subject });
    const userA = "github:1" as UserId;
    const userB = "github:2" as UserId;

    it("a code links once; resolve finds the account by provider and subject; links list oldest first", async () => {
      const { store } = await make();
      await store.createLinkCode(userA, "CODEAAAAA1");
      await store.createLinkCode(userA, "CODEAAAAA2");
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U1"))).toEqual({ ok: true, user_id: userA });
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U1"))).toEqual({ ok: true, user_id: userA });
      expect(await store.redeemLinkCode("CODEAAAAA1", slack("U2"))).toEqual({ ok: false, reason: "used" });
      expect(await store.redeemLinkCode("CODEAAAAA2", slack("U2"))).toEqual({ ok: true, user_id: userA });
      expect(await store.resolveLink("slack", "U1")).toBe(userA);
      expect(await store.resolveLink("github", "U1")).toBeNull();
      expect(await store.listLinks(userA)).toEqual([slack("U1"), slack("U2")]);
    });

    it("a wrong code links nothing; an account linked to another user is refused and the code stays usable", async () => {
      const { store } = await make();
      await store.createLinkCode(userB, "CODEBBBBB1");
      expect(await store.redeemLinkCode("WRONGCODE1", slack("U1"))).toEqual({ ok: false, reason: "invalid" });
      expect(await store.redeemLinkCode("CODEBBBBB1", slack("U1"))).toEqual({ ok: true, user_id: userB });
      await store.createLinkCode(userA, "CODEAAAAA3");
      expect(await store.redeemLinkCode("CODEAAAAA3", slack("U1"))).toEqual({ ok: false, reason: "already_linked" });
      expect(await store.redeemLinkCode("CODEAAAAA3", slack("U3"))).toEqual({ ok: true, user_id: userA });
      expect(await store.resolveLink("slack", "U1")).toBe(userB);
    });
  });
  describe("settings overrides (migration 15)", () => {
    const actor = "local:owner";

    it("set stores the JSON value and one audit row; a second set replaces it and records the old value", async () => {
      const { store, clock } = await make();
      expect(await store.listSettingOverrides()).toEqual([]);
      const first = await store.setSettingOverride({ key: "workers", project: "", value: "2", actor });
      expect(first).toMatchObject({ key: "workers", project: "", old_value: null, new_value: "2", actor, at: clock.now().toISOString() });
      clock.advance(1000);
      const second = await store.setSettingOverride({ key: "workers", project: "", value: "3", actor: "local:other" });
      expect(second).toMatchObject({ old_value: "2", new_value: "3", actor: "local:other" });
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(await store.listSettingOverrides()).toEqual([
        { key: "workers", project: "", value: "3", set_by: "local:other", set_at: clock.now().toISOString() },
      ]);
      expect((await store.listSettingChanges(10)).map((c) => c.new_value)).toEqual(["3", "2"]);
    });

    it("a project override is its own row; overrides list by key, then project", async () => {
      const { store } = await make();
      await store.setSettingOverride({ key: "max_attempts", project: PROJECT_KEY, value: "2", actor });
      await store.setSettingOverride({ key: "max_attempts", project: "", value: "3", actor });
      await store.setSettingOverride({ key: "lease_ms", project: "", value: "90000", actor });
      expect((await store.listSettingOverrides()).map((o) => [o.key, o.project, o.value])).toEqual([
        ["lease_ms", "", "90000"],
        ["max_attempts", "", "3"],
        ["max_attempts", PROJECT_KEY, "2"],
      ]);
    });

    it("reset deletes the override with one audit row; reset with no override writes nothing", async () => {
      const { store } = await make();
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toBeNull();
      expect(await store.listSettingChanges(10)).toEqual([]);
      await store.setSettingOverride({ key: "workers", project: "", value: "2", actor });
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toMatchObject({ old_value: "2", new_value: null });
      expect(await store.listSettingOverrides()).toEqual([]);
      expect(await store.resetSettingOverride({ key: "workers", project: "", actor })).toBeNull();
      expect((await store.listSettingChanges(10)).map((c) => [c.old_value, c.new_value])).toEqual([["2", null], [null, "2"]]);
    });

    it("history is newest first and honours the limit", async () => {
      const { store } = await make();
      for (const v of ["1", "2", "3"]) await store.setSettingOverride({ key: "workers", project: "", value: v, actor });
      expect((await store.listSettingChanges(2)).map((c) => c.new_value)).toEqual(["3", "2"]);
    });
  });

  describe("learned settings (20261111T1400-runtime-learned-settings)", () => {
    const at = "2026-03-05T00:00:00.000Z" as Timestamp;
    const learn = (expected: string | null, value: string, window_end = at) =>
      ({ project: PROJECT_KEY, key: "max_diff_lines", expected, value, evidence_run_ids: ["r1", "r2", "r3"] as RunId[], window_end, actor: "system:improver" });

    it("set stores the value with one audit row; get and list read it back", async () => {
      const { store, clock } = await make();
      expect(await store.getLearnedSetting(PROJECT_KEY, "max_diff_lines")).toBeNull();
      expect(await store.listLearnedSettings()).toEqual([]);
      const change = await store.setLearnedSetting(learn(null, "4000"));
      expect(change).toMatchObject({
        project: PROJECT_KEY, key: "max_diff_lines", old_value: null, new_value: "4000", evidence_run_ids: ["r1", "r2", "r3"], window_end: at,
        actor: "system:improver", at: clock.now().toISOString(),
      });
      const row = { project: PROJECT_KEY, key: "max_diff_lines", value: "4000", updated_at: clock.now().toISOString() };
      expect(await store.getLearnedSetting(PROJECT_KEY, "max_diff_lines")).toEqual(row);
      await store.setLearnedSetting({ ...learn(null, "7"), project: OTHER_PROJECT_KEY });
      const listed = await store.listLearnedSettings();
      expect(listed).toContainEqual(row);
      expect(listed.map((r) => r.project)).toEqual([PROJECT_KEY, OTHER_PROJECT_KEY].sort());
    });

    it("writes nothing when the stored value is not the expected one, or the window already has a row", async () => {
      const { store } = await make();
      await store.setLearnedSetting(learn(null, "4000"));
      expect(await store.setLearnedSetting(learn(null, "3000", "2026-03-06T00:00:00.000Z" as Timestamp))).toBeNull();
      expect(await store.setLearnedSetting(learn("4000", "3200"))).toBeNull();
      expect(await store.listLearnedSettingChanges(10)).toHaveLength(1);
      const next = await store.setLearnedSetting(learn("4000", "3200", "2026-03-06T00:00:00.000Z" as Timestamp));
      expect(next).toMatchObject({ old_value: "4000", new_value: "3200" });
      expect((await store.getLearnedSetting(PROJECT_KEY, "max_diff_lines"))?.value).toBe("3200");
      expect((await store.listLearnedSettingChanges(10)).map((c) => c.new_value)).toEqual(["3200", "4000"]);
    });

    it("reset deletes the value with one audit row; reset with none writes nothing", async () => {
      const { store } = await make();
      expect(await store.resetLearnedSetting({ key: "max_diff_lines", project: PROJECT_KEY, actor: "local:owner" })).toBeNull();
      await store.setLearnedSetting(learn(null, "4000"));
      expect(await store.resetLearnedSetting({ key: "max_diff_lines", project: PROJECT_KEY, actor: "local:owner" })).toMatchObject({
        old_value: "4000", new_value: null, evidence_run_ids: [], window_end: null, actor: "local:owner",
      });
      expect(await store.getLearnedSetting(PROJECT_KEY, "max_diff_lines")).toBeNull();
      expect((await store.listLearnedSettingChanges(10)).map((c) => c.new_value)).toEqual([null, "4000"]);
    });
  });

  describe("worker processes (migration 19)", () => {
    const report = (over: Partial<WorkerProcessReport> = {}): WorkerProcessReport => ({
      process_id: "host-a:42", pid: 42, host: "host-a", slots: 2, max_slots: 4, busy: 1, index_base: 0,
      started_at: "2026-01-01T00:00:00.000Z" as Timestamp, ...over,
    });

    it("a report is stored with reported_at = now; a repeat write for the same process replaces the row", async () => {
      const { store, clock } = await make();
      expect(await store.listWorkerProcesses(LEASE)).toEqual([]);
      const first = await store.reportWorkerProcess(report());
      expect(first).toEqual({ ...report(), reported_at: clock.now().toISOString() });
      clock.advance(1000);
      await store.reportWorkerProcess(report({ slots: 3, busy: 3 }));
      expect(await store.listWorkerProcesses(LEASE)).toEqual([{ ...report({ slots: 3, busy: 3 }), reported_at: clock.now().toISOString() }]);
    });

    it("lists one row per process, by host then pid; a row older than max_age_ms is not listed", async () => {
      const { store, clock } = await make();
      await store.reportWorkerProcess(report({ process_id: "host-b:7", host: "host-b", pid: 7 }));
      clock.advance(LEASE / 2);
      await store.reportWorkerProcess(report({ process_id: "host-a:9", pid: 9 }));
      await store.reportWorkerProcess(report());
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9", "host-a:42", "host-b:7"]);
      clock.advance(LEASE / 2);
      // host-b:7 is exactly LEASE old: still live.
      expect(await store.listWorkerProcesses(LEASE)).toHaveLength(3);
      clock.advance(1);
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9", "host-a:42"]);
    });

    it("remove deletes only that process's row; removing again reports false", async () => {
      const { store } = await make();
      await store.reportWorkerProcess(report());
      await store.reportWorkerProcess(report({ process_id: "host-a:9", pid: 9 }));
      expect(await store.removeWorkerProcess("host-a:42")).toBe(true);
      expect(await store.removeWorkerProcess("host-a:42")).toBe(false);
      expect((await store.listWorkerProcesses(LEASE)).map((p) => p.process_id)).toEqual(["host-a:9"]);
    });

    it("concurrent first writes for one process leave one row", async () => {
      const { store } = await make();
      await Promise.all([store.reportWorkerProcess(report({ busy: 0 })), store.reportWorkerProcess(report({ busy: 2 }))]);
      const rows = await store.listWorkerProcesses(LEASE);
      expect(rows).toHaveLength(1);
      expect([0, 2]).toContain(rows[0]!.busy);
    });
  });
  describe("alerts (migration 36)", () => {
    const HOUR = 3_600_000;
    const alert = (over: Partial<NewAlert> = {}): NewAlert => ({
      pattern: "repeated_error", pattern_key: "repeated_error:abc", error_code: "checks_failed", count: 3, detail: "boom", ...over,
    });

    it("stores an alert with its fields; the same pattern inside the dedupe window stores none", async () => {
      const { store, clock } = await make();
      expect(await store.listAlerts({ limit: 10 })).toEqual([]);
      const first = await store.recordAlert(alert(), 6 * HOUR);
      expect(first).toMatchObject({ created: true, alert: { ...alert(), created_at: clock.now().toISOString() } });
      clock.advance(6 * HOUR - 1);
      expect(await store.recordAlert(alert({ count: 4 }), 6 * HOUR)).toEqual({ created: false });
      // Another pattern is its own; a null detail round-trips.
      const other = await store.recordAlert(alert({ pattern: "zero_tokens", pattern_key: "zero_tokens", detail: null }), 6 * HOUR);
      expect(other).toMatchObject({ created: true, alert: { pattern: "zero_tokens", detail: null } });
      expect((await store.listAlerts({ limit: 10 })).map((a) => a.pattern_key)).toEqual(["zero_tokens", "repeated_error:abc"]);
    });

    it("the same pattern stores again once the window has passed; newest first, limit honoured", async () => {
      const { store, clock } = await make();
      await store.recordAlert(alert(), 6 * HOUR);
      clock.advance(6 * HOUR);
      const again = await store.recordAlert(alert({ count: 7 }), 6 * HOUR);
      expect(again).toMatchObject({ created: true, alert: { count: 7 } });
      expect((await store.listAlerts({ limit: 10 })).map((a) => a.count)).toEqual([7, 3]);
      expect((await store.listAlerts({ limit: 1 })).map((a) => a.count)).toEqual([7]);
    });

    it("concurrent records of one pattern leave one alert", async () => {
      const { store } = await make();
      const results = await Promise.all([store.recordAlert(alert(), 6 * HOUR), store.recordAlert(alert(), 6 * HOUR)]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await store.listAlerts({ limit: 10 })).toHaveLength(1);
    });

    it("dismissAlert records the time and the actor ID on the pattern, once per alert; an unknown id is null", async () => {
      const { store, clock } = await make();
      const r = await store.recordAlert(alert(), 6 * HOUR);
      const id = r.created ? r.alert.id : "";
      expect(await store.dismissAlert("al_nope", "local:owner" as UserId)).toBeNull();
      clock.advance(60_000);
      const at = clock.now().toISOString();
      expect(await store.dismissAlert(id, "local:owner" as UserId)).toEqual({ pattern_key: "repeated_error:abc", dismissed: true, dismissed_at: at });
      clock.advance(60_000);
      expect(await store.dismissAlert(id, "local:other" as UserId)).toEqual({ pattern_key: "repeated_error:abc", dismissed: false, dismissed_at: at });
      expect(await store.listAlertDismissals(at as Timestamp)).toEqual([{ pattern_key: "repeated_error:abc", dismissed_at: at, dismissed_by: "local:owner" }]);
      expect(await store.listAlertDismissals(clock.now().toISOString() as Timestamp)).toEqual([]);
      expect((await store.listAlerts({ limit: 10 }))[0]).toMatchObject({ id, dismissed_at: at });
    });

    it("a dismissal newer than the pattern's last alert lifts its dedupe window once", async () => {
      const { store, clock } = await make();
      const first = await store.recordAlert(alert(), 6 * HOUR);
      clock.advance(60_000);
      await store.dismissAlert(first.created ? first.alert.id : "", "local:owner" as UserId);
      clock.advance(60_000);
      const results = await Promise.all([store.recordAlert(alert({ count: 5 }), 6 * HOUR), store.recordAlert(alert({ count: 5 }), 6 * HOUR)]);
      expect(results.filter((x) => x.created)).toHaveLength(1);
      clock.advance(60_000);
      expect(await store.recordAlert(alert({ count: 6 }), 6 * HOUR)).toEqual({ created: false });
      const [newest] = await store.listAlerts({ limit: 1 });
      // The new alert is newer than the dismissal: its alarm shows again.
      expect(newest!.count).toBe(5);
      expect(Date.parse(newest!.created_at)).toBeGreaterThan(Date.parse(newest!.dismissed_at!));
    });
  });

  describe("retention (design 08-retention)", () => {
    const DAY = 86_400_000;
    const ALL_KINDS: RunKind[] = ["triage", "implement", "review", "update", "resolve"];
    const finished = { status: "succeeded" as const, summary: "", data: {} };
    /** The store's SQL driver, for rows only an old schema wrote (a request from before the command tables merged). */
    const dbOf = (store: FactoryStore) => (store as unknown as { db: SqlDriver }).db;

    it("pruneDeliveredOutbox deletes delivered rows past the cutoff, at most limit per call; an undelivered row stays at any age", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system);
      for (const m of ["a", "b", "c", "pending"]) {
        await store.recordItemMessage({ work_item_id: item.id, marker: `<!-- ${m} -->`, body: m, delivery: { source_type: "github_issue", target: issue(1).source } });
      }
      const rows = await store.listPendingDeliveries(["github_issue"], 10);
      for (const row of rows.slice(0, 3)) await store.finishDelivery(row.seq, (await store.claimDelivery(row.seq, LEASE))!, null);
      // Delivered but not old yet: nothing goes.
      expect(await store.pruneDeliveredOutbox(30 * DAY, 2)).toMatchObject({ outbound_intents: 0 });
      clock.advance(400 * DAY);
      expect(await store.pruneDeliveredOutbox(30 * DAY, 2)).toMatchObject({ outbound_intents: 2 });
      expect(await store.pruneDeliveredOutbox(30 * DAY, 2)).toMatchObject({ outbound_intents: 1 });
      // Run twice: nothing more, no error; the undelivered row is still there to send.
      expect(await store.pruneDeliveredOutbox(30 * DAY, 2)).toMatchObject({ outbound_intents: 0 });
      expect((await store.listPendingDeliveries(["github_issue"], 10)).map((r) => r.seq)).toEqual([rows[3]!.seq]);
    });

    it("pruneHandledCommands deletes old commands the cursor passed; an unread, mirror-pending or unhandled app row stays", async () => {
      const { store, clock } = await make();
      const cmd = (key: string, mirror = false) => store.appendCliCommand({ key, actor: "local:me", command: "approve", args: {}, ...(mirror ? { mirror } : {}) });
      await cmd("cli:read");
      await cmd("cli:mirror", true);
      const handled = (await store.recordAppCommandRequest({ key: "app:handled", actor: "local:me" as UserId, command: "approve", args: {} })).request;
      await store.recordAppCommandRequest({ key: "app:open", actor: "local:me" as UserId, command: "approve", args: {} });
      await store.markAppCommandRequest(handled.seq, null);
      const last = (await store.listCliCommandsAfter(0, 10)).at(-1)!;
      expect(await store.advanceCursor("commands", null, String(last.seq))).toBe(true);
      await cmd("cli:unread");
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 0 });
      clock.advance(31 * DAY);
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 2 });
      const keys = async () => (await store.listCliCommandsAfter(0, 10)).map((c) => c.key);
      expect(await keys()).toEqual(["cli:mirror", "app:open", "cli:unread"]);
      expect(await store.getAppCommandRequest("app:handled")).toBeNull();
      // Once mirrored it goes; a second pass deletes nothing.
      await store.markCliCommandMirrored("cli:mirror");
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 1 });
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 0 });
      expect(await keys()).toEqual(["app:open", "cli:unread"]);
    });

    it("a handled app request from before the merge stays until its app:<seq> command row is gone", async () => {
      const { store, clock } = await make();
      const at = clock.now().toISOString();
      const db = dbOf(store);
      await db.run(
        `INSERT INTO inbound_commands (id, origin, command_key, actor, command, args, created_at, handled_at, legacy_table, legacy_seq)
         VALUES ('cmd_old', 'app', 'app:uuid-7', 'local:me', 'approve', '{}', ?, ?, 'app_command_requests', 7)`,
        [at, at],
      );
      // Its command row, copied from command_inbox, still waiting for the mirror.
      await db.run(
        `INSERT INTO inbound_commands (id, origin, command_key, actor, command, args, created_at, mirror, legacy_table, legacy_seq)
         VALUES ('cmd_old_row', 'app', 'app:7', 'local:me', 'approve', '{}', ?, 1, 'command_inbox', 3)`,
        [at],
      );
      const last = (await store.listCliCommandsAfter(0, 10)).at(-1)!;
      await store.advanceCursor("commands", null, String(last.seq));
      clock.advance(31 * DAY);
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 0 });
      await store.markCliCommandMirrored("app:7");
      // The command row goes first; its request waits for the next pass.
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 1 });
      expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.key)).toEqual(["app:uuid-7"]);
      expect(await store.pruneHandledCommands(30 * DAY, 100)).toEqual({ inbound_commands: 1 });
      expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
    });

    it("listClaimDecisionsSince lists every item's claim decisions written at or after a time, oldest first", async () => {
      const { store, clock } = await make();
      const ids: WorkItemId[] = [];
      for (const n of [1, 2]) {
        const { item } = await store.createWorkItem(issue(n), system);
        await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "RUNNING", files_to_change: ["src/worker/runner.ts"], allowed_paths: ["src/worker/"] } });
        await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `${n}:implement` } });
        clock.advance(1_000);
        ids.push(item.id);
      }
      const before = clock.now().toISOString() as Timestamp;
      await store.claimRun({ worker_id: w1, kinds: ALL_KINDS, lease_ms: LEASE });
      expect(await store.claimRun({ worker_id: w1, kinds: ALL_KINDS, lease_ms: LEASE })).toBeNull();
      const since = await store.listClaimDecisionsSince(before);
      expect(since.find((d) => d.work_item_id === ids[1])).toMatchObject({ decision: "held", shared: [{ path: "src/worker/runner.ts" }] });
      clock.advance(1_000);
      expect(await store.listClaimDecisionsSince(clock.now().toISOString() as Timestamp)).toEqual([]);
    });

    it("pruneHistory keeps a claim decision of a queued or running run at any age; finished runs', host sleeps and alerts go", async () => {
      const { store, clock } = await make();
      const held = async (n: number) => {
        const { item } = await store.createWorkItem(issue(n), system);
        await store.transition({
          id: item.id, expected_version: 1, actor: system, reason: "x",
          patch: { stage: "RUNNING", files_to_change: ["src/worker/runner.ts"], allowed_paths: ["src/worker/"] },
        });
        await store.transition({ id: item.id, expected_version: 2, patch: {}, actor: system, reason: "x", enqueue: { kind: "implement", idempotency_key: `${n}:implement` } });
        clock.advance(1_000);
        return item.id;
      };
      const a = await held(1);
      const b = await held(2);
      const claim = () => store.claimRun({ worker_id: w1, kinds: ALL_KINDS, lease_ms: LEASE });
      const first = (await claim())!;
      expect(await claim()).toBeNull();
      expect(await store.listClaimDecisions(b)).toHaveLength(1);
      await store.recordHostSleep({ worker_id: w1, woke_at: clock.now().toISOString() as Timestamp, gap_ms: 120_000, run_id: null });
      await store.recordAlert({ pattern: "repeated_error", pattern_key: "k", error_code: "x", count: 3, detail: null }, 6 * 3_600_000);

      clock.advance(400 * DAY);
      const r = await store.pruneHistory(90 * DAY, 100);
      expect(r).toMatchObject({ worker_host_sleeps: 1, controller_alerts: 1 });
      expect(await store.listClaimDecisions(b)).toHaveLength(1);
      // Running, still kept; finished, it goes.
      await store.completeRun(first.id, first.lease!.token, finished);
      const second = (await claim())!;
      expect(second.work_item_id).toBe(b);
      clock.advance(400 * DAY);
      await store.pruneHistory(90 * DAY, 100);
      expect(await store.listClaimDecisions(a)).toEqual([]);
      expect(await store.listClaimDecisions(b)).toHaveLength(1);
      await store.completeRun(second.id, second.lease!.token, finished);
      expect((await store.pruneHistory(90 * DAY, 100)).controller_claim_decisions).toBe(1);
      expect(await store.listClaimDecisions(b)).toEqual([]);
      expect(await store.pruneHistory(90 * DAY, 100)).toMatchObject({ controller_claim_decisions: 0, worker_host_sleeps: 0, controller_alerts: 0 });
    });

    it("an alert inside the alarm dedupe window stays at any retention above 0", async () => {
      const { store, clock } = await make();
      await store.recordAlert({ pattern: "repeated_error", pattern_key: "k", error_code: "x", count: 3, detail: null }, 6 * 3_600_000);
      clock.advance(6 * 3_600_000 - 1);
      expect((await store.pruneHistory(1, 100)).controller_alerts).toBe(0);
      clock.advance(2);
      expect((await store.pruneHistory(1, 100)).controller_alerts).toBe(1);
    });

    it("state_changes, verdicts, runs and the pause history are never deleted", async () => {
      const { store, clock } = await make();
      const { item } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "o/r#1:triage" } });
      await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "x", patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "9" } });
      const v = await store.recordVerdict({
        id: item.id, expected_version: 2, actor: human, verdict: "accept", severity: "none", reason: null, comment_id: "c1", target: "pr", implicit: false, pr_head: null,
      });
      expect(v.ok).toBe(true);
      await store.recordEndedPause({ name: "model_stall", started_at: "2026-01-01T00:00:00.000Z" as Timestamp, ended_at: "2026-01-01T01:00:00.000Z" as Timestamp });
      const kept = ["controller_state_changes", "controller_verdicts", "worker_runs", "controller_pause_history"];
      const counts = async () => Object.fromEntries((await store.listTables()).filter((t) => kept.includes(t.name)).map((t) => [t.name, t.rows]));
      const before = await counts();
      expect(Object.values(before).every((n) => n > 0)).toBe(true);
      clock.advance(4000 * DAY);
      await store.pruneDeliveredOutbox(1, 1000);
      await store.pruneHandledCommands(1, 1000);
      await store.pruneHistory(1, 1000);
      expect(await counts()).toEqual(before);
    });

    it("the base push, handoff and posted-comment lookups use their indexes, not a table scan", async () => {
      const { store } = await make();
      const plan = async (sql: string) => (await dbOf(store).all(`EXPLAIN QUERY PLAN ${sql}`, ["x"])).map((r) => String(r.detail)).join("; ");
      // The store's queries, as getBasePush, listHandoffs and the reactions' comment lookup send them.
      expect(await plan("SELECT seq, args, delivered_ref FROM outbound_actions WHERE action = 'push_base' AND work_item_id = ? ORDER BY seq DESC LIMIT 1"))
        .toMatch(/SEARCH outbound_actions USING INDEX outbound_actions_item \(work_item_id=\? AND action=\?\)/);
      expect(await plan("SELECT * FROM controller_handoffs WHERE work_item_id = ? ORDER BY at, rowid"))
        .toMatch(/SEARCH controller_handoffs USING INDEX controller_handoffs_item \(work_item_id=\?\)/);
      expect(await plan("SELECT * FROM outbound_deliveries WHERE comment_id = ? ORDER BY created_at, updated_at, marker"))
        .toMatch(/SEARCH outbound_deliveries USING INDEX outbound_deliveries_comment \(comment_id=\?\)/);
    });

    it("pruneHistory deletes authz_audit rows older than the cutoff; a recent one stays", async () => {
      const { store, clock } = await make();
      const decide = (principal: string) => store.recordOwnerDecision({ principal: principal as UserId, action: "approve_spec", allow: true, reason: "allowed" });
      await decide("local:old");
      clock.advance(60 * DAY);
      await decide("local:recent");
      clock.advance(31 * DAY);
      expect((await store.pruneHistory(90 * DAY, 100)).authz_audit).toBe(1);
      expect(await dbOf(store).all("SELECT principal FROM authz_audit")).toEqual([{ principal: "local:recent" }]);
      expect((await store.pruneHistory(90 * DAY, 100)).authz_audit).toBe(0);
    });

    it("pruneDeliveredOutbox deletes old delivered actions but each item's newest push_base, and only the batch rows no kept action uses", async () => {
      const { store, clock } = await make();
      const db = dbOf(store);
      const items = [(await store.createWorkItem(issue(1), system)).item.id, (await store.createWorkItem(issue(2), system)).item.id];
      const at = () => clock.now().toISOString();
      /** One action in its own sent batch; returns its seq. */
      const action = async (item: string | null, kind: string, delivered: boolean, args = "{}") => {
        await db.run(
          "INSERT INTO outbound_actions (work_item_id, source_type, target, action, args, created_at, delivered_at, delivered_ref) VALUES (?, 'git', 'x', ?, ?, ?, ?, ?)",
          [item, kind, args, at(), delivered ? at() : null, delivered && kind === "push_base" ? JSON.stringify({ pushed: "abc" }) : null],
        );
        const [row] = await db.all("SELECT MAX(seq) AS seq FROM outbound_actions");
        const seq = Number(row!.seq), batch = `b_${seq}`;
        await db.run(
          "INSERT INTO outbound_batches (id, destination, idempotency_key, state, intent_count, attempts, opened_at, flush_at, sent_at) VALUES (?, 'git:x', ?, ?, 1, 2, ?, ?, ?)",
          [batch, batch, delivered ? "sent" : "open", at(), at(), delivered ? at() : null],
        );
        await db.run("INSERT INTO outbound_batch_intents (intent_id, batch_id, commit_id, commit_count) VALUES (?, ?, 'c', 1)", [`act_${seq}`, batch]);
        return seq;
      };
      const base = (n: number) => JSON.stringify({ base_ref: "main", merge_sha: `sha${n}` });
      const oldBase = await action(items[0]!, "push_base", true, base(1));
      const newestBase = await action(items[0]!, "push_base", true, base(2));
      const otherBase = await action(items[1]!, "push_base", true, base(3));
      const status = await action(items[0]!, "status", true);
      const pending = await action(null, "post", false);
      clock.advance(10 * DAY);
      const recent = await action(items[1]!, "status", true);
      // Every comment record stays (decision 2: deliveries are kept).
      await store.recordPostedComment({ source_id: "o/r#1", marker: "<!-- m -->", comment_id: "c1", url: null, body: "b" });
      clock.advance(25 * DAY);

      expect(await store.pruneDeliveredOutbox(30 * DAY, 100)).toMatchObject({ outbound_actions: 2, outbound_batch_intents: 2, outbound_batches: 2 });
      const left = (await db.all("SELECT seq FROM outbound_actions ORDER BY seq")).map((r) => Number(r.seq));
      expect(left).toEqual([newestBase, otherBase, pending, recent]);
      expect(left).not.toContain(oldBase);
      expect(left).not.toContain(status);
      const batches = (await db.all("SELECT batch_id FROM outbound_batch_intents ORDER BY seq")).map((r) => String(r.batch_id));
      expect(batches).toEqual(left.map((s) => `b_${s}`));
      expect((await db.all("SELECT id FROM outbound_batches ORDER BY seq")).map((r) => String(r.id))).toEqual(batches);
      // The kept push_base still reads with its batch's tries.
      expect(await store.getBasePush(items[0]! as WorkItemId)).toMatchObject({ merge_sha: "sha2", attempts: 2, outcome: "pushed" });
      expect(await db.all("SELECT comment_id FROM outbound_deliveries")).toEqual([{ comment_id: "c1" }]);
      expect(await store.pruneDeliveredOutbox(30 * DAY, 100)).toEqual({ outbound_intents: 0, outbound_actions: 0, outbound_batch_intents: 0, outbound_batches: 0 });
    });

    it("pruneHistory deletes expired passports and revocations; no live passport loses its parent", async () => {
      const { store, clock } = await make();
      const db = dbOf(store);
      const passport = (id: string, parent: string | null, expires_in_ms: number) =>
        db.run(
          `INSERT INTO identity_passports (id, parent_id, principal, provider, origin, kind, restrictions, token_hash, key_id, issued_at, expires_at)
           VALUES (?, ?, 'service:worker', 'local', 'local', 'run', '{}', 'h', 'k', ?, ?)`,
          [id, parent, clock.now().toISOString(), new Date(clock.now().getTime() + expires_in_ms).toISOString()],
        );
      const revoke = (id: string, expires_in_ms: number) =>
        db.run("INSERT INTO identity_revocations (passport_id, revoked_by, reason, revoked_at, expires_at) VALUES (?, 'x', 'r', ?, ?)", [
          id, clock.now().toISOString(), new Date(clock.now().getTime() + expires_in_ms).toISOString(),
        ]);
      await passport("root", null, 1_000);
      await passport("mid", "root", 1_000);
      await passport("live", "mid", 10 * DAY);
      await passport("gone", null, 1_000);
      await passport("valid", null, 10 * DAY);
      await revoke("gone", 1_000);
      await revoke("valid", 10 * DAY);
      clock.advance(DAY);
      expect(await store.pruneHistory(90 * DAY, 100)).toMatchObject({ identity_passports: 1, identity_revocations: 1 });
      expect((await db.all("SELECT id FROM identity_passports ORDER BY id")).map((r) => r.id)).toEqual(["live", "mid", "root", "valid"]);
      expect(await db.all("SELECT passport_id FROM identity_revocations")).toEqual([{ passport_id: "valid" }]);
      // Once the child expires, its chain goes too.
      clock.advance(10 * DAY);
      await store.pruneHistory(90 * DAY, 100);
      await store.pruneHistory(90 * DAY, 100);
      expect(await db.all("SELECT id FROM identity_passports")).toEqual([]);
    });

    it("pruneHistory deletes claim pauses that ended before the cutoff; a live pause and a probe pause in effect stay, and a restarted pause reads", async () => {
      const { store, clock } = await make();
      const at = (ms: number) => new Date(clock.now().getTime() + ms).toISOString() as Timestamp;
      await store.pauseClaims(at(60_000));
      await store.pauseClaims(at(60_000), "model_stall");
      clock.advance(100 * DAY);
      await store.pauseClaims(at(DAY), "forge_auth");
      const names = async () => (await dbOf(store).all("SELECT name FROM worker_claim_pauses ORDER BY name")).map((r) => r.name);
      // The rate-limit pause ended long ago and goes; the stall is still in effect (no probe answered it), and the
      // live forge_auth pause stays.
      expect((await store.pruneHistory(90 * DAY, 100)).worker_claim_pauses).toBe(1);
      expect(await names()).toEqual(["forge_auth", "model_stall", "model_stall_since"]);
      expect(await store.getClaimPause("model_stall")).not.toBeNull();
      // Restarted, the pruned pause reads as any new one.
      expect(await store.pauseClaims(at(60_000))).toEqual({ extended: true, resume_at: at(60_000) });
      expect(await store.getClaimPause()).toBe(at(60_000));
    });
  });

  describe("recurring failure holds (design 05-alarms)", () => {
    it("a queued run of an item held with recurring_failure is not claimed; another item's is; released, it is", async () => {
      const { store } = await make();
      const { item: held } = await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "held" } });
      const { item: other } = await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "other" } });
      const hold = await store.transition({ id: held.id, expected_version: held.version, actor: system, reason: "recurring_failure", patch: { blocked_on: "upstream", blocked_reason: "recurring_failure" } });
      expect(hold.ok).toBe(true);
      expect((await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE }))?.work_item_id).toBe(other.id);
      expect(await store.claimRun({ worker_id: w1, kinds: ["triage"], lease_ms: LEASE })).toBeNull();
      const now = (await store.getWorkItem(held.id))!;
      await store.transition({ id: held.id, expected_version: now.version, actor: system, reason: "released", patch: { blocked_on: "none", blocked_reason: null } });
      expect((await store.claimRun({ worker_id: w2, kinds: ["triage"], lease_ms: LEASE }))?.work_item_id).toBe(held.id);
    });
  });
  describe("restart history (design 05-restarts)", () => {
    const MIN = 60_000;
    const at = (clock: FakeClock, ago_ms: number) => new Date(clock.now().getTime() - ago_ms).toISOString();

    it("applying the same restart twice leaves one record; another reason at the same time is its own", async () => {
      const { store, clock } = await make();
      const r = { at: at(clock, 0), reason: "exit code 1" };
      expect(await store.recordChildRestart(r)).toEqual({ created: true });
      expect(await store.recordChildRestart({ ...r })).toEqual({ created: false });
      expect(await store.recordChildRestart({ at: r.at, reason: "boom" })).toEqual({ created: true });
      expect(await store.listChildRestartsWithin(30 * MIN)).toEqual(expect.arrayContaining([r, { at: r.at, reason: "boom" }]));
      expect((await store.listChildRestartsWithin(30 * MIN)).filter((x) => x.reason === r.reason)).toEqual([r]);
    });

    it("concurrent writes of one restart leave one record", async () => {
      const { store, clock } = await make();
      const r = { at: at(clock, 0), reason: "exit code 1" };
      const results = await Promise.all([store.recordChildRestart(r), store.recordChildRestart(r)]);
      expect(results.filter((x) => x.created)).toHaveLength(1);
      expect(await store.listChildRestartsWithin(30 * MIN)).toEqual([r]);
    });

    it("lists the restarts inside the window on the store's clock, oldest first", async () => {
      const { store, clock } = await make();
      const old = { at: at(clock, 31 * MIN), reason: "r1" };
      const mid = { at: at(clock, 10 * MIN), reason: "r2" };
      const last = { at: at(clock, 0), reason: "r3" };
      for (const r of [last, old, mid]) await store.recordChildRestart(r);
      expect(await store.listChildRestartsWithin(30 * MIN)).toEqual([mid, last]);
      expect(await store.listChildRestartsWithin(60 * MIN)).toEqual([old, mid, last]);
    });
  });
  describe("host sleeps (migration 28)", () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString() as Timestamp;
    const sleep = (over: Partial<HostSleep> = {}): HostSleep => ({ worker_id: w1, woke_at: at(0), gap_ms: 120_000, run_id: null, ...over });

    it("stores a sleep with its ids, time and gap; recording it again keeps one row", async () => {
      const { store } = await make();
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([]);
      expect(await store.recordHostSleep(sleep())).toEqual({ created: true, sleep: sleep() });
      // Same worker and wake time: the stored row, not a second one, even with another gap.
      expect(await store.recordHostSleep(sleep({ gap_ms: 1 }))).toEqual({ created: false, sleep: sleep() });
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([sleep()]);
    });

    it("lists newest first, honours the limit, and keeps one row per worker for the same wake time", async () => {
      const { store } = await make();
      await store.recordHostSleep(sleep({ woke_at: at(1000) }));
      await store.recordHostSleep(sleep({ woke_at: at(3000) }));
      await store.recordHostSleep(sleep({ woke_at: at(2000) }));
      await store.recordHostSleep(sleep({ worker_id: w2, woke_at: at(3000) }));
      expect((await store.listHostSleeps({ limit: 10 })).map((h) => [h.worker_id, h.woke_at])).toEqual([
        [w2, at(3000)], [w1, at(3000)], [w1, at(2000)], [w1, at(1000)],
      ]);
      expect((await store.listHostSleeps({ limit: 2 })).map((h) => h.woke_at)).toEqual([at(3000), at(3000)]);
    });

    it("concurrent writes of one sleep leave one row", async () => {
      const { store } = await make();
      const results = await Promise.all([store.recordHostSleep(sleep()), store.recordHostSleep(sleep())]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await store.listHostSleeps({ limit: 10 })).toEqual([sleep()]);
    });

    it("by work item: only sleeps recorded during that item's runs", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system, { enqueue: { kind: "triage", idempotency_key: "t1" } })).item;
      const b = (await store.createWorkItem(issue(2), system, { enqueue: { kind: "triage", idempotency_key: "t2" } })).item;
      const [ra] = await store.listRuns(a.id);
      const [rb] = await store.listRuns(b.id);
      await store.recordHostSleep(sleep({ woke_at: at(1000), run_id: ra!.id }));
      await store.recordHostSleep(sleep({ woke_at: at(2000), run_id: rb!.id }));
      await store.recordHostSleep(sleep({ woke_at: at(3000) }));
      await store.recordHostSleep(sleep({ woke_at: at(4000), run_id: ra!.id }));
      expect((await store.listHostSleeps({ limit: 10, work_item_id: a.id })).map((h) => [h.woke_at, h.run_id])).toEqual([
        [at(4000), ra!.id], [at(1000), ra!.id],
      ]);
      expect(await store.listHostSleeps({ limit: 10, work_item_id: "wi_none" as WorkItemId })).toEqual([]);
    });
  });
  // App command requests (issue #245, migration 23 on both backends).
  describe("dependency edges keep the issue updated_at they were read at (migrations 32 and 33)", () => {
    const T1 = "2026-11-07T10:00:00.000Z" as Timestamp;
    const T2 = "2026-11-07T11:00:00.000Z" as Timestamp;

    it("replaceDependencyEdges with read_at records it on every edge and on the item; without it both stay", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item.id;
      expect(await store.dependencyLinksReadAt(a)).toBeNull();
      const plain = await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }]);
      expect(plain.map((e) => e.source_updated_at)).toEqual([null]);

      const read = await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }, { depends_on: "o/r#3", kind: "sub_issue" }], T1);
      expect(read.map((e) => [e.depends_on, e.source_updated_at])).toEqual([["o/r#2", T1], ["o/r#3", T1]]);
      expect(await store.dependencyLinksReadAt(a)).toBe(T1);
      expect((await store.listDependencyEdges({ work_item_id: a })).map((e) => e.source_updated_at)).toEqual([T1, T1]);

      // No links: the item still records when they were read.
      await store.replaceDependencyEdges(a, [], T2);
      expect(await store.listDependencyEdges({ work_item_id: a })).toEqual([]);
      expect(await store.dependencyLinksReadAt(a)).toBe(T2);
      await store.replaceDependencyEdges(a, []);
      expect(await store.dependencyLinksReadAt(a)).toBe(T2);
    });

    it("markDependencyLinksStale clears the item's read time, twice as once", async () => {
      const { store } = await make();
      const a = (await store.createWorkItem(issue(1), system)).item.id;
      await store.replaceDependencyEdges(a, [{ depends_on: "o/r#2", kind: "depends_on" }], T1);
      await store.markDependencyLinksStale(a);
      await store.markDependencyLinksStale(a);
      expect(await store.dependencyLinksReadAt(a)).toBeNull();
      // The edges keep the time they were read at.
      expect((await store.listDependencyEdges({ work_item_id: a })).map((e) => e.source_updated_at)).toEqual([T1]);
    });
  });

  describe("command proposals (SQLite 43)", () => {
    const row = (idx: number, over: Partial<{ proposal_id: string; args: string }> = {}) => ({
      proposal_id: over.proposal_id ?? "prop_a", idx, work_item_id: "wi_1" as WorkItemId, command: "approve" as const,
      args: over.args ?? "", author_id: "slack:U0ALICE",
    });

    it("stores one pending row per (proposal, index); the same rows again write nothing new", async () => {
      const { store, clock } = await make();
      expect(await store.recordCommandProposals([row(0, { args: "ship it" }), row(1)])).toBe(2);
      expect(await store.recordCommandProposals([row(0, { args: "changed" }), row(1)])).toBe(0);
      expect(await store.listCommandProposals("prop_a")).toEqual([
        { ...row(0, { args: "ship it" }), status: "pending", answered_by: null, refusal: null, created_at: clock.now().toISOString(), answered_at: null },
        { ...row(1), status: "pending", answered_by: null, refusal: null, created_at: clock.now().toISOString(), answered_at: null },
      ]);
      // A new index of the same proposal, and another proposal, are stored beside them.
      expect(await store.recordCommandProposals([row(1), row(2), row(0, { proposal_id: "prop_b" })])).toBe(2);
      expect((await store.listCommandProposals("prop_a")).map((r) => r.idx)).toEqual([0, 1, 2]);
      expect(await store.listCommandProposals("prop_none")).toEqual([]);
    });

    it("an answer is conditional on the stored status: a second claim of a row changes nothing", async () => {
      const { store, clock } = await make();
      await store.recordCommandProposals([row(0), row(1)]);
      clock.advance(1000);
      const claim = { proposal_id: "prop_a", idx: 0, from: "pending" as const, to: "applied" as const, answered_by: "github:1" };
      expect(await store.answerCommandProposal(claim)).toBe(true);
      expect(await store.answerCommandProposal({ ...claim, answered_by: "github:2" })).toBe(false);
      expect(await store.answerCommandProposal({ ...claim, from: "applied", to: "refused", refusal: "the item is closed" })).toBe(true);
      expect(await store.answerCommandProposal({ ...claim, idx: 1, to: "cancelled" })).toBe(true);
      expect((await store.listCommandProposals("prop_a")).map((r) => [r.idx, r.status, r.answered_by, r.refusal, r.answered_at])).toEqual([
        [0, "refused", "github:1", "the item is closed", clock.now().toISOString()],
        [1, "cancelled", "github:1", null, clock.now().toISOString()],
      ]);
    });
  });

  describe("golden fingerprints (SQLite 44, design 06-measurement)", () => {
    const verdict = (fingerprint: string, v: "pass" | "regression", pass_rate: number, failing_cases: string[] = []) => ({
      entity_id: "skill/tests-first", fingerprint, verdict: v, pass_rate, failing_cases,
    });

    it("an entity never evaluated reads as null; a pass is its last verdict and its base", async () => {
      const { store, clock } = await make();
      expect(await store.getGoldenFingerprint("skill/tests-first")).toBeNull();
      const stored = await store.recordGoldenVerdict(verdict("fp1", "pass", 0.75));
      expect(stored).toEqual({ ...verdict("fp1", "pass", 0.75), base_fingerprint: "fp1", base_rate: 0.75, at: clock.now().toISOString() });
      expect(await store.getGoldenFingerprint("skill/tests-first")).toEqual(stored);
      expect(await store.getGoldenFingerprint("skill/other")).toBeNull();
    });

    it("a regression replaces the last verdict and keeps the base; a later pass moves the base", async () => {
      const { store, clock } = await make();
      await store.recordGoldenVerdict(verdict("fp1", "pass", 1));
      clock.advance(1000);
      expect(await store.recordGoldenVerdict(verdict("fp2", "regression", 0, ["643"]))).toEqual({
        ...verdict("fp2", "regression", 0, ["643"]), base_fingerprint: "fp1", base_rate: 1, at: clock.now().toISOString(),
      });
      // The same verdict again (another replica) leaves one row, unchanged.
      expect((await store.recordGoldenVerdict(verdict("fp2", "regression", 0, ["643"]))).base_fingerprint).toBe("fp1");
      const moved = await store.recordGoldenVerdict(verdict("fp3", "pass", 0.5));
      expect([moved.fingerprint, moved.verdict, moved.base_fingerprint, moved.base_rate, moved.failing_cases]).toEqual(["fp3", "pass", "fp3", 0.5, []]);
    });
  });

  describe("app command requests (migration 23)", () => {
    const owner = "github:1" as UserId;
    const req = (key: string, over: { command?: string; args?: Record<string, unknown> } = {}) => ({
      key, actor: owner, command: over.command ?? "approve", args: over.args ?? { work_item_id: "wi_1" },
    });

    it("record stores a pending request; the same key again stores nothing and reports the first", async () => {
      const { store, clock } = await make();
      const first = await store.recordAppCommandRequest(req("k1", { args: { work_item_id: "wi_1", note: "small" } }));
      expect(first).toEqual({
        created: true,
        request: {
          seq: first.request.seq, key: "k1", actor: owner, command: "approve", args: { work_item_id: "wi_1", note: "small" },
          created_at: clock.now().toISOString(), handled_at: null, refusal: null,
        },
      });
      const again = await store.recordAppCommandRequest(req("k1", { command: "reject" }));
      expect(again).toEqual({ created: false, request: first.request });
      expect(await store.getAppCommandRequest(first.request.seq)).toEqual(first.request);
      expect(await store.getAppCommandRequest(first.request.seq + 1000)).toBeNull();
    });

    it("each request's seq is greater than the ones recorded before it", async () => {
      const { store } = await make();
      const seqs: number[] = [];
      for (const k of ["a", "b", "c", "d"]) seqs.push((await store.recordAppCommandRequest(req(k))).request.seq);
      expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
    });

    it("a conditional mark sets handled_at and the refusal once; a second mark changes nothing", async () => {
      const { store, clock } = await make();
      const { request } = await store.recordAppCommandRequest(req("k1"));
      clock.advance(1000);
      const markedAt = clock.now().toISOString();
      expect(await store.markAppCommandRequest(request.seq, "`approve` was not applied: no.")).toBe(true);
      clock.advance(1000);
      expect(await store.markAppCommandRequest(request.seq, null)).toBe(false);
      expect(await store.markAppCommandRequest(request.seq, "other")).toBe(false);
      expect(await store.getAppCommandRequest(request.seq)).toEqual({
        ...request, handled_at: markedAt, refusal: "`approve` was not applied: no.",
      });
      // An applied request keeps a null refusal; an unknown seq marks nothing.
      const applied = (await store.recordAppCommandRequest(req("k2"))).request;
      expect(await store.markAppCommandRequest(applied.seq, null)).toBe(true);
      expect(await store.getAppCommandRequest(applied.seq)).toMatchObject({ handled_at: clock.now().toISOString(), refusal: null });
      expect(await store.markAppCommandRequest(applied.seq + 1000, null)).toBe(false);
    });

    it("two concurrent marks of one request: exactly one wins", async () => {
      const { store } = await make();
      const { request } = await store.recordAppCommandRequest(req("k1"));
      const r = await Promise.all([store.markAppCommandRequest(request.seq, "a"), store.markAppCommandRequest(request.seq, "b")]);
      expect(r.filter(Boolean)).toHaveLength(1);
      const stored = (await store.getAppCommandRequest(request.seq))!;
      expect(stored.refusal).toBe(r[0] ? "a" : "b");
    });

    it("the per-item read lists one item's requests, handled or not, oldest first, the newest `limit`", async () => {
      const { store } = await make();
      const a = (await store.recordAppCommandRequest(req("a", { args: { work_item_id: "wi_1", note: "n" } }))).request;
      await store.recordAppCommandRequest(req("other", { args: { work_item_id: "wi_10" } }));
      // `_` and `%` in an id are matched literally, not as LIKE wildcards.
      await store.recordAppCommandRequest(req("wild", { args: { work_item_id: "wiX1" } }));
      await store.recordAppCommandRequest(req("pct", { args: { work_item_id: "%" } }));
      const b = (await store.recordAppCommandRequest(req("b", { command: "reject", args: { note: "x", work_item_id: "wi_1" } }))).request;
      await store.markAppCommandRequest(a.seq, "no");
      const c = (await store.recordAppCommandRequest(req("c"))).request;
      const got = await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 10);
      expect(got.map((r) => r.key)).toEqual(["a", "b", "c"]);
      expect(got[0]).toMatchObject({ seq: a.seq, refusal: "no" });
      expect(got[0]!.handled_at).not.toBeNull();
      expect((await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 2)).map((r) => r.seq)).toEqual([b.seq, c.seq]);
      expect(await store.listAppCommandRequestsForItem("wi_1" as WorkItemId, 0)).toEqual([]);
      expect(await store.listAppCommandRequestsForItem("wi_nope" as WorkItemId, 10)).toEqual([]);
      expect((await store.listAppCommandRequestsForItem("%" as WorkItemId, 10)).map((r) => r.key)).toEqual(["pct"]);
    });

    it("the item's commands: CLI (args.item) and dashboard (args.work_item_id) rows oldest first, never another item's or a comment's", async () => {
      const { store } = await make();
      const base = { actor: "local:me" as UserId, command: "revise" };
      await store.appendCliCommand({ ...base, key: "cli:a", args: { item: "wi_1", text: "t" } });
      await store.recordAppCommandRequest(req("b", { args: { work_item_id: "wi_1", note: "n" } }));
      await store.appendCliCommand({ ...base, key: "cli:other", args: { item: "wi_10" } });
      await store.appendCliCommand({ ...base, key: "github:1", args: { item: "wi_1" } });
      await store.appendCliCommand({ ...base, key: "cli:pct", args: { item: "%" } });
      expect((await store.listItemCommands("wi_1" as WorkItemId, 10)).map((c) => [c.key, c.origin])).toEqual([["cli:a", "cli"], ["b", "app"]]);
      expect((await store.listItemCommands("wi_1" as WorkItemId, 1)).map((c) => c.key)).toEqual(["b"]);
      expect((await store.listItemCommands("%" as WorkItemId, 10)).map((c) => c.key)).toEqual(["cli:pct"]);
    });
  });

  // Plain tasks (design 02-tasks): updateTask, deleteTask and addSubTask take plain arguments, so the CLI, chat and a
  // later HTTP route call the same methods; each write is conditional and a refusal writes nothing.
  describe("plain tasks: edit, delete and sub-tasks", () => {
    const by = "local:dev@example.com" as UserId;
    const plain = (id: string, over: Partial<NewTask> = {}): NewTask => ({
      id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: by, ...over,
    });
    const rows = (store: { db: SqlDriver }) => store.db.all("SELECT * FROM controller_tasks ORDER BY id");

    it("updateTask changes only the named fields, resolves today with the Clock and is safe to repeat", async () => {
      const { store } = await make(new FakeClock("2026-11-11T12:00:00.000Z"));
      const before = await store.addTask(plain("tk_a", { title: "pay rent", list: "home", priority: 2, due: { date: "2026-12-01" }, due_time: "08:30" }));
      const r = await store.updateTask("tk_a", { priority: 1, due: { days_from_today: 1 } });
      expect(r).toEqual({ ok: true, task: { ...before, priority: 1, due_date: localDate(new Date("2026-11-11T12:00:00.000Z"), 1) } });
      expect(await store.updateTask("tk_a", { priority: 1, due: { days_from_today: 1 } })).toEqual(r);
      expect(await store.updateTask("tk_a", { title: "pay the rent" })).toMatchObject({ ok: true, task: { title: "pay the rent", list: "home", priority: 1 } });
    });

    it("updateTask refuses an unknown task, a done task and a recurrence with no due date, writing nothing", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_a"));
      await store.addTask(plain("tk_b"));
      await store.completeTask("tk_b");
      const before = await rows(store);
      expect(await store.updateTask("tk_nope", { priority: 1 })).toEqual({ ok: false, reason: "not_found" });
      expect(await store.updateTask("tk_b", { priority: 1 })).toEqual({ ok: false, reason: "done" });
      expect(await store.updateTask("tk_a", { recurrence: "week" })).toEqual({ ok: false, reason: "needs_due_date", recurrence: "week" });
      expect(await rows(store)).toEqual(before);
    });

    it("updateTask with a time alone on an undated task makes it due today, as quick-add does", async () => {
      const { store } = await make(new FakeClock("2026-11-11T12:00:00.000Z"));
      await store.addTask(plain("tk_a"));
      expect(await store.updateTask("tk_a", { due_time: "09:00" })).toMatchObject({
        ok: true, task: { due_date: localDate(new Date("2026-11-11T12:00:00.000Z")), due_time: "09:00" },
      });
    });

    it("addSubTask stores parent_task_id, keeps parent_id null, is idempotent on the ID and goes one level deep", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_p"));
      const r = await store.addSubTask("tk_p", plain("tk_s"));
      expect(r).toMatchObject({ ok: true, task: { id: "tk_s", parent_task_id: "tk_p", parent_id: null } });
      expect(await store.addSubTask("tk_p", plain("tk_s", { title: "other" }))).toEqual(r);
      const before = await rows(store);
      expect(await store.addSubTask("tk_s", plain("tk_x"))).toEqual({ ok: false, reason: "nested" });
      expect(await store.addSubTask("tk_nope", plain("tk_y"))).toEqual({ ok: false, reason: "not_found" });
      expect(await rows(store)).toEqual(before);
      expect((await store.addTask(plain("tk_q"))).parent_task_id).toBeNull();
    });

    it("completing a parent or a sub-task completes only that task", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_p"));
      await store.addSubTask("tk_p", plain("tk_s1"));
      await store.addSubTask("tk_p", plain("tk_s2"));
      await store.completeTask("tk_s1");
      expect((await store.getTask("tk_p"))!.done_at).toBeNull();
      await store.completeTask("tk_p");
      expect((await store.getTask("tk_s2"))!.done_at).toBeNull();
    });

    it("deleteTask hard-deletes; a second delete is not_found and writes nothing", async () => {
      const { store } = await make();
      const t = await store.addTask(plain("tk_a"));
      await store.addTask(plain("tk_b"));
      expect(await store.deleteTask("tk_a")).toEqual({ ok: true, task: t, detached: [], deleted: [] });
      const after = await rows(store);
      expect(after.map((r) => r.id)).toEqual(["tk_b"]);
      expect(await store.deleteTask("tk_a")).toEqual({ ok: false, reason: "not_found" });
      expect(await rows(store)).toEqual(after);
    });

    it("deleteTask refuses while open sub-tasks remain, naming them; with only done ones it detaches them", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_p"));
      await store.addSubTask("tk_p", plain("tk_s1"));
      await store.addSubTask("tk_p", plain("tk_s2"));
      await store.completeTask("tk_s1");
      const before = await rows(store);
      const refused = await store.deleteTask("tk_p");
      expect(refused).toMatchObject({ ok: false, reason: "open_sub_tasks" });
      expect(refused.ok === false && refused.reason === "open_sub_tasks" ? refused.sub_tasks.map((s) => s.id) : null).toEqual(["tk_s2"]);
      expect(await rows(store)).toEqual(before);
      await store.completeTask("tk_s2");
      const done = await rows(store);
      const r = await store.deleteTask("tk_p");
      expect(r.ok && r.detached.map((s) => [s.id, s.parent_task_id])).toEqual([["tk_s1", null], ["tk_s2", null]]);
      expect(await rows(store)).toEqual(done.filter((x) => x.id !== "tk_p").map((x) => ({ ...x, parent_task_id: null })));
    });

    it("deleteTask with with_sub_tasks deletes the parent and every sub-task, open and done, with their project links, in one write", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_home", name: "Home", created_by: by });
      await store.addTask(plain("tk_p"));
      await store.addSubTask("tk_p", plain("tk_s1", { projects: ["home"] }));
      await store.addSubTask("tk_p", plain("tk_s2"));
      await store.addTask(plain("tk_other"));
      await store.completeTask("tk_s1");
      const { item } = await store.createWorkItem(issue(9101), system);
      await store.linkTask("tk_p", item.id);
      await store.linkTask("tk_s2", item.id);
      const r = await store.deleteTask("tk_p", { with_sub_tasks: true });
      expect(await store.getWorkItem(item.id)).toEqual(item);
      expect(r).toMatchObject({ ok: true, task: { id: "tk_p" }, detached: [] });
      expect(r.ok && r.deleted.map((s) => s.id)).toEqual(["tk_s1", "tk_s2"]);
      expect((await rows(store)).map((x) => x.id)).toEqual(["tk_other"]);
      expect(await store.listTaskProjectSlugs(["tk_s1"])).toEqual({});
      expect(await store.deleteTask("tk_p", { with_sub_tasks: true })).toEqual({ ok: false, reason: "not_found" });
    });

    it("deleteTask with with_sub_tasks on a task with none deletes it alone; with_sub_tasks false refuses as a plain delete", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_a"));
      await store.addTask(plain("tk_p"));
      await store.addSubTask("tk_p", plain("tk_s"));
      expect(await store.deleteTask("tk_a", { with_sub_tasks: true })).toMatchObject({ ok: true, detached: [], deleted: [] });
      const before = await rows(store);
      expect(await store.deleteTask("tk_p", { with_sub_tasks: false })).toMatchObject({ ok: false, reason: "open_sub_tasks" });
      expect(await rows(store)).toEqual(before);
    });

    it("countOpenSubTasks counts each parent's open sub-tasks over every stored task, leaving out done ones and parents with none", async () => {
      const { store } = await make();
      await store.addTask(plain("tk_p"));
      await store.addTask(plain("tk_q"));
      await store.addTask(plain("tk_r"));
      await store.addSubTask("tk_p", plain("tk_p1"));
      await store.addSubTask("tk_p", plain("tk_p2"));
      await store.addSubTask("tk_q", plain("tk_q1"));
      await store.completeTask("tk_q1");
      const counts = await store.countOpenSubTasks();
      expect(counts.tk_p).toBe(2);
      expect(counts.tk_q).toBeUndefined();
      expect(counts.tk_r).toBeUndefined();
    });
  });

  // Interactive sessions (design §5, 2026-11-01): the actor, transcript and token fields are run columns (migration
  // 18 on both backends); notes and the last finish live in the run's input.
  describe("interactive sessions", () => {
    const person = { kind: "user" as const, id: "github:5" as UserId };
    const seed = async (store: FactoryStore, n: number, paths: string[]) => {
      const { item } = await store.createWorkItem(issue(n), system, { enqueue: { kind: "triage", idempotency_key: `t${n}` } });
      const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { allowed_paths: paths } });
      if (!r.ok) throw new Error(r.reason);
      return r.item;
    };
    /** max_cost 1: one shared ordinary file (1.0) holds, as every shared path did before the cost rule (2026-11-21). */
    const STRICT = { ...DEFAULT_COORDINATION, max_cost: 1 };
    const start = (store: FactoryStore, it: { id: WorkItemId; version: number }, coordination?: typeof STRICT) => store.startSession({
      id: it.id, expected_version: it.version, actor: person, patch: { stage: "RUNNING" }, reason: "session_started", detail: { spec_source: "owner" },
      owner: "session:h:1", lease_ms: LEASE, transcript_url: "https://example.com/t", ...(coordination ? { coordination } : {}),
    });

    it("startSession writes one running interactive run and the transition and cancels queued triage; other runs read the fields as null", async () => {
      const { store } = await make();
      const it0 = await seed(store, 1, ["src/a/"]);
      expect((await store.listRuns(it0.id))[0]).toMatchObject({ actor_id: null, transcript_url: null, session_tokens: null, session_notes: [], last_finish: null });
      const r = await start(store, it0);
      if (!r.ok) throw new Error(r.reason);
      expect(r.run).toMatchObject({ kind: "interactive", status: "running", attempt: 1, actor_id: "github:5", transcript_url: "https://example.com/t", lease: { owner: "session:h:1", token: 1 } });
      expect(r.state_change).toMatchObject({ reason: "session_started", actor: person, detail: { spec_source: "owner", run_id: r.run.id } });
      expect([r.item.stage, r.cancelled.length]).toEqual(["RUNNING", 1]);
      expect((await store.listRuns(it0.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "cancelled"], ["interactive", "running"]]);
      expect((await store.listRunsByKind("interactive", ["running"])).map((x) => x.id)).toEqual([r.run.id]);
      // Refused with nothing written: stale version, open session, implement-type run, overlap with another item's session.
      expect(await start(store, { id: it0.id, version: it0.version })).toMatchObject({ ok: false, reason: "version_conflict" });
      expect(await start(store, r.item)).toMatchObject({ ok: false, reason: "session_open", run_id: r.run.id });
      const it1 = await seed(store, 2, ["src/b/"]);
      const q = await store.transition({ id: it1.id, expected_version: it1.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "implement", idempotency_key: "i2" } });
      if (!q.ok) throw new Error(q.reason);
      // A queued implement-type run is taken over in the same transaction, with the takeover outcome (no attempt).
      const t = await start(store, q.item);
      if (!t.ok) throw new Error(t.reason);
      expect(t.taken_over).toEqual([q.enqueued!.id]);
      expect(t.state_change.detail).toMatchObject({ taken_over: q.enqueued!.id, run_id: t.run.id });
      expect(await store.getRun(q.enqueued!.id)).toMatchObject({ status: "cancelled", outcome: { status: "failed", error_code: "interactive_takeover", infra: false } });
      // A running implement-type run refuses, and the item's queued runs stay queued.
      const it3 = await seed(store, 4, ["src/c/"]);
      const w = await store.transition({ id: it3.id, expected_version: it3.version, actor: system, reason: "x", patch: { stage: "RUNNING" }, enqueue: { kind: "implement", idempotency_key: "i4" } });
      if (!w.ok) throw new Error(w.reason);
      expect((await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))?.id).toBe(w.enqueued!.id);
      const u = await store.transition({ id: it3.id, expected_version: w.item.version, actor: system, reason: "x", patch: {}, enqueue: { kind: "update", idempotency_key: "u4" } });
      if (!u.ok) throw new Error(u.reason);
      expect(await start(store, u.item)).toMatchObject({ ok: false, reason: "implement_run", run_id: w.enqueued!.id });
      expect((await store.getRun(u.enqueued!.id))!.status).toBe("queued");
      const it2 = await seed(store, 3, ["src/a/x.ts"]);
      const before = JSON.stringify([await store.listRuns(it2.id), await store.listStateChanges(it2.id)]);
      expect(await start(store, it2, STRICT)).toMatchObject({ ok: false, reason: "overlap", work_item_id: it0.id, paths: ["src/a/x.ts"], cost: 1, max_cost: 1 });
      expect(JSON.stringify([await store.listRuns(it2.id), await store.listStateChanges(it2.id)])).toBe(before);
      // At the default max_cost (2.5) one shared ordinary file (1.0) does not refuse.
      expect(await start(store, it2)).toMatchObject({ ok: true });
    });

    it("updateSession writes notes, tokens, transcript and the last finish only while the lease is held", async () => {
      const { store } = await make();
      const r = await start(store, await seed(store, 1, ["src/a/"]));
      if (!r.ok) throw new Error(r.reason);
      await store.updateSession(r.run.id, 1, { note: "first" });
      const u = await store.updateSession(r.run.id, 1, { note: "second", tokens: 120, transcript_url: "https://example.com/u", last_finish: { ok: false, reasons: ["tests"], pr_number: null } });
      if (!u.ok) throw new Error(u.reason);
      expect(u.run).toMatchObject({ session_tokens: 120, transcript_url: "https://example.com/u", last_finish: { ok: false, reasons: ["tests"], pr_number: null } });
      expect(u.run.session_notes.map((n) => n.text)).toEqual(["first", "second"]);
      expect(await store.updateSession(r.run.id, 2, { tokens: 1 })).toEqual({ ok: false, reason: "lease_lost" });
      await store.completeRun(r.run.id, 1, { status: "failed", error_code: "abandoned", detail: "", infra: false });
      expect(await store.updateSession(r.run.id, 1, { tokens: 1 })).toEqual({ ok: false, reason: "lease_lost" });
      expect((await store.getRun(r.run.id))!.session_tokens).toBe(120);
    });

    it("claims never take a session or an implement run overlapping it; the reaper fails an expired session with session_lost", async () => {
      const { store, clock } = await make();
      const s = await start(store, await seed(store, 1, ["src/a/"]));
      if (!s.ok) throw new Error(s.reason);
      const it1 = await seed(store, 2, ["src/a/y.ts"]);
      await store.transition({ id: it1.id, expected_version: it1.version, actor: system, reason: "x", patch: { stage: "RUNNING" }, enqueue: { kind: "implement", idempotency_key: "i2" } });
      expect(await store.claimRun({ worker_id: w1, kinds: ["interactive", "implement", "update"], lease_ms: LEASE, coordination: STRICT })).toBeNull();
      clock.advance(LEASE + 1);
      expect(await store.expireLeases(5)).toEqual([s.run.id]);
      expect(await store.getRun(s.run.id)).toMatchObject({ status: "failed", lease: null, outcome: { status: "failed", error_code: "session_lost" } });
      // The session start opened the run's one attempt record; the reaper closed it with the run's code.
      expect((await store.listRunAttempts(s.item.id)).map((a) => [a.attempt, a.status, a.error_code, a.failure_class])).toEqual([
        [1, "failed", "session_lost", "task"],
      ]);
      expect((await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))?.work_item_id).toBe(it1.id);
    });

    it("a session start and a claim next to an open session use the workers' cost: mechanical paths and unnamed shared indexes never hold, a hotspot does", async () => {
      const { store } = await make();
      const plan = async (n: number, files: string[], allowed = files) => {
        const it = await seed(store, n, allowed);
        const r = await store.transition({ id: it.id, expected_version: it.version, actor: system, reason: "x", patch: { files_to_change: files } });
        if (!r.ok) throw new Error(r.reason);
        return r.item;
      };
      // Two plans on different pages' text, both allowed the shared indexes (covering folders), sharing two design topics (mechanical, 0.5).
      const shared = ["docs/design/", "docs/design.md", "web/src/i18n/"];
      const s = await start(store, await plan(1, ["web/src/views/tasks.tsx", "web/src/i18n/en/tasks.ts", "docs/design/04-triage.md", "docs/design/history/04-triage.md"], [...shared, "web/src/views/tasks.tsx"]));
      if (!s.ok) throw new Error(s.reason);
      const page = await plan(2, ["web/src/views/rules.tsx", "web/src/i18n/en/rules.ts", "docs/design/04-triage.md", "docs/design/history/04-triage.md"], [...shared, "web/src/views/rules.tsx"]);
      expect(await start(store, page)).toMatchObject({ ok: true });
      // A queued implement run of a third plan sharing the same design topics is claimed next to both sessions.
      const third = await plan(3, ["src/a.ts", "docs/design/04-triage.md"]);
      const q = await store.transition({ id: third.id, expected_version: third.version, actor: system, reason: "x", patch: { stage: "RUNNING" }, enqueue: { kind: "implement", idempotency_key: "i3" } });
      if (!q.ok) throw new Error(q.reason);
      expect((await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: LEASE }))?.work_item_id).toBe(third.id);
      // A plan that names a hotspot another running item names (3.0) is refused, naming the cost.
      const hot = await plan(4, ["src/worker/x.ts"]);
      await plan(5, ["src/worker/x.ts"]).then((it) => start(store, it));
      expect(await start(store, hot)).toMatchObject({ ok: false, reason: "overlap", paths: ["src/worker/x.ts"], cost: 3, max_cost: 2.5 });
    });

    // A waiting `session start --wait` reserves its NEW item (design 05-interactive-sessions, 2026-11-21).
    describe("reservations", () => {
      const HOURS_2 = 2 * 60 * 60 * 1000;
      const reserve = (store: FactoryStore, id: WorkItemId, owner = "session:h:1") => store.reserveItem({ id, owner, ttl_ms: HOURS_2 });
      const claimTriage = (store: FactoryStore, worker = w1) => store.claimRun({ worker_id: worker, kinds: ["triage"], lease_ms: LEASE });

      it("while a reservation holds no worker claims the item's queued triage run; other items' runs still claim", async () => {
        const { store } = await make();
        const it0 = await seed(store, 1, ["src/a/"]);
        const r = await reserve(store, it0.id);
        expect(r).toMatchObject({ ok: true, reservation: { work_item_id: it0.id, owner: "session:h:1" } });
        for (const worker of [w1, w2]) expect(await claimTriage(store, worker)).toBeNull();
        const other = await seed(store, 2, ["src/b/"]);
        expect((await claimTriage(store, w2))?.work_item_id).toBe(other.id);
        expect((await store.listRuns(it0.id)).map((x) => x.status)).toEqual(["queued"]);
        expect(await store.getReservation(it0.id)).toEqual(r.ok ? r.reservation : null);
      });

      it("a reservation older than 2 hours ends: the claim deletes it and triage claims the item", async () => {
        const { store, clock } = await make();
        const it0 = await seed(store, 1, ["src/a/"]);
        await reserve(store, it0.id);
        clock.advance(HOURS_2 - 1);
        expect(await claimTriage(store)).toBeNull();
        clock.advance(1);
        expect((await claimTriage(store))?.work_item_id).toBe(it0.id);
        expect(await store.getReservation(it0.id)).toBeNull();
        expect(await store.releaseReservation(it0.id, "session:h:1")).toBe(false);
      });

      it("only the owner starts a session on a reserved item; the start ends the reservation; another owner is refused naming it", async () => {
        const { store } = await make();
        const it0 = await seed(store, 1, ["src/a/"]);
        const r = await reserve(store, it0.id);
        if (!r.ok) throw new Error(r.reason);
        expect(await reserve(store, it0.id, "session:h:2")).toEqual({ ok: false, reason: "reserved", reservation: r.reservation });
        expect(await reserve(store, it0.id)).toEqual(r); // the owner's own: kept as it is, not renewed
        const before = JSON.stringify(await store.listRuns(it0.id));
        const other = await store.startSession({
          id: it0.id, expected_version: it0.version, actor: person, patch: { stage: "RUNNING" }, reason: "session_started", detail: {}, owner: "session:h:2", lease_ms: LEASE, transcript_url: null,
        });
        expect(other).toEqual({ ok: false, reason: "reserved", reservation: r.reservation });
        expect(JSON.stringify(await store.listRuns(it0.id))).toBe(before);
        expect(await store.releaseReservation(it0.id, "session:h:2")).toBe(false);
        const s = await start(store, it0); // owner session:h:1
        expect(s).toMatchObject({ ok: true });
        expect(await store.getReservation(it0.id)).toBeNull();
      });

      it("a release leaves no reservation; only a NEW item nothing blocks is reserved", async () => {
        const { store } = await make();
        const it0 = await seed(store, 1, ["src/a/"]);
        await reserve(store, it0.id);
        expect(await store.releaseReservation(it0.id, "session:h:1")).toBe(true);
        expect(await store.getReservation(it0.id)).toBeNull();
        expect((await claimTriage(store))?.work_item_id).toBe(it0.id);
        const running = await seed(store, 2, ["src/b/"]);
        const t = await store.transition({ id: running.id, expected_version: running.version, actor: system, reason: "x", patch: { stage: "RUNNING" } });
        if (!t.ok) throw new Error(t.reason);
        expect(await reserve(store, running.id)).toEqual({ ok: false, reason: "not_new" });
        expect(await reserve(store, "wi_none" as WorkItemId)).toEqual({ ok: false, reason: "not_found" });
      });
    });
  });

  // Task projects: create, rename, archive, restore, membership, delete and listTaskProjects take plain arguments and
  // are conditional writes, so a repeat changes nothing more (phase 1); task writes link `+slug` projects (phase 2).
  describe("task projects", () => {
    const by = "local:dev@example.com" as UserId;
    const task = (id: string): NewTask => ({ id, title: id, list: null, priority: null, due: null, due_time: null, recurrence: null, created_by: by });
    const links = (store: { db: SqlDriver }) => store.db.all("SELECT task_id, project_id FROM controller_task_projects ORDER BY project_id, task_id");
    const slugs = (ps: readonly { slug: string }[]) => ps.map((p) => p.slug);

    it("createProject stores the cleaned name, its slug and the Clock's time, and answers a repeated ID as stored", async () => {
      const { store } = await make(new FakeClock("2026-11-14T09:00:00.000Z"));
      const r = await store.createProject({ id: "pj_a", name: "  Home   repairs ", created_by: by });
      const project = { id: "pj_a", slug: "home-repairs", name: "Home repairs", created_by: by, created_at: "2026-11-14T09:00:00.000Z", archived_at: null, base_folder: null };
      expect(r).toEqual({ ok: true, project });
      expect(await store.createProject({ id: "pj_a", name: "Something else", created_by: by })).toEqual({ ok: true, project });
      expect(await store.getProject("pj_a")).toEqual(project);
      expect(await store.getProject("pj_nope")).toBeNull();
    });

    it("createProject refuses a bad name and a taken slug, writing nothing", async () => {
      const { store } = await make();
      const held = await store.createProject({ id: "pj_a", name: "Home repairs", created_by: by });
      expect(await store.createProject({ id: "pj_b", name: "   ", created_by: by })).toMatchObject({ ok: false, reason: "invalid_name" });
      expect(await store.createProject({ id: "pj_b", name: "HOME  Repairs!", created_by: by })).toEqual({
        ok: false, reason: "slug_taken", project: held.ok ? held.project : null,
      });
      expect(await store.getProject("pj_b")).toBeNull();
      expect(slugs(await store.listProjects("active"))).toEqual(["home-repairs"]);
    });

    it("renameProject changes the name and slug, refuses a bad name, a taken slug and an unknown project", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      const r = await store.renameProject("pj_a", "Home repairs");
      expect(r).toMatchObject({ ok: true, project: { id: "pj_a", name: "Home repairs", slug: "home-repairs" } });
      expect(await store.renameProject("pj_a", "Home repairs")).toEqual(r);
      expect(await store.renameProject("pj_a", "home REPAIRS")).toMatchObject({ ok: true, project: { name: "home REPAIRS", slug: "home-repairs" } });
      expect(await store.renameProject("pj_a", "work")).toMatchObject({ ok: false, reason: "slug_taken", project: { id: "pj_b" } });
      expect(await store.renameProject("pj_a", "\n")).toMatchObject({ ok: false, reason: "invalid_name" });
      expect(await store.renameProject("pj_nope", "Fine")).toEqual({ ok: false, reason: "not_found" });
      expect(await store.getProject("pj_a")).toMatchObject({ name: "home REPAIRS", slug: "home-repairs" });
    });

    it("listProjects lists active projects by slug, and archived ones apart", async () => {
      const { store } = await make();
      for (const [id, name] of [["pj_1", "Zebra"], ["pj_2", "apple"], ["pj_3", "Mango"]] as const) await store.createProject({ id, name, created_by: by });
      expect(slugs(await store.listProjects("active"))).toEqual(["apple", "mango", "zebra"]);
      expect(await store.listProjects("archived")).toEqual([]);
    });

    it("archive hides a project from listings but keeps its links; restore brings it back with the same links", async () => {
      const { store, clock } = await make(new FakeClock("2026-11-14T09:00:00.000Z"));
      await store.addTask(task("tk_a"));
      await store.addTask(task("tk_b"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      await store.addTaskToProject("pj_a", "tk_a");
      await store.addTaskToProject("pj_a", "tk_b");
      await store.addTaskToProject("pj_b", "tk_a");
      const linked = await links(store);

      clock.advance(1000);
      const archived = await store.archiveProject("pj_a");
      expect(archived).toMatchObject({ ok: true, changed: true, project: { id: "pj_a", archived_at: "2026-11-14T09:00:01.000Z" } });
      clock.advance(1000);
      expect(await store.archiveProject("pj_a")).toEqual({ ...archived, changed: false });
      expect(slugs(await store.listProjects("active"))).toEqual(["work"]);
      expect(slugs(await store.listProjects("archived"))).toEqual(["home"]);
      expect(slugs(await store.listTaskProjects("tk_a"))).toEqual(["work"]);
      expect(await store.listTaskProjects("tk_b")).toEqual([]);
      expect(await links(store)).toEqual(linked);

      const restored = await store.restoreProject("pj_a");
      expect(restored).toMatchObject({ ok: true, changed: true, project: { id: "pj_a", archived_at: null } });
      expect(await store.restoreProject("pj_a")).toEqual({ ...restored, changed: false });
      expect(slugs(await store.listProjects("active"))).toEqual(["home", "work"]);
      expect(slugs(await store.listTaskProjects("tk_a"))).toEqual(["home", "work"]);
      expect(slugs(await store.listTaskProjects("tk_b"))).toEqual(["home"]);
      expect(await links(store)).toEqual(linked);
      expect(await store.archiveProject("pj_nope")).toEqual({ ok: false, reason: "not_found" });
      expect(await store.restoreProject("pj_nope")).toEqual({ ok: false, reason: "not_found" });
    });

    it("setProjectFolder stores the folder on an active project and refuses an unknown or archived one, writing nothing", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      expect(await store.setProjectFolder("pj_a", "/srv/home")).toMatchObject({ ok: true, project: { id: "pj_a", base_folder: "/srv/home" } });
      expect(await store.setProjectFolder("pj_a", "/srv/home")).toMatchObject({ ok: true, project: { base_folder: "/srv/home" } });
      expect(await store.getProject("pj_a")).toMatchObject({ base_folder: "/srv/home" });
      expect(await store.getProject("pj_b")).toMatchObject({ base_folder: null });
      expect(await store.setProjectFolder("pj_nope", "/srv/x")).toEqual({ ok: false, reason: "not_found" });
      await store.archiveProject("pj_b");
      expect(await store.setProjectFolder("pj_b", "/srv/work")).toEqual({ ok: false, reason: "archived" });
      expect(await store.getProject("pj_b")).toMatchObject({ base_folder: null });
      expect(await store.getProjectBySlug("home")).toMatchObject({ base_folder: "/srv/home" });
    });

    it("addTaskToProject links once, refuses an unknown task or project and an archived project; removeTaskFromProject unlinks once", async () => {
      const { store } = await make();
      await store.addTask(task("tk_a"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_old", name: "Old", created_by: by });
      await store.archiveProject("pj_old");
      expect(await store.addTaskToProject("pj_a", "tk_a")).toEqual({ ok: true, changed: true });
      expect(await store.addTaskToProject("pj_a", "tk_a")).toEqual({ ok: true, changed: false });
      expect(await store.addTaskToProject("pj_nope", "tk_a")).toEqual({ ok: false, reason: "project_not_found" });
      expect(await store.addTaskToProject("pj_a", "tk_nope")).toEqual({ ok: false, reason: "task_not_found" });
      expect(await store.addTaskToProject("pj_old", "tk_a")).toEqual({ ok: false, reason: "archived" });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_a" }]);
      expect(slugs(await store.listTaskProjects("tk_a"))).toEqual(["home"]);

      expect(await store.removeTaskFromProject("pj_a", "tk_a")).toBe(true);
      expect(await store.removeTaskFromProject("pj_a", "tk_a")).toBe(false);
      expect(await links(store)).toEqual([]);
      expect(await store.listTaskProjects("tk_a")).toEqual([]);
    });

    it("moveTaskToProject takes the task out of one project and into another in one write; a repeat changes nothing more", async () => {
      const { store } = await make(new FakeClock("2026-11-15T09:00:00.000Z"));
      await store.addTask(task("tk_a"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      await store.createProject({ id: "pj_c", name: "Side", created_by: by });
      await store.addTaskToProject("pj_a", "tk_a");
      await store.addTaskToProject("pj_c", "tk_a");
      expect(await store.moveTaskToProject("tk_a", "pj_a", "pj_b")).toEqual({ ok: true, changed: true });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_b" }, { task_id: "tk_a", project_id: "pj_c" }]);
      expect((await store.db.all("SELECT added_at FROM controller_task_projects WHERE project_id = 'pj_b'"))[0]).toEqual({ added_at: "2026-11-15T09:00:00.000Z" });
      expect(await store.moveTaskToProject("tk_a", "pj_a", "pj_b")).toEqual({ ok: true, changed: false });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_b" }, { task_id: "tk_a", project_id: "pj_c" }]);
      // Into a project it is in already: the source link goes, the target link stays as it was.
      expect(await store.moveTaskToProject("tk_a", "pj_c", "pj_b")).toEqual({ ok: true, changed: true });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_b" }]);
      expect(await store.moveTaskToProject("tk_a", "pj_b", "pj_b")).toEqual({ ok: true, changed: false });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_b" }]);
    });

    it("moveTaskToProject refuses an unknown task, an unlinked source, an unknown or archived target, writing nothing", async () => {
      const { store } = await make();
      await store.addTask(task("tk_a"));
      await store.addTask(task("tk_b"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      await store.createProject({ id: "pj_old", name: "Old", created_by: by });
      await store.archiveProject("pj_old");
      await store.addTaskToProject("pj_a", "tk_a");
      const before = await links(store);
      expect(await store.moveTaskToProject("tk_nope", "pj_a", "pj_b")).toEqual({ ok: false, reason: "task_not_found" });
      expect(await store.moveTaskToProject("tk_b", "pj_a", "pj_b")).toEqual({ ok: false, reason: "not_linked" });
      expect(await store.moveTaskToProject("tk_a", "pj_nope", "pj_b")).toEqual({ ok: false, reason: "not_linked" });
      expect(await store.moveTaskToProject("tk_a", "pj_a", "pj_nope")).toEqual({ ok: false, reason: "project_not_found" });
      expect(await store.moveTaskToProject("tk_a", "pj_a", "pj_old")).toEqual({ ok: false, reason: "archived" });
      expect(await links(store)).toEqual(before);
    });

    it("deleteProject removes the project and its links only, leaving the tasks and other projects' links as they were", async () => {
      const { store } = await make();
      await store.addTask(task("tk_a"));
      await store.addTask(task("tk_b"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      await store.addTaskToProject("pj_a", "tk_a");
      await store.addTaskToProject("pj_a", "tk_b");
      await store.addTaskToProject("pj_b", "tk_a");
      const tasksBefore = await store.db.all("SELECT * FROM controller_tasks ORDER BY id");

      const r = await store.deleteProject("pj_a");
      expect(r).toMatchObject({ ok: true, project: { id: "pj_a", slug: "home" }, unlinked: ["tk_a", "tk_b"] });
      expect(await store.deleteProject("pj_a")).toEqual({ ok: false, reason: "not_found" });
      expect(await store.getProject("pj_a")).toBeNull();
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_b" }]);
      expect(await store.db.all("SELECT * FROM controller_tasks ORDER BY id")).toEqual(tasksBefore);
      // The slug is free again.
      expect(await store.createProject({ id: "pj_c", name: "Home", created_by: by })).toMatchObject({ ok: true, project: { id: "pj_c" } });
    });

    it("deleteTask drops the task's project links and leaves the projects", async () => {
      const { store } = await make();
      await store.addTask(task("tk_a"));
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.addTaskToProject("pj_a", "tk_a");
      expect(await store.deleteTask("tk_a")).toMatchObject({ ok: true });
      expect(await links(store)).toEqual([]);
      expect(await store.listTaskProjects("tk_a")).toEqual([]);
      expect(await store.getProject("pj_a")).toMatchObject({ id: "pj_a" });
    });

    // Phase 2: addTask, addSubTask and updateTask take the `+slug` projects and link in their own transaction.
    it("addTask with projects links the task to each in the same write; a resend links nothing more", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      await store.addTask({ ...task("tk_a"), projects: ["work", "home", "home"] });
      await store.addTask({ ...task("tk_a"), projects: ["work", "home"] });
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_a" }, { task_id: "tk_a", project_id: "pj_b" }]);
      expect(await store.listTaskProjectSlugs(["tk_a", "tk_none"])).toEqual({ tk_a: ["home", "work"] });
    });

    it("addTask and addSubTask with an unknown or archived project throw the refusal and store no task and no link", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_old", name: "Old", created_by: by });
      await store.archiveProject("pj_old");
      await expect(store.addTask({ ...task("tk_a"), projects: ["home", "nope"] })).rejects.toThrow('no project "nope"');
      await expect(store.addTask({ ...task("tk_a"), projects: ["home", "old"] })).rejects.toThrow('project "old" is archived; restore it first');
      await expect(store.addTask({ ...task("tk_a"), projects: ["old"] })).rejects.toBeInstanceOf(ProjectRefused);
      expect(await store.db.all("SELECT id FROM controller_tasks")).toEqual([]);
      expect(await links(store)).toEqual([]);
      await store.addTask(task("tk_p"));
      await expect(store.addSubTask("tk_p", { ...task("tk_s"), projects: ["nope"] })).rejects.toThrow('no project "nope"');
      expect(await store.getTask("tk_s")).toBeNull();
      expect(await store.addSubTask("tk_p", { ...task("tk_s"), projects: ["home"] })).toMatchObject({ ok: true });
      expect(await links(store)).toEqual([{ task_id: "tk_s", project_id: "pj_a" }]);
    });

    it("updateTask with projects adds links with the edit; a refusal leaves the row and its links as they were", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home", created_by: by });
      await store.createProject({ id: "pj_old", name: "Old", created_by: by });
      await store.archiveProject("pj_old");
      await store.addTask({ ...task("tk_a"), projects: ["home"] });
      const before = await store.db.all("SELECT * FROM controller_tasks");
      await expect(store.updateTask("tk_a", { title: "renamed", projects: ["nope"] })).rejects.toThrow('no project "nope"');
      await expect(store.updateTask("tk_a", { title: "renamed", projects: ["old"] })).rejects.toThrow('project "old" is archived; restore it first');
      expect(await store.db.all("SELECT * FROM controller_tasks")).toEqual(before);
      expect(await links(store)).toEqual([{ task_id: "tk_a", project_id: "pj_a" }]);
      await store.createProject({ id: "pj_b", name: "Work", created_by: by });
      expect(await store.updateTask("tk_a", { title: "renamed", projects: ["work", "home"] })).toMatchObject({ ok: true, task: { title: "renamed" } });
      expect(await store.listTaskProjectSlugs(["tk_a"])).toEqual({ tk_a: ["home", "work"] });
      // An archived project's link is kept but not listed.
      await store.archiveProject("pj_b");
      expect(await store.listTaskProjectSlugs(["tk_a"])).toEqual({ tk_a: ["home"] });
    });

    it("getProjectBySlug finds an active or archived project by its slug", async () => {
      const { store } = await make();
      await store.createProject({ id: "pj_a", name: "Home Repairs", created_by: by });
      await store.archiveProject("pj_a");
      expect(await store.getProjectBySlug("home-repairs")).toMatchObject({ id: "pj_a", archived_at: expect.any(String) });
      expect(await store.getProjectBySlug("home")).toBeNull();
    });
  });
});

import { describe, expect, it } from "vitest";
import type { SourceRef } from "../../src/core/types.js";
import { PatternEgressScanner } from "../../src/impl/egress/pattern-egress-scanner.js";
import type { EgressScanner } from "../../src/interfaces/egress-scanner.js";
import type { SourceAdapter, SourceNotice } from "../../src/interfaces/source-adapter.js";
import { aggregate } from "../../src/outbound/aggregator/aggregator.js";
import { NOTIFY_BATCHING, batchingPolicies, isNotifyDestination, policyFor } from "../../src/outbound/aggregator/batching.js";
import { Outbound, buildTargets, recordAction, type Delivery } from "../../src/outbound/index.js";
import { tickAt } from "../../src/shared/ticks/tick-generator.js";
import { cleanScanner, silent } from "../helpers/fakes.js";
import { newStore } from "../helpers/store.js";

// Design 12-notification-channels: an adapter's notices (`<type>:notify`) wait in a fixed 60 s window, go out as one
// notifyOwner call per batch (one message), are egress-scanned first, retry with backoff without holding any other
// destination, and leave at most one message per 60 s.

const T0 = Date.parse("2026-11-12T03:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const NOTIFY: SourceRef = { type: "slack_thread", id: "notify", link: "" };
const LOCAL: SourceRef = { type: "local", id: "local-1", link: "" };

type Db = Parameters<typeof recordAction>[0];

/** A fake Slack adapter: each notifyOwner call is one message; `down` makes every call fail. */
function fakeSlack() {
  const messages: SourceNotice[][] = [];
  const s = {
    type: "slack_thread", intake: "poll" as const, down: false, messages, poll: async () => ({ events: [], next_cursor: "" }),
    postComment: async () => ({ url: null }), markSeen: async () => {}, setStatus: async () => {}, closeIssue: async () => {},
    async notifyOwner(n: readonly SourceNotice[]) {
      if (s.down) throw new Error("slack is down");
      messages.push([...n]);
    },
  };
  return s;
}

let seq = 0;
/** Records one notice intent at `at` and aggregates it as its own commit, as the controller's announce does. */
async function notice(db: Db, at: number, title = `item ${++seq}`, target: SourceRef = NOTIFY): Promise<void> {
  const id = `wi_${title.replace(/\W/g, "")}`;
  await recordAction(db, { action: "notify", target, work_item_id: id, key: `notify:${id}:sc:slack`, args: { kind: "finished", title, reason: "merged", work_item_id: id, count: 1 } }, iso(at));
  const { seq: s } = ((await db.all("SELECT MAX(seq) AS seq FROM outbound_actions")) as { seq: number }[])[0]!;
  const destination = `${target.type}:${target.id}`;
  await db.transaction((tx) => aggregate(tx, { commit_id: `c${s}`, commit_count: 1, destination, intent_ids: [`act_${s}`], reply: false }, policyFor({}, destination), null, iso(at)));
}

/** A local write in its own destination, sent at once. */
async function localPost(db: Db, at: number, body: string): Promise<void> {
  await recordAction(db, { action: "post", target: LOCAL, args: { body, marker: body } }, iso(at));
  const { seq: s } = ((await db.all("SELECT MAX(seq) AS seq FROM outbound_actions")) as { seq: number }[])[0]!;
  await db.transaction((tx) => aggregate(tx, { commit_id: `l${s}`, commit_count: 1, destination: "local:local-1", intent_ids: [`act_${s}`], reply: false }, policyFor({}, "local:local-1"), null, iso(at)));
}

function outbound(db: Db, store: ConstructorParameters<typeof Outbound>[0]["store"], slack: ReturnType<typeof fakeSlack>, scanner: EgressScanner = cleanScanner) {
  const local: Delivery[] = [];
  const targets = [
    ...buildTargets({ byType: new Map([["slack_thread", slack as unknown as SourceAdapter]]), forge: null, repo: "/repo" }).filter((t) => t.name !== "local"),
    { name: "local", accepts: (d: Delivery) => d.kind === "action" && d.row.target.type === "local", deliver: async (d: Delivery) => (local.push(d), { url: null }) },
  ];
  const o = new Outbound({
    db: db as ConstructorParameters<typeof Outbound>[0]["db"], store, targets, scanner, log: silent,
    bus: { publish: async () => {} } as unknown as ConstructorParameters<typeof Outbound>[0]["bus"],
    config: () => ({ lease_ms: 60_000, retry_base_ms: 10_000, retry_max_ms: 600_000, project_key: "p" }),
    canSend: () => true, kinds: () => ["slack_thread", "local"], fenceFor: () => null, fenceRefused: async () => {},
  });
  return { flush: (at: number) => o.flush(tickAt("outbound-flush", 250, T0 + at)), local };
}

async function actions(db: Db) {
  return db.all("SELECT seq, action, outcome, delivered_at, last_error FROM outbound_actions WHERE action = 'notify' ORDER BY seq");
}

describe("notify batching", () => {
  it("an adapter's notices take a fixed 60 s window with no cap, whatever outbound.batching says", () => {
    const policies = batchingPolicies({ "*": { mode: "commit" }, slack_thread: { mode: "auto", max_messages: 1 } });
    expect(isNotifyDestination("slack_thread:notify")).toBe(true);
    expect(isNotifyDestination("slack_thread:slack:T:C:1.2")).toBe(false);
    expect(policyFor(policies, "slack_thread:notify")).toEqual(NOTIFY_BATCHING);
    expect(NOTIFY_BATCHING).toMatchObject({ mode: "fixed", debounce_ms: 60_000, max_wait_ms: 60_000 });
    expect(policyFor(policies, "slack_thread:slack:T:C:1.2").mode).toBe("auto");
  });
});

describe("notify delivery (fake Slack)", () => {
  it("the notices of one 60 s tick go out as one message with one line each", async () => {
    const { store } = await newStore();
    const slack = fakeSlack();
    const o = outbound(store.db, store, slack);
    for (let i = 0; i < 5; i++) await notice(store.db, i * 5_000, `tick one ${i}`);
    expect(await o.flush(30_000)).toBe(0);
    expect(slack.messages).toEqual([]);
    await o.flush(61_000);
    await o.flush(62_000);
    expect(slack.messages.map((m) => m.map((n) => n.title))).toEqual([["tick one 0", "tick one 1", "tick one 2", "tick one 3", "tick one 4"]]);
    expect((await actions(store.db)).map((a) => a.outcome)).toEqual(Array(5).fill("sent"));
  });

  it("a flagged title withholds the whole message: nothing of it is posted, and its rows are not retried", async () => {
    const { store } = await newStore();
    const slack = fakeSlack();
    const o = outbound(store.db, store, slack, new PatternEgressScanner(async () => []));
    await notice(store.db, 0, "fine");
    await notice(store.db, 1_000, `leak ghp_${"a".repeat(36)}`);
    await o.flush(61_000);
    await o.flush(3_600_000);
    expect(slack.messages).toEqual([]);
    const rows = await actions(store.db);
    expect(rows.map((r) => r.outcome)).toEqual(["withheld", "withheld"]);
    expect(JSON.stringify(rows)).not.toContain("ghp_");
  });

  it("a Slack failure retries its rows with backoff while other destinations keep going; the backlog is one message per batch", async () => {
    const { store } = await newStore();
    const slack = fakeSlack();
    const o = outbound(store.db, store, slack);
    slack.down = true;
    await notice(store.db, 0, "first");
    await notice(store.db, 1_000, "second");
    await o.flush(61_000);
    expect(slack.messages).toEqual([]);
    const [failed] = await store.db.all("SELECT state, attempts, flush_at FROM outbound_batches WHERE destination = 'slack_thread:notify'");
    expect(failed).toMatchObject({ state: "failed", attempts: 1 });
    expect(Date.parse(String(failed!.flush_at))).toBeGreaterThan(T0 + 61_000);
    // Local work goes on during the outage.
    await localPost(store.db, 62_000, "local work");
    await o.flush(62_000);
    expect(o.local).toHaveLength(1);
    // More notices during the outage: a batch of their own, not one message each.
    await notice(store.db, 70_000, "third");
    await notice(store.db, 75_000, "fourth");
    slack.down = false;
    for (let t = 120_000; t <= 600_000; t += 2_000) await o.flush(t);
    expect(slack.messages.map((m) => m.map((n) => n.title))).toEqual([["first", "second"], ["third", "fourth"]]);
  });

  it("at most one message per 60 s: a backlog batch due sooner after the last one waits for the window", async () => {
    const { store } = await newStore();
    const slack = fakeSlack();
    const o = outbound(store.db, store, slack);
    slack.down = true;
    await notice(store.db, 0, "a");
    await o.flush(61_000);
    await notice(store.db, 62_000, "b");
    slack.down = false;
    const sentAt: number[] = [];
    for (let t = 70_000; t <= 400_000; t += 2_000) {
      const before = slack.messages.length;
      await o.flush(t);
      if (slack.messages.length > before) sentAt.push(t);
    }
    expect(slack.messages.map((m) => m.map((n) => n.title))).toEqual([["a"], ["b"]]);
    expect(sentAt[1]! - sentAt[0]!).toBeGreaterThanOrEqual(60_000);
  });

  it("a second flush sends nothing; a retried batch posts nothing again for a row already recorded delivered", async () => {
    const { store } = await newStore();
    const slack = fakeSlack();
    const o = outbound(store.db, store, slack);
    await notice(store.db, 0, "once");
    await notice(store.db, 1_000, "twice");
    await o.flush(61_000);
    await o.flush(200_000);
    expect(slack.messages).toHaveLength(1);
    // The batch read again as unsent (a lost write after the post): the delivered rows are skipped.
    await store.db.run("UPDATE outbound_batches SET state = 'failed', flush_at = ? WHERE destination = 'slack_thread:notify'", [iso(0)]);
    await store.db.run("UPDATE outbound_actions SET delivered_at = NULL, outcome = NULL WHERE seq = (SELECT MAX(seq) FROM outbound_actions)");
    await o.flush(400_000);
    expect(slack.messages.map((m) => m.map((n) => n.title))).toEqual([["once", "twice"], ["twice"]]);
  });

  it("slack-thread and source never take a notify row; an adapter without notifyOwner has no target for it", () => {
    const plain = { ...fakeSlack(), notifyOwner: undefined, type: "plain" } as unknown as SourceAdapter;
    const slack = fakeSlack() as unknown as SourceAdapter;
    const targets = buildTargets({ byType: new Map([["slack_thread", slack], ["plain", plain]]), forge: null, repo: "/repo" });
    const row = (source_type: string): Delivery => ({
      kind: "action",
      row: {
        seq: 1, action: "notify", source_type, target: { type: source_type, id: "notify", link: "" }, args: {}, delivered_at: null, delivered_ref: null,
        delivered_url: null, outcome: null, last_error: null,
      },
    });
    expect(targets.filter((t) => t.accepts(row("slack_thread"))).map((t) => t.name)).toEqual(["notify"]);
    expect(targets.filter((t) => t.accepts(row("plain"))).map((t) => t.name)).toEqual([]);
  });
});

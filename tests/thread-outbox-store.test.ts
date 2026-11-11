import { describe, expect, it } from "vitest";
import type { SourceRef, UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { issue, newStore, system } from "./helpers/store.js";

// The thread outbox (issue #282): SQLite migration 29 adds `thread_outbox`, and copies pending app requests into `command_inbox`.

const ref = (n: number): SourceRef => ({ type: "github_issue", id: `o/r#${n}`, link: `https://github.com/o/r/issues/${n}` });

async function item(store: FactoryStore, n: number): Promise<WorkItemId> {
  return (await store.createWorkItem(issue(n), system)).item.id;
}

async function entry(store: FactoryStore, id: WorkItemId, marker: string, opts: { link?: "spec_comment_url" | "failure_comment_url" } = {}) {
  const r = await store.recordItemMessage({
    work_item_id: id,
    marker,
    body: `body ${marker}`,
    delivery: { source_type: "github_issue", target: ref(1), link_field: opts.link ?? null },
  });
  return r;
}

const BACKENDS = [{ name: "sqlite", make: newStore }];

for (const backend of BACKENDS) {
  describe(`thread outbox store (${backend.name})`, () => {
    it("an entry written with a delivery gets one pending outbox row; a repeat of its marker adds none", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      const first = await entry(store, id, "<!-- factory:a -->");
      expect(first.created).toBe(true);
      expect((await entry(store, id, "<!-- factory:a -->")).created).toBe(false);
      const rows = await store.listDeliveries(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        thread_seq: first.message.seq, source_type: "github_issue", target: ref(1), marker: "<!-- factory:a -->",
        body: "body <!-- factory:a -->", attempts: 0, delivered_at: null, url: null,
      });
      // No delivery: the thread is the only copy.
      await store.recordItemMessage({ work_item_id: id, marker: "<!-- factory:b -->", body: "b" });
      expect((await store.listDeliveries(id)).map((d) => d.marker)).toEqual(["<!-- factory:a -->"]);
    });

    it("pending rows are listed only for the given source types", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      expect((await store.listPendingDeliveries(["github_issue"], 10)).map((d) => d.marker)).toContain("m1");
      expect(await store.listPendingDeliveries(["slack_thread"], 10)).toEqual([]);
      expect(await store.listPendingDeliveries([], 10)).toEqual([]);
    });

    it("a claim is exclusive until it expires; finish under the claim marks it delivered and lists it no more", async () => {
      const { store, clock } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      const seq = (await store.listDeliveries(id))[0]!.seq;
      const token = await store.claimDelivery(seq, 60_000);
      expect(token).not.toBeNull();
      expect(await store.claimDelivery(seq, 60_000)).toBeNull();
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
      clock.advance(60_001);
      const second = await store.claimDelivery(seq, 60_000);
      expect(second).not.toBeNull();
      // The first claim is fenced out once a second one took the row.
      expect(await store.finishDelivery(seq, token!, "u1")).toBe(false);
      expect(await store.finishDelivery(seq, second!, "u2")).toBe(true);
      expect(await store.finishDelivery(seq, second!, "u3")).toBe(false);
      expect((await store.listDeliveries(id))[0]).toMatchObject({ url: "u2", delivered_at: clock.now().toISOString() });
      expect(await store.claimDelivery(seq, 60_000)).toBeNull();
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
    });

    it("a failure counts an attempt, keeps the error and waits until the retry time; the item is unchanged", async () => {
      const { store, clock } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "m1");
      const before = (await store.getWorkItem(id))!;
      const seq = (await store.listDeliveries(id))[0]!.seq;
      const token = (await store.claimDelivery(seq, 60_000))!;
      expect(await store.failDelivery(seq, token, "boom", 5_000)).toBe(true);
      expect(await store.failDelivery(seq, token, "again", 5_000)).toBe(false);
      expect((await store.listDeliveries(id))[0]).toMatchObject({ attempts: 1, last_error: "boom", delivered_at: null });
      expect(await store.listPendingDeliveries(["github_issue"], 10)).toEqual([]);
      clock.advance(5_000);
      expect((await store.listPendingDeliveries(["github_issue"], 10)).map((d) => d.seq)).toEqual([seq]);
      const after = (await store.getWorkItem(id))!;
      expect(after).toEqual(before);
    });

    it("a delivered link fills the item's field without a version change; an older entry never hides a newer one", async () => {
      const { store } = await backend.make();
      const id = await item(store, 1);
      await entry(store, id, "old", { link: "failure_comment_url" });
      await entry(store, id, "new", { link: "failure_comment_url" });
      await entry(store, id, "spec", { link: "spec_comment_url" });
      const [oldRow, newRow, specRow] = await store.listDeliveries(id);
      const version = (await store.getWorkItem(id))!.version;
      // Outbound marks the row delivered; the controller records it on the item (DeliveryCompleted).
      const deliver = async (seq: number, url: string) => {
        await store.finishDelivery(seq, (await store.claimDelivery(seq, 1000))!, url);
        await store.linkDelivery(seq);
      };
      await deliver(newRow!.seq, "u-new");
      await deliver(oldRow!.seq, "u-old");
      await deliver(specRow!.seq, "u-spec");
      expect(await store.getWorkItem(id)).toMatchObject({ failure_comment_url: "u-new", spec_comment_url: "u-spec", version });
    });

    it("an app request is one row of the command inbox (RFC 0015 D7), with origin app and its own key", async () => {
      const { store } = await backend.make();
      const { request } = await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "approve", args: { work_item_id: "x" } });
      await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "approve", args: {} });
      const inbox = await store.listCliCommandsAfter(0, 100);
      expect(inbox).toEqual([expect.objectContaining({ seq: request.seq, origin: "app", key: "k1", actor: "github:1", command: "approve" })]);
    });
  });
}

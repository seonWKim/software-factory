// The SourceAdapter contract (RFC 0023 R2): what every source does, the test fakes included, taken from the port's doc
// comments (src/interfaces/source-adapter.ts) and what the controller, outbound and the listener rely on. A case that
// reads a surface (labels, a closed state, reactions) runs only where the source has one: a Slack thread cannot be
// closed, a local item has no labels.
import { describe, expect, it } from "vitest";
import type { WorkStatus } from "../../src/core/status-label.js";
import type { SourceRef, UserId, WorkItemId } from "../../src/core/types.js";
import { phaseMarker } from "../../src/core/split.js";
import type { PushedEvent, SourceAdapter, SourceCloseReason, SourceEvent } from "../../src/interfaces/source-adapter.js";
import { PROJECT_KEY } from "../helpers/store.js";

/** One source under test and the hooks that set up and read its world. */
export interface SourceHarness {
  source: SourceAdapter;
  /** A new item on this source that the factory acts on: an issue, a thread, a local item. */
  item(): Promise<SourceRef>;
  /** How many messages on `ref` carry `marker`. Absent: the source keeps none to count. */
  posted?(ref: SourceRef, marker: string): Promise<number>;
  /** The factory statuses `ref` shows now. Absent: the source shows none. */
  statuses?(ref: SourceRef): Promise<WorkStatus[]>;
  /** Puts a marker the factory does not own on `ref` (e.g. a person's label), and says whether it is still there. */
  foreign?: { add(ref: SourceRef): Promise<void>; present(ref: SourceRef): Promise<boolean> };
  /** How `ref` stands: open, or closed with a reason. Absent: the source has nothing to close. */
  closed?(ref: SourceRef): Promise<SourceCloseReason | "open">;
  /** A person's message on `ref`: its comment id. With `seen`, the 👀 on it. */
  personMessage?(ref: SourceRef): Promise<string>;
  seen?(ref: SourceRef, comment_id: string): Promise<number>;
  /** Poll sources: a person comments `body` on `ref`; `edit` changes its text later. */
  comment?(ref: SourceRef, body: string): Promise<{ edit(body: string): Promise<void> }>;
  /** Stream sources: a person sends one message that becomes one event. */
  push?(text: string): Promise<void>;
}

const PARENT = "wi_parent" as WorkItemId;
const issueInput = (marker: string) => ({ project: PROJECT_KEY, requester_id: "system:improve" as UserId, title: "A failure pattern", body: "What failed.", marker });

/** The plain comments a poll delivered with `body`. */
const plain = (events: SourceEvent[], body: string) => events.filter((e) => e.kind === "plain_comment" && e.body === body);

export function sourceContract(name: string, make: () => Promise<SourceHarness>): void {
  describe(`SourceAdapter contract: ${name}`, () => {
    describe("postComment", () => {
      it("posts once per marker and answers the same link both times (outbound retries a post)", async () => {
        const h = await make();
        const ref = await h.item();
        const first = await h.source.postComment(ref, "The spec is ready.", "<!-- m1 -->");
        const again = await h.source.postComment(ref, "The spec is ready.", "<!-- m1 -->");
        expect(again.url).toBe(first.url);
        if (h.posted) expect(await h.posted(ref, "<!-- m1 -->")).toBe(1);
      });

      it("posts a message per marker: another marker is another message", async (ctx) => {
        const h = await make();
        if (!h.posted) return ctx.skip();
        const ref = await h.item();
        await h.source.postComment(ref, "one", "<!-- m1 -->");
        await h.source.postComment(ref, "two", "<!-- m2 -->");
        expect([await h.posted(ref, "<!-- m1 -->"), await h.posted(ref, "<!-- m2 -->")]).toEqual([1, 1]);
      });
    });

    describe("setStatus", () => {
      it("leaves exactly one factory status on the item, the last one set; the same call again changes nothing", async () => {
        const h = await make();
        const ref = await h.item();
        await h.source.setStatus(ref, "implementing", null);
        await h.source.setStatus(ref, "in_review", null);
        await h.source.setStatus(ref, "in_review", null);
        if (h.statuses) expect(await h.statuses(ref)).toEqual(["in_review"]);
      });

      it("leaves markers the factory does not own alone", async (ctx) => {
        const h = await make();
        if (!h.foreign) return ctx.skip();
        const ref = await h.item();
        await h.foreign.add(ref);
        await h.source.setStatus(ref, "implementing", null);
        await h.source.setStatus(ref, "done", null);
        expect(await h.foreign.present(ref)).toBe(true);
      });
    });

    describe("closeIssue", () => {
      it("closes as not planned by default (a rejected spec), and closing again changes nothing", async () => {
        const h = await make();
        const ref = await h.item();
        await h.source.closeIssue(ref);
        await h.source.closeIssue(ref);
        if (h.closed) expect(await h.closed(ref)).toBe("not_planned");
      });

      it("closes as completed when asked (every phase of a split done)", async (ctx) => {
        const h = await make();
        if (!h.closed) return ctx.skip();
        const ref = await h.item();
        await h.source.closeIssue(ref, "completed");
        expect(await h.closed(ref)).toBe("completed");
      });
    });

    describe("markSeen", () => {
      it("marks a message seen once, however often it is called", async (ctx) => {
        const h = await make();
        if (!h.personMessage || !h.seen) return ctx.skip();
        const ref = await h.item();
        const id = await h.personMessage(ref);
        await h.source.markSeen(ref, id);
        await h.source.markSeen(ref, id);
        expect(await h.seen(ref, id)).toBe(1);
      });
    });

    describe("fileIssue", () => {
      it("files one item per marker, of this source's type: filing again returns the same item", async (ctx) => {
        const h = await make();
        if (!h.source.fileIssue) return ctx.skip();
        const a = await h.source.fileIssue(issueInput("<!-- pattern:a -->"));
        const again = await h.source.fileIssue(issueInput("<!-- pattern:a -->"));
        const b = await h.source.fileIssue(issueInput("<!-- pattern:b -->"));
        expect(a.type).toBe(h.source.type);
        expect(again).toEqual(a);
        expect(b.id).not.toBe(a.id);
      });
    });

    describe("fileSubIssue", () => {
      it("files one phase per marker, of this source's type: filing again returns the same item", async (ctx) => {
        const h = await make();
        if (!h.source.fileSubIssue) return ctx.skip();
        const parent = await h.item();
        const phase = (n: number) => ({ parent, title: `Phase ${n}`, body: `Phase ${n} of 2.`, marker: phaseMarker(PARENT, n) });
        const one = await h.source.fileSubIssue(phase(1));
        const again = await h.source.fileSubIssue(phase(1));
        const two = await h.source.fileSubIssue(phase(2));
        expect(one.type).toBe(h.source.type);
        expect(again).toEqual(one);
        expect(two.id).not.toBe(one.id);
      });
    });

    describe("poll", () => {
      it("gives a string cursor that the next poll takes", async (ctx) => {
        const h = await make();
        if (h.source.intake !== "poll") return ctx.skip();
        const first = await h.source.poll(null);
        expect(typeof first.next_cursor).toBe("string");
        expect(typeof (await h.source.poll(first.next_cursor)).next_cursor).toBe("string");
      });

      it("delivers a person's comment once: never again after the cursor advanced, nor after an edit", async (ctx) => {
        const h = await make();
        if (h.source.intake !== "poll" || !h.comment) return ctx.skip();
        const ref = await h.item();
        const first = await h.source.poll(null);
        const c = await h.comment(ref, "looks good to me");
        const second = await h.source.poll(first.next_cursor);
        expect(plain(second.events, "looks good to me")).toEqual([expect.objectContaining({ source: expect.objectContaining({ id: ref.id }) })]);
        const third = await h.source.poll(second.next_cursor);
        expect(plain(third.events, "looks good to me")).toEqual([]);
        await c.edit("looks good to me, edited");
        const fourth = await h.source.poll(third.next_cursor);
        expect(plain(fourth.events, "looks good to me, edited")).toEqual([]);
      });
    });

    describe("subscribe", () => {
      /** Opens a connection; `next` waits for its next delivery, `close` aborts it and checks the iterable completes. */
      const connect = (source: SourceAdapter) => {
        if (source.intake !== "stream") throw new Error("not a stream source");
        const ac = new AbortController();
        const it = source.subscribe(ac.signal)[Symbol.asyncIterator]();
        return {
          next: async (): Promise<PushedEvent> => {
            const r = await it.next();
            if (r.done) throw new Error("the connection ended");
            return r.value;
          },
          close: async () => {
            ac.abort();
            expect(await it.next()).toMatchObject({ done: true });
          },
        };
      };

      it("delivers an event that was not acked again on the next connection, under the same dedupe key", async (ctx) => {
        const h = await make();
        if (h.source.intake !== "stream" || !h.push) return ctx.skip();
        const one = connect(h.source);
        const first = one.next();
        await h.push("please build a thing");
        const delivered = await first;
        await one.close();
        const two = connect(h.source);
        const again = await two.next();
        expect(again.dedupe_key).toBe(delivered.dedupe_key);
        expect(again.event).toEqual(delivered.event);
        await two.close();
      });

      it("never delivers an acked event again, and stops once the signal aborts", async (ctx) => {
        const h = await make();
        if (h.source.intake !== "stream" || !h.push) return ctx.skip();
        const one = connect(h.source);
        const first = one.next();
        await h.push("please build a thing");
        const delivered = await first;
        await delivered.ack();
        await one.close();
        const two = connect(h.source);
        const next = two.next();
        await h.push("and another thing");
        expect((await next).dedupe_key).not.toBe(delivered.dedupe_key);
        await two.close();
      });
    });
  });
}

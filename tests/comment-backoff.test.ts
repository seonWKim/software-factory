import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId } from "../src/core/types.js";
import type { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubIssueSource, commentBackoffMs } from "../src/impl/source/github-issue-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeAuth, FakeGitHubClient, cleanScanner, config, issueRef, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

// Backoff of a failing comment post (design §5, GitHub call budget): the attempt count and the next attempt time
// live in the store, so every replica follows one schedule.

const POST = "POST /repos/o/r/issues/7/comments";

function controllerOn(store: FactoryStore, clock: FakeClock) {
  const github = new FakeGitHubClient();
  github.commentError = new Error("GitHub POST comment → 502");
  const source = new GitHubIssueSource(github, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner });
  return { github, controller };
}

/** A pending app request whose refusal the controller posts on issue #7 every tick until it goes through. */
async function setup() {
  const { store, clock } = await newStore();
  const { item } = await store.createWorkItem(
    { source: issueRef(7), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system,
  );
  const { request } = await store.recordAppCommandRequest({ key: "k1", actor: "github:1", command: "frobnicate", args: { work_item_id: item.id } });
  return { store, clock, marker: `<!-- factory:refused:app-${request.seq} -->` };
}

/** The fake times (ms after `start`) at which `github` tried a post. */
async function tickUntil(c: ReturnType<typeof controllerOn>, clock: FakeClock, start: number, until: number, seen: number[]) {
  while (clock.now().getTime() - start <= until) {
    const before = c.github.calls.filter((x) => x === POST).length;
    await c.controller.tickAppCommands();
    if (c.github.calls.filter((x) => x === POST).length > before) seen.push(clock.now().getTime() - start);
    clock.advance(500);
  }
}

describe("comment post backoff", () => {
  it("waits 1 s, 2 s, 4 s, doubling, at most 5 min", () => {
    expect([1, 2, 3, 4].map(commentBackoffMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(commentBackoffMs(9)).toBe(256_000);
    expect(commentBackoffMs(10)).toBe(300_000);
    expect(commentBackoffMs(40)).toBe(300_000);
  });

  it("a failing post is attempted at most 5 times in the first 30 s of fake time, ticked every 500 ms", async () => {
    const { store, clock, marker } = await setup();
    const c = controllerOn(store, clock);
    const start = clock.now().getTime();
    const seen: number[] = [];
    await tickUntil(c, clock, start, 30_000, seen);
    expect(seen).toEqual([0, 1_000, 3_000, 7_000, 15_000]);
    expect(await store.getPostedComment(issueRef(7).id, marker, "")).toMatchObject({
      comment_id: null, attempts: 5, next_attempt_at: new Date(start + 31_000).toISOString(),
    });
  });

  it("stores the attempt count and next time, so a second controller on the same store continues the schedule", async () => {
    const { store, clock, marker } = await setup();
    const start = clock.now().getTime();
    const a = controllerOn(store, clock);
    const seenA: number[] = [];
    await tickUntil(a, clock, start, 1_500, seenA);
    expect(seenA).toEqual([0, 1_000]);

    // A new process at 2 s: the next try is still at 3 s, not at once.
    const b = controllerOn(store, clock);
    const seenB: number[] = [];
    await tickUntil(b, clock, start, 7_500, seenB);
    expect(seenB).toEqual([3_000, 7_000]);
    expect((await store.getPostedComment(issueRef(7).id, marker, ""))!.attempts).toBe(4);

    // The forge is back: the post goes through at its next time, once, and the record replaces the failures.
    b.github.commentError = null;
    await tickUntil(b, clock, start, 16_000, seenB);
    expect(seenB).toEqual([3_000, 7_000, 15_000]);
    expect(b.github.comments.get(7)).toHaveLength(1);
    expect(await store.getPostedComment(issueRef(7).id, marker, "")).toMatchObject({ attempts: 0, next_attempt_at: null });
    expect((await store.getPostedComment(issueRef(7).id, marker, ""))!.comment_id).not.toBeNull();
    expect((await store.getAppCommandRequest(1))?.handled_at).not.toBeNull();
  });
});

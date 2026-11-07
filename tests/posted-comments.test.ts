import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import type { UserId } from "../src/core/types.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { FakeAuth, FakeGitHubClient, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

// Posted comments in the store (design §5, GitHub call budget): a marker the store knows costs no thread read.

const THREAD = "GET /repos/o/r/issues/7/comments";
const POST = "POST /repos/o/r/issues/7/comments";
const MARKER = "<!-- factory:test -->";

async function setup() {
  const { store, clock } = await newStore();
  const github = new FakeGitHubClient();
  const source = new GitHubIssueSource(github, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  return { store, clock, github, source };
}

describe("GitHubIssueSource.postComment with a store", () => {
  it("a first post of a new marker reads the thread once, posts, then stores the comment ID, URL and body hash", async () => {
    const { store, github, source } = await setup();
    const { url } = await source.postComment(issueRef(7), "hello", MARKER);
    expect(github.calls).toEqual([THREAD, POST]);
    const posted = github.comments.get(7)![0]!;
    expect(url).toBe(posted.html_url);
    expect(posted.body).toBe(`hello\n\n${MARKER}`);
    const stored = await store.getPostedComment(issueRef(7).id, MARKER, "hello");
    expect(stored).toMatchObject({ comment_id: String(posted.id), url: posted.html_url, attempts: 0, same_body: true });
    expect(stored!.body_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored!.body_hash).not.toContain("hello");
  });

  it("a second post of the same marker makes no thread-list call and returns the stored URL", async () => {
    const { github, source } = await setup();
    const first = await source.postComment(issueRef(7), "hello", MARKER);
    github.calls = [];
    const second = await source.postComment(issueRef(7), "hello", MARKER);
    expect(second.url).toBe(first.url);
    expect(github.calls).toEqual([]);
    expect(github.comments.get(7)).toHaveLength(1);
  });

  it("a marker already in the thread (posted before the store kept records) is stored, not posted again", async () => {
    const { store, github, source } = await setup();
    const old = { id: 55, body: `older\n\n${MARKER}`, html_url: "https://github.com/o/r/issues/7#issuecomment-55" };
    github.comments.set(7, [old]);
    expect((await source.postComment(issueRef(7), "older", MARKER)).url).toBe(old.html_url);
    expect(github.calls).toEqual([THREAD]);
    expect(await store.getPostedComment(issueRef(7).id, MARKER, "older")).toMatchObject({ comment_id: "55", url: old.html_url });
  });

  it("the record is shared: a second source on the same store (another replica) makes no call", async () => {
    const { store, source } = await setup();
    const { url } = await source.postComment(issueRef(7), "hello", MARKER);
    const other = new FakeGitHubClient();
    const replica = new GitHubIssueSource(other, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
    expect((await replica.postComment(issueRef(7), "hello", MARKER)).url).toBe(url);
    expect(other.calls).toEqual([]);
  });
});

describe("controller: a repeat post with a different body", () => {
  it("does not edit the comment and logs a warning", async () => {
    const { store, clock, github, source } = await setup();
    const log = recordingLog();
    const controller = new Controller({ store, source, auth: new FakeAuth(), clock, config, log, scanner: cleanScanner });
    const { item } = await store.createWorkItem(
      { source: issueRef(7), requester_id: "github:1" as UserId, project: PROJECT_KEY, problem: "p", resources: [] }, system,
    );
    const { request } = await store.recordAppCommandRequest({ key: "k1", actor: "github:1" as UserId, command: "frobnicate", args: { work_item_id: item.id } });
    const marker = `<!-- factory:refused:app-${request.seq} -->`;
    // The same marker was posted earlier with another body.
    await store.recordPostedComment({ source_id: issueRef(7).id, marker, comment_id: "9", url: "https://github.com/o/r/issues/7#issuecomment-9", body: "an older text" });

    await controller.tickCommands();
    expect(github.calls).toEqual([]);
    expect(log.lines.filter((l) => l.level === "warn")).toEqual([
      { level: "warn", msg: "comment already posted with another body; not edited", fields: { source_id: issueRef(7).id, marker } },
    ]);
    expect(await store.getPostedComment(issueRef(7).id, marker, "an older text")).toMatchObject({ comment_id: "9", same_body: true });
  });
});

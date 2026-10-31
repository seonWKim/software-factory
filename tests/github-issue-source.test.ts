import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/impl/github/github-client.js";
import { GitHubIssueSource } from "../src/impl/source/github-issue-source.js";
import type { SecretStore } from "../src/interfaces/secret-store.js";
import { issueRef } from "./helpers/fakes.js";

/** Records every request; GET answers come from `responses` by path prefix (without query), else []. */
class FakeClient extends GitHubClient {
  calls: { method: string; path: string; body: unknown }[] = [];
  responses: Record<string, unknown[]> = {};

  constructor() {
    super({} as SecretStore, "http://unused");
  }
  override async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    this.calls.push({ method, path, body });
    if (method !== "GET") return {} as T;
    const bare = path.split("?")[0]!;
    // Pages after the first are always empty.
    if (!path.includes("page=1")) return [] as T;
    return (this.responses[bare] ?? []) as T;
  }
}

const user = { id: 1, login: "alice", type: "User" };
const comment = (id: number, body: string, updated_at: string, issue = 7) => ({
  id,
  issue_url: `https://api.github.com/repos/o/r/issues/${issue}`,
  body,
  user,
  updated_at,
});

function setup() {
  const client = new FakeClient();
  const source = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/");
  return { client, source };
}

describe("GitHubIssueSource", () => {
  it("reacts 👀 on a comment and on an issue with the exact endpoints and body", async () => {
    const { client, source } = setup();
    await source.markSeen(issueRef(7), "12345");
    await source.markSeen(issueRef(7), null);
    expect(client.calls).toEqual([
      { method: "POST", path: "/repos/o/r/issues/comments/12345/reactions", body: { content: "eyes" } },
      { method: "POST", path: "/repos/o/r/issues/7/reactions", body: { content: "eyes" } },
    ]);
  });

  it("passes the comment id through on command events", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [
      comment(10, "/approve", "2026-11-01T00:00:01Z"),
      comment(11, "/reject too big\nsplit it", "2026-11-01T00:00:02Z"),
      comment(12, "/retry", "2026-11-01T00:00:03Z"),
      comment(13, "looks good", "2026-11-01T00:00:04Z"),
    ];
    const { events } = await source.poll(null);
    expect(events).toEqual([
      { kind: "spec_approved", source: issueRef(7), comment_id: "10", approver: { provider: "github", subject: "1", login: "alice" } },
      {
        kind: "spec_rejected", source: issueRef(7), comment_id: "11",
        approver: { provider: "github", subject: "1", login: "alice" }, reason: "too big\nsplit it",
      },
      { kind: "retry_requested", source: issueRef(7), comment_id: "12", requester: { provider: "github", subject: "1", login: "alice" } },
    ]);
  });

  it("does not deliver a comment again once the cursor's high-water mark passed it", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [comment(10, "/approve", "2026-11-01T00:00:01Z")];
    const first = await source.poll(null);
    expect(first.events).toHaveLength(1);

    // `since` is inclusive: the next poll returns the same comment, and an edit of it, plus a new one.
    client.responses["/repos/o/r/issues/comments"] = [
      comment(10, "/approve", "2026-11-01T00:00:01Z"),
      comment(10, "/approve", "2026-11-01T00:00:05Z"),
      comment(14, "/retry", "2026-11-01T00:00:06Z"),
    ];
    const second = await source.poll(first.next_cursor);
    expect(second.events.map((e) => ("comment_id" in e ? e.comment_id : null))).toEqual(["14"]);
    expect(JSON.parse(second.next_cursor)).toMatchObject({ comments: "2026-11-01T00:00:06Z", last_comment_id: 14 });
  });

  it("reads a cursor written before the high-water mark existed", async () => {
    const { client, source } = setup();
    client.responses["/repos/o/r/issues/comments"] = [comment(10, "/approve", "2026-11-01T00:00:01Z")];
    const old = JSON.stringify({ issues: null, comments: "2026-11-01T00:00:00Z", pulls: null });
    const { events } = await source.poll(old);
    expect(events).toHaveLength(1);
  });
});

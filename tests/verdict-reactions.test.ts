// 👍 and 👎 on the factory's messages as verdicts (design §4, issue #524): the pure mapping, then one table row per
// case through the real GitHub source (a fake client) and the controller, then the same through the Slack source.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { REACTION_WINDOW_MS, inReactionWindow, reactionKey, reactionVerdict, verdictReaction } from "../src/core/reaction-verdict.js";
import { SEVERITY_FOLLOW_UP } from "../src/controller/units/verdicts/verdicts.unit.js";
import type { UserId, WorkItem } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { GitHubIssueSource } from "../src/impl/github/github-issue-source.js";
import { SlackSource, slackSourceId } from "../src/impl/source/slack-source.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import type { SourceRef } from "../src/core/types.js";
import { FakeSource, cleanScanner, config, issueRef, recordingLog, silent } from "./helpers/fakes.js";
import { RecordingGitHubClient } from "./helpers/github.js";
import { CHANNEL, FakeSlackApi, FakeSocket, TEAM, eventEnvelope } from "./helpers/slack.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

const DAY = 24 * 60 * 60 * 1000;
const OWNER = "github:1" as UserId;

/**
 * Accounts as the tests link them: alice on GitHub (1) and Slack (U0ALICE) is the owner, who may record verdicts;
 * mallory (666, U0MALLORY) is linked with no such permission; anyone else is not linked at all.
 */
class ReactionAuth implements AuthProvider {
  async resolve(id: ExternalIdentity): Promise<Principal | null> {
    const user = ({ "github:1": OWNER, "slack:U0ALICE": OWNER, "github:666": "github:666", "slack:U0MALLORY": "github:666" } as Record<string, string>)[`${id.provider}:${id.subject}`];
    return user ? { user_id: user as UserId, attributes: {} } : null;
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    return action === "submit_work" || p.user_id === OWNER ? { allow: true } : { allow: false, reason: "not_a_collaborator" };
  }
}

describe("reaction → verdict mapping (src/core/reaction-verdict.ts)", () => {
  it("reads 👍 and 👎 by their GitHub and Slack names, skin tones included, and nothing else", () => {
    for (const e of ["+1", "thumbsup", "+1::skin-tone-3"]) expect(verdictReaction(e)).toBe("+1");
    for (const e of ["-1", "thumbsdown", "-1::skin-tone-6"]) expect(verdictReaction(e)).toBe("-1");
    for (const e of ["eyes", "heart", "laugh", "rocket", "", "+10"]) expect(verdictReaction(e)).toBeNull();
  });

  it("👍 is accept with severity none; 👎 stores nothing at once (it asks for the severity)", () => {
    expect(reactionVerdict("+1")).toEqual({ verdict: "accept", severity: "none", reason: null });
    expect(reactionVerdict("-1")).toBeNull();
    expect(SEVERITY_FOLLOW_UP).toContain("/verdict changes <severity> <reason>");
    expect(reactionKey("77")).toBe("reaction:77");
  });

  it("reads a reaction up to 7 days after the message", () => {
    expect(inReactionWindow(0, REACTION_WINDOW_MS)).toBe(true);
    expect(inReactionWindow(0, REACTION_WINDOW_MS + 1)).toBe(false);
  });
});

// ---- GitHub ---------------------------------------------------------------------------------------------------

const PR = 42;
const COMMENT = "900";
const REACTIONS = `/repos/o/r/issues/comments/${COMMENT}/reactions`;
const FOLLOW_UP = (reaction_id: number) => `<!-- factory:severity-reaction:${reaction_id} -->`;
const person = (id: number, login: string) => ({ id, login, type: "User" });
const reaction = (id: number, content: string, user: { id: number; login: string; type: string } | null = person(1, "alice")) => ({ id, content, user });

async function github() {
  const clock = new FakeClock("2026-11-01T00:00:00Z");
  const { store } = await newStore(clock);
  const client = new RecordingGitHubClient();
  const gh = new GitHubIssueSource(client, { owner: "o", name: "r" }, "factory", "factory/", "main", "sf: ", store);
  const posts = new FakeSource();
  const log = recordingLog();
  const controller = new ControllerRole({ store, source: posts, auth: new ReactionAuth(), clock, config, log, scanner: cleanScanner });
  const { item: created } = await store.createWorkItem(
    { source: issueRef(7), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system,
  );
  const r = await store.transition({
    id: created.id, expected_version: created.version, actor: system, reason: "test",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: String(PR) },
  });
  if (!r.ok) throw new Error(r.reason);
  await store.recordPrHead({ id: created.id, expected_head: null, head_sha: "h1", manual: null });
  /** The factory's review comment on PR 42, as outbound records it. */
  await postedPr(store, COMMENT, PR);
  /** Polls the GitHub source and hands every event to the controller; returns the events. */
  const tick = async (): Promise<SourceEvent[]> => {
    const prev = cursor;
    const { events, next_cursor } = await gh.poll(prev);
    cursor = next_cursor;
    for (const e of events) await controller.handleEvent(e);
    return events;
  };
  let cursor: string | null = null;
  return { clock, store, client, gh, posts, controller, log, item: created, tick };
}

function postedPr(store: FactoryStore, comment_id: string, pr: number, marker = `<!-- factory:review:${comment_id} -->`) {
  return store.recordPostedComment({ source_id: `o/r#${pr}`, marker, comment_id, url: `https://github.com/o/r/pull/${pr}#issuecomment-${comment_id}`, body: "review" });
}

/** A `/verdict` reply on the PR, as the GitHub source delivers it. */
const reply = (it: WorkItem, args: string, comment_id = "950"): SourceEvent => ({
  kind: "verdict_submitted", target: { kind: "pr", change_ref: String(PR), head_branch: `factory/${it.id}` }, comment_id, approver: { provider: "github", subject: "1", login: "alice" }, args,
});

type G = Awaited<ReturnType<typeof github>>;
interface Row {
  name: string;
  /** What the test sets up, then the reactions list GitHub returns for the factory's comment. */
  given: (g: G) => Promise<void> | void;
  reactions: unknown[];
  /** The `/verdict` reply after the reaction, if any. */
  then?: string;
  stored: { comment_id: string; verdict: string; severity: string; reason: string | null; pr_head: string | null; target: string }[];
  /** The markers posted, in order. */
  posted: string[];
}

const changesRow = (severity: string): Row => ({
  name: `👎 then \`/verdict changes ${severity} ...\`: one follow-up, then changes/${severity} from the reply`,
  given: () => {},
  reactions: [reaction(301, "-1")],
  then: `changes ${severity} the flag name is wrong`,
  stored: [{ comment_id: "950", verdict: "changes", severity, reason: "the flag name is wrong", pr_head: "h1", target: "pr" }],
  posted: [FOLLOW_UP(301)],
});

const ROWS: Row[] = [
  {
    name: "👍 by a linked user with record_verdict: accept/none for the PR head, keyed on the reaction, nothing posted",
    given: () => {},
    reactions: [reaction(300, "+1")],
    stored: [{ comment_id: "reaction:300", verdict: "accept", severity: "none", reason: null, pr_head: "h1", target: "pr" }],
    posted: [],
  },
  changesRow("none"),
  changesRow("minor"),
  changesRow("major"),
  changesRow("critical"),
  {
    name: "👎 then an unknown severity: the follow-up, then the usual one refusal; nothing stored",
    given: () => {},
    reactions: [reaction(302, "-1")],
    then: "changes huge rename it",
    stored: [],
    posted: [FOLLOW_UP(302), "<!-- factory:refused:950 -->"],
  },
  {
    name: "👎 with no reply: the follow-up only; nothing stored",
    given: () => {},
    reactions: [reaction(303, "-1")],
    stored: [],
    posted: [FOLLOW_UP(303)],
  },
  {
    name: "a reaction on a comment that is not a factory PR comment (the factory's issue comment): not read",
    given: async ({ store, client }) => {
      await store.recordPostedComment({ source_id: "o/r#7", marker: "<!-- factory:spec -->", comment_id: "800", url: "https://github.com/o/r/issues/7#issuecomment-800", body: "spec" });
      client.responses["/repos/o/r/issues/comments/800/reactions"] = [reaction(304, "+1")];
    },
    reactions: [],
    stored: [],
    posted: [],
  },
  {
    name: "a reaction on a factory PR comment older than 7 days: not read",
    given: ({ clock }) => clock.advance(7 * DAY + 1000),
    reactions: [reaction(305, "+1")],
    stored: [],
    posted: [],
  },
  {
    name: "a removed reaction (gone from the list when read): nothing",
    given: () => {},
    reactions: [],
    stored: [],
    posted: [],
  },
  {
    name: "another emoji: nothing",
    given: () => {},
    reactions: [reaction(306, "heart"), reaction(307, "laugh"), reaction(308, "rocket")],
    stored: [],
    posted: [],
  },
  {
    name: "the bot's own 👀 (and a bot's 👍): nothing",
    given: () => {},
    reactions: [reaction(309, "eyes", { id: 99, login: "factory[bot]", type: "Bot" }), reaction(310, "+1", { id: 99, login: "factory[bot]", type: "Bot" })],
    stored: [],
    posted: [],
  },
  {
    name: "👍 and 👎 from an account with no linked factory user: nothing stored, nothing posted",
    given: () => {},
    reactions: [reaction(311, "+1", person(4242, "stranger")), reaction(312, "-1", person(4242, "stranger"))],
    stored: [],
    posted: [],
  },
  {
    name: "👍 and 👎 from a linked user without record_verdict: nothing stored, nothing posted",
    given: () => {},
    reactions: [reaction(313, "+1", person(666, "mallory")), reaction(314, "-1", person(666, "mallory"))],
    stored: [],
    posted: [],
  },
];

describe("GitHub: reactions on the factory's PR comments", () => {
  it.each(ROWS)("$name", async (row) => {
    const g = await github();
    await row.given(g);
    g.client.responses[REACTIONS] = row.reactions;
    await g.tick();
    if (row.then) await g.controller.handleEvent(reply(g.item, row.then));
    // A later poll sees the same reactions again: it stores and posts nothing more.
    await g.tick();
    const stored = (await g.store.listVerdicts(g.item.id)).map((v) => ({
      comment_id: v.comment_id, verdict: v.verdict, severity: v.severity, reason: v.reason, pr_head: v.pr_head, target: v.target,
    }));
    expect(stored).toEqual(row.stored);
    expect(g.posts.comments.map((c) => c.marker)).toEqual(row.posted);
    // A follow-up is fixed text: no user text, and no 👀 on anything for a reaction.
    for (const c of g.posts.comments.filter((x) => x.marker.includes("severity-reaction"))) expect(c.body).toBe(SEVERITY_FOLLOW_UP);
    expect(g.posts.reactions.filter((r) => r.comment_id?.startsWith("reaction:"))).toEqual([]);
    // GitHub only (no Slack source): the poll with its reaction reads logs no error.
    expect(g.log.lines.filter((l) => l.level === "error")).toEqual([]);
  });

  it("a 👍 stores as the reacting user, and a redelivered event stores nothing more", async () => {
    const g = await github();
    g.client.responses[REACTIONS] = [reaction(320, "+1")];
    const events = await g.tick();
    expect(events).toEqual([{
      kind: "verdict_submitted", target: { kind: "pr", change_ref: "42" }, comment_id: "reaction:320",
      approver: { provider: "github", subject: "1", login: "alice" }, reaction: "+1", verdict: { verdict: "accept", severity: "none", reason: null },
    }]);
    // The next poll's cursor holds the reaction's mark: the same reaction is not delivered again.
    expect(await g.tick()).toEqual([]);
    for (const e of events) await g.controller.handleEvent(e);
    expect(await g.store.listVerdicts(g.item.id)).toHaveLength(1);
    expect((await g.store.listStateChanges(g.item.id)).filter((c) => c.reason === "human_verdict").map((c) => c.actor)).toEqual([{ kind: "user", id: OWNER }]);
  });

  it("a 👎 redelivered posts its follow-up once", async () => {
    const g = await github();
    g.client.responses[REACTIONS] = [reaction(321, "-1")];
    const events = await g.tick();
    for (const e of events) await g.controller.handleEvent(e);
    expect(g.posts.comments.map((c) => c.marker)).toEqual([FOLLOW_UP(321)]);
  });

  it("a 👎 on a closed item whose PR was not merged gets no follow-up", async () => {
    const g = await github();
    const it0 = (await g.store.getWorkItem(g.item.id))!;
    await g.store.transition({ id: it0.id, expected_version: it0.version, actor: system, reason: "test", patch: { stage: "CLOSED", close_reason: "rejected" } });
    g.client.responses[REACTIONS] = [reaction(322, "-1"), reaction(323, "+1")];
    await g.tick();
    expect(g.posts.comments).toEqual([]);
    expect(await g.store.listVerdicts(g.item.id)).toEqual([]);
  });
});

// ---- Slack ----------------------------------------------------------------------------------------------------

const ROOT = "1800000001.000100";
/** The factory's spec message in the item's thread, posted a minute after the thread started. */
const SPEC_TS = "1800000061.000100";
const threadSource = (): SourceRef => ({ type: "slack_thread", id: slackSourceId({ team: TEAM, channel: CHANNEL, thread_ts: ROOT }), link: "" });
const reacted = (user: string, emoji: string, ts = SPEC_TS, at = Number(SPEC_TS) + 3600, channel = CHANNEL) =>
  eventEnvelope({ type: "reaction_added", user, reaction: emoji, item: { type: "message", channel, ts }, item_user: "U0BOT", event_ts: `${Math.floor(at)}.000200` });

async function slack() {
  const clock = new FakeClock("2027-01-15T08:00:00Z");
  const { store } = await newStore(clock);
  const api = new FakeSlackApi();
  const src = new SlackSource({ api, connect: new FakeSocket().connect, channels: [CHANNEL], scanner: cleanScanner, store, auth: new ReactionAuth(), repo: { owner: "o", name: "r" }, log: silent });
  const posts = new FakeSource("slack_thread");
  const controller = new ControllerRole({ store, sources: [posts], auth: new ReactionAuth(), clock, config, log: silent, scanner: cleanScanner });
  const { item: created } = await store.createWorkItem(
    { source: { ...threadSource(), link: "https://slack.com/archives/x" }, requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system,
  );
  const r = await store.transition({
    id: created.id, expected_version: created.version, actor: system, reason: "test",
    patch: { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" },
  });
  if (!r.ok) throw new Error(r.reason);
  await store.recordPrHead({ id: created.id, expected_head: null, head_sha: "h7", manual: null });
  const source = threadSource();
  await store.recordPostedComment({ source_id: source.id, marker: "<!-- factory:spec -->", comment_id: SPEC_TS, url: "u", body: "spec" });
  await store.recordPostedComment({ source_id: source.id, marker: "slack:status", comment_id: "1800000002.000100", url: "u", body: "Status" });
  const me = { team_id: TEAM, user_id: "U0BOT" };
  /** Maps one envelope through the Slack source and hands its event, if any, to the controller. */
  const deliver = async (env: Record<string, unknown>) => {
    const m = await src.toEvent(env, me);
    if (m) await controller.handleEvent(m.event);
    return m;
  };
  return { store, posts, controller, item: created, deliver };
}

describe("Slack: reactions on the factory's messages in an item's thread", () => {
  it("👍 stores accept/none on the item for its PR head, keyed on the reaction; a redelivery stores nothing more", async () => {
    const s = await slack();
    const m = await s.deliver(reacted("U0ALICE", "+1"));
    expect(m?.event).toMatchObject({ kind: "verdict_submitted", target: { kind: "issue" }, reaction: "+1" });
    await s.deliver(reacted("U0ALICE", "thumbsup"));
    expect((await s.store.listVerdicts(s.item.id)).map((v) => [v.comment_id, v.verdict, v.severity, v.pr_head, v.target])).toEqual([
      [`reaction:slack:${CHANNEL}:${SPEC_TS}:U0ALICE:+1`, "accept", "none", "h7", "issue"],
    ]);
    expect(s.posts.comments).toEqual([]);
  });

  it("👎 posts one follow-up in the thread; the `/verdict changes` reply stores the severity", async () => {
    const s = await slack();
    await s.deliver(reacted("U0ALICE", "-1::skin-tone-2"));
    await s.deliver(reacted("U0ALICE", "-1"));
    expect(await s.store.listVerdicts(s.item.id)).toEqual([]);
    expect(s.posts.comments.map((c) => [c.source.id, c.body])).toEqual([[threadSource().id, SEVERITY_FOLLOW_UP]]);
    await s.controller.handleEvent({ kind: "verdict_submitted", target: { kind: "issue", source: threadSource() }, comment_id: "1800000070.000100", approver: { provider: "slack", subject: "U0ALICE" }, args: "changes major wrong file" });
    expect((await s.store.listVerdicts(s.item.id)).map((v) => [v.verdict, v.severity, v.reason])).toEqual([["changes", "major", "wrong file"]]);
  });

  it.each([
    ["an unlinked Slack user", reacted("U0STRANGER", "+1")],
    ["a linked user without record_verdict", reacted("U0MALLORY", "-1")],
  ])("%s: nothing stored, nothing posted", async (_name, env) => {
    const s = await slack();
    await s.deliver(env);
    expect(await s.store.listVerdicts(s.item.id)).toEqual([]);
    expect(s.posts.comments).toEqual([]);
  });

  it.each([
    ["another emoji", reacted("U0ALICE", "heart")],
    ["the bot's own 👀", reacted("U0BOT", "eyes")],
    ["the bot's own 👍", reacted("U0BOT", "+1")],
    ["the status message", reacted("U0ALICE", "+1", "1800000002.000100")],
    ["a message the factory has no record of", reacted("U0ALICE", "+1", "1800000099.000100")],
    ["a message older than 7 days", reacted("U0ALICE", "+1", SPEC_TS, Number(SPEC_TS) + 8 * 24 * 3600)],
    ["a channel that is not configured", reacted("U0ALICE", "+1", SPEC_TS, Number(SPEC_TS) + 60, "C0UNLISTED")],
  ])("%s: no event", async (_name, env) => {
    const s = await slack();
    expect(await s.deliver(env)).toBeNull();
    expect(await s.store.listVerdicts(s.item.id)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { githubCommand } from "../src/core/command-inbox.js";
import type { SourceRef, UserId, WorkItem, WorkItemPatch } from "../src/core/types.js";
import type { AuthDecision, AuthProvider, ExternalIdentity, Principal } from "../src/interfaces/auth-provider.js";
import { runLocalCli } from "../src/core/local-cli.js";
import { FakeForge, FakeSandbox, FakeSlackPollSource, FakeSource, cleanScanner, config, issueRef, silent, slackRef } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

// A merge command from the command inbox on a non-local item (design 04-gate-commands, 2026-11-18): a GitHub `/merge`
// comment row or `factory merge <id>`. Before, the row went through the comment-event mapping, which has no `merge`
// case, so the handler returned at the null event: no merge_pr action, no reply (inbound command 1056, PR #692). Now
// it takes the Merge button's PR merge (requestPrMerge) or posts one refusal under `factory:refused:<row key>`.

const OWNER = "local:owner" as UserId;
const REQUESTER = "local:requester" as UserId;
/** GitHub user 7 is the owner, 8 a linked user without approve_merge, 9 linked to nobody. */
const LINKED: Record<string, UserId> = { "github:7": OWNER, "github:8": REQUESTER, "local:owner": OWNER };
const READY: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

class Roles implements AuthProvider {
  asked: string[] = [];
  async resolve(i: ExternalIdentity): Promise<Principal | null> {
    const id = LINKED[`${i.provider}:${i.subject}`];
    return id ? { user_id: id } : null;
  }
  async authorize(p: Principal, action: string): Promise<AuthDecision> {
    this.asked.push(action);
    return p.user_id === OWNER ? { allow: true } : { allow: false, reason: "no_role" };
  }
}

async function harness(opts: { forge?: boolean } = {}) {
  const { store, clock } = await newStore();
  const source = new FakeSource();
  const slack = new FakeSlackPollSource();
  const forge = new FakeForge();
  const sandbox = new FakeSandbox();
  const roles = new Roles();
  const controller = new ControllerRole({
    store, sources: [source, slack], forge: opts.forge === false ? null : forge, sandbox, auth: roles, clock, config, log: silent, scanner: cleanScanner,
  });
  const actor = { kind: "system" as const, id: "system:test" };
  let n = 0;
  /** A tier-4 item on its own issue (or `src`) in `patch`'s state, with PR #42 reviewed at `head`. */
  const itemIn = async (patch: WorkItemPatch = READY, head: string | null = "h1", src?: SourceRef): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: src ?? issueRef(++n), requester_id: REQUESTER, project: PROJECT_KEY, problem: "p", resources: [] }, actor);
    const r = await store.transition({ id: item.id, expected_version: item.version, actor, reason: "setup", patch: { change_ref: "42", ...patch, tier: 4 } });
    if (!r.ok) throw new Error("setup failed");
    if (head !== null) await store.recordPrHead({ id: item.id, expected_head: null, head_sha: head, manual: null });
    return (await store.getWorkItem(item.id))!;
  };
  let comments = 1000;
  /** A `/merge` comment by GitHub user `user` on PR #42's conversation (or the item's issue), as the forge poll stores it. Its row key. */
  const comment = async (it: WorkItem, user = 7, onPr = true): Promise<string> => {
    const pr = { change_ref: "42", head_branch: `factory/${it.id}` };
    const row = githubCommand({ comment_id: ++comments, user_id: user, command: "merge", text: "", source: onPr ? issueRef(42) : it.source, ...(onPr ? { pr } : {}) });
    await store.appendCliCommand(row);
    await controller.tickCommands();
    return row.key;
  };
  /** `factory merge <id>` by the owner. Its row key. */
  const cli = async (it: WorkItem): Promise<string> => {
    const key = `cli:m${++comments}`;
    await store.appendCliCommand({ key, actor: OWNER, command: "merge", args: { item: it.id } });
    await controller.tickCommands();
    return key;
  };
  const mergeActions = async () =>
    (await store.db.all("SELECT intent_key, target, args FROM outbound_actions WHERE action = 'merge_pr' ORDER BY seq")) as { intent_key: string; target: string; args: string }[];
  const queueEntries = async () => store.db.all("SELECT * FROM controller_merge_queue_entries");
  const posted = async (it: WorkItem, key: string) =>
    (await store.listItemMessages(it.id)).filter((m) => m.marker === `<!-- factory:refused:${key} -->`).map((m) => m.body);
  /** `factory merge <id>` typed by the owner in a terminal, through the CLI itself. Its printed lines. */
  const terminal = async (it: WorkItem): Promise<{ code: number; lines: string[] }> => {
    const r = await runLocalCli(
      { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: OWNER, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `t${++comments}` },
      { action: "command", command: "merge", id: it.id, text: "" },
    );
    await controller.tickCommands();
    return r;
  };
  return { store, source, slack, forge, sandbox, roles, controller, itemIn, comment, cli, terminal, mergeActions, queueEntries, posted };
}

describe("a /merge comment row on a tier-4 GitHub PR item at merge_pending (inbound command 1056)", () => {
  it("writes one merge_pr action keyed on the row, at the reviewed head, with no merge-queue entry and no refusal", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    const key = await h.comment(it1);

    const actions = await h.mergeActions();
    expect(actions.map((a) => a.intent_key)).toEqual([`merge_pr:${it1.id}:${key}`]);
    expect(JSON.parse(actions[0]!.args)).toMatchObject({ pr: 42, head_sha: "h1", change_ref: "42", by: OWNER, reply_key: key });
    expect(await h.queueEntries()).toEqual([]);
    expect(await h.posted(it1, key)).toEqual([]);
    expect(h.roles.asked).toEqual(["approve_merge"]);

    // Outbound merges the PR at that head and the item closes.
    await h.controller.tickOutbox();
    expect(h.forge.mergeCalls).toEqual([{ pr: 42, head_sha: "h1", method: "merge" }]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("on the item's own issue (no PR on the row) takes the same path", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    const key = await h.comment(it1, 7, false);
    expect((await h.mergeActions()).map((a) => a.intent_key)).toEqual([`merge_pr:${it1.id}:${key}`]);
  });

  it("delivered twice writes the action once", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    const key = await h.comment(it1);
    await h.controller.tickCommands();
    expect((await h.mergeActions()).filter((a) => a.intent_key === `merge_pr:${it1.id}:${key}`)).toHaveLength(1);
  });
});

describe("a merge that cannot start gets one posted reason and no merge_pr action", () => {
  it("with no forge selected", async () => {
    const h = await harness({ forge: false });
    const it1 = await h.itemIn();
    const key = await h.comment(it1, 7, false);
    expect(await h.mergeActions()).toEqual([]);
    expect(await h.posted(it1, key)).toEqual([expect.stringMatching(/^`\/merge` was not applied: no forge is selected/)]);
  });

  it("with the item not at merge_pending", async () => {
    const h = await harness();
    const it1 = await h.itemIn({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    const key = await h.comment(it1);
    expect(await h.mergeActions()).toEqual([]);
    expect(await h.posted(it1, key)).toEqual([expect.stringContaining("is not waiting for a merge")]);
    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
  });

  it("with no reviewed head", async () => {
    const h = await harness();
    const it1 = await h.itemIn(READY, null);
    const key = await h.comment(it1);
    expect(await h.mergeActions()).toEqual([]);
    expect(await h.posted(it1, key)).toEqual([expect.stringContaining("no reviewed head is recorded for PR #42")]);
  });

  it("from an actor not linked, or without approve_merge, with the existing refusal wording and nothing stored", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    const unlinked = await h.comment(it1, 9);
    const noRole = await h.comment(it1, 8);
    expect(await h.mergeActions()).toEqual([]);
    expect(await h.posted(it1, unlinked)).toEqual([expect.stringMatching(/^`\/merge` was not applied: .*link/)]);
    expect(await h.posted(it1, noRole)).toEqual(["`/merge` was not applied: only the owner may send this command (`no_role`)."]);
    expect(await h.store.getWorkItem(it1.id)).toEqual(it1);
  });
});

describe("`factory merge <id>` on a non-local item", () => {
  it("takes the same PR merge path", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    const key = await h.cli(it1);
    expect((await h.mergeActions()).map((a) => a.intent_key)).toEqual([`merge_pr:${it1.id}:${key}`]);
    expect(await h.queueEntries()).toEqual([]);
    expect(h.sandbox.gitCalls).toEqual([]);
  });

  it("posts one refusal when the merge cannot start", async () => {
    const h = await harness();
    const it1 = await h.itemIn({ stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" });
    const key = await h.cli(it1);
    expect(await h.mergeActions()).toEqual([]);
    expect(await h.posted(it1, key)).toEqual([expect.stringContaining("is not waiting for a merge")]);
  });
});

describe("a merge of a Slack-sourced item's PR (PR #692, item wi_26d4d6e4)", () => {
  it("a /merge on the PR's conversation finds the item by the PR and merges it", async () => {
    const h = await harness();
    const it1 = await h.itemIn(READY, "h1", slackRef(1));
    const key = await h.comment(it1);

    const actions = await h.mergeActions();
    expect(actions.map((a) => a.intent_key)).toEqual([`merge_pr:${it1.id}:${key}`]);
    expect(JSON.parse(actions[0]!.args)).toMatchObject({ pr: 42, head_sha: "h1", change_ref: "42", by: OWNER, reply_key: key });
    await h.controller.tickOutbox();
    expect(h.forge.mergeCalls).toEqual([{ pr: 42, head_sha: "h1", method: "merge" }]);
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });

  it("`factory merge <id>` stores its row with no refusal and takes the same merge_pr path", async () => {
    const h = await harness();
    const it1 = await h.itemIn(READY, "h1", slackRef(2));
    const r = await h.terminal(it1);
    expect(r.code).toBe(0);
    const rows = await h.store.listCliCommandsAfter(0, 10);
    expect(rows).toEqual([expect.objectContaining({ command: "merge", args: { item: it1.id } })]);
    expect((await h.mergeActions()).map((a) => a.intent_key)).toEqual([`merge_pr:${it1.id}:${rows[0]!.key}`]);
    await h.controller.tickOutbox();
    expect(await h.store.getWorkItem(it1.id)).toMatchObject({ stage: "CLOSED", close_reason: "completed" });
  });
});

describe("`factory merge <id>` on a GitHub-sourced item (decision 2)", () => {
  it("stores its row with no mirror flag, so no /merge comment is posted on the issue", async () => {
    const h = await harness();
    const it1 = await h.itemIn();
    expect((await h.terminal(it1)).code).toBe(0);
    expect(await h.store.listCliCommandsAfter(0, 10)).toEqual([expect.objectContaining({ command: "merge" })]);
    expect(await h.store.listUnmirroredCliCommands(10)).toEqual([]);
    await h.controller.tickOutbox();
    expect(h.source.comments.filter((c) => c.body.includes("/merge"))).toEqual([]);
  });
});

describe("a /merge comment that matches no work item", () => {
  it("gets exactly one reply on its own conversation, also when the row is delivered twice", async () => {
    const h = await harness();
    const row = githubCommand({ comment_id: 5000, user_id: 7, command: "merge", text: "", source: issueRef(77), pr: { change_ref: "77", head_branch: "someone/topic" } });
    await h.store.appendCliCommand(row);
    await h.controller.tickCommands();
    await h.controller.tickCommands();
    await h.controller.tickOutbox();
    await h.controller.tickOutbox();
    expect(await h.mergeActions()).toEqual([]);
    const marker = `<!-- factory:refused:${row.key} -->`;
    const posts = (await h.store.db.all("SELECT target, args FROM outbound_actions WHERE action = 'post'")) as { target: string; args: string }[];
    expect(posts.filter((p) => p.args.includes(marker))).toHaveLength(1);
    expect(h.source.comments.filter((c) => c.marker === marker)).toEqual([
      expect.objectContaining({ source: issueRef(77), body: "`/merge` was not applied: no work item matches this comment." }),
    ]);
  });
});

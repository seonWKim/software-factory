import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ANONYMOUS_USER, OwnerAuth } from "../src/core/authorize.js";
import type { Actor, UserId, WorkItem } from "../src/core/types.js";
import { newLinkCode } from "../src/impl/auth/link-code.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { AuthAction, ExternalIdentity } from "../src/interfaces/auth-provider.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { FakeSource, cleanScanner, config, issueRef, recordingLog } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// One owner check (design 08-permissions, issue #575): a gate command is allowed only when its factory user is the
// owner, the store's local owner (claimed by `cli_user`), whatever surface it came from: GitHub, Slack, the CLI or
// the dashboard. Anyone else is refused as `not_owner` with one reply.

const OWNER = "local:owner@example.com" as UserId;
const REPLY = "`/approve` was not applied: only the owner may send this command.";
const system: Actor = { kind: "system", id: "system:test" };
const gh = (subject: string): ExternalIdentity => ({ provider: "github", subject });
const slack = (subject: string): ExternalIdentity => ({ provider: "slack", subject });

async function setup() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  await store.claimLocalOwner(OWNER);
  const link = async (user: UserId, who: ExternalIdentity) => {
    const code = newLinkCode();
    await store.createLinkCode(user, code);
    expect(await store.redeemLinkCode(code, { provider: who.provider, subject: who.subject })).toMatchObject({ ok: true });
  };
  // The owner's own accounts: GitHub account 1 and Slack user U1. U2 is someone else's Slack account.
  await link(OWNER, gh("1"));
  await link(OWNER, slack("U1"));
  await link("local:bob@example.com" as UserId, slack("U2"));
  const auth = new OwnerAuth({ store, claimer: null });
  const source = new FakeSource();
  const controller = new ControllerRole({ store, source, auth, clock, config, log: recordingLog(), scanner: cleanScanner });
  let n = 0;
  /** A GitHub item at the spec gate. */
  const atSpecGate = async (): Promise<WorkItem> => {
    const { item } = await store.createWorkItem({ source: issueRef(++n), requester_id: OWNER, project: PROJECT_KEY, problem: "p", resources: [] }, system);
    const r = await store.transition({
      id: item.id, expected_version: item.version, actor: system, reason: "test",
      patch: { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" },
    });
    if (!r.ok) throw new Error("setup transition failed");
    return r.item;
  };
  const approver = async (it: WorkItem) => (await store.listStateChanges(it.id)).find((c) => c.reason === "spec_approved")?.actor ?? null;
  /** A comment-borne `/approve` from `who` (a GitHub or Slack account): the item and the refusals it got. */
  const comment = async (it: WorkItem, who: ExternalIdentity) => {
    const comment_id = `c${++n}`;
    source.queue.push({ kind: "spec_approved", source: it.source, comment_id, approver: who });
    await controller.tickIntake();
    return { item: (await store.getWorkItem(it.id))!, refusals: source.comments.filter((c) => c.marker === `<!-- factory:refused:${comment_id} -->`).map((c) => c.body) };
  };
  /** A `factory approve` from the CLI as `actor`. */
  const cli = async (it: WorkItem, actor: UserId) => {
    await store.appendCliCommand({ key: `cli:${++n}`, actor, command: "approve", args: { item: it.id, source: it.source } });
    await controller.tickCommands();
    return (await store.getWorkItem(it.id))!;
  };
  /** The dashboard's Approve button as `actor`: one app command request. */
  const dashboard = async (it: WorkItem, actor: UserId) => {
    const { request } = await store.recordAppCommandRequest({ key: `app${++n}`, actor, command: "approve", args: { work_item_id: it.id } });
    await controller.tickCommands();
    return { item: (await store.getWorkItem(it.id))!, request: (await store.getAppCommandRequest(request.seq))! };
  };
  return { store, auth, atSpecGate, approver, comment, cli, dashboard };
}

describe("one owner check: the owner is allowed on every surface", () => {
  it("a gate command from the owner's GitHub account is allowed, as the owner", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    const { item, refusals } = await f.comment(it, gh("1"));
    expect(refusals).toEqual([]);
    expect(item.stage).toBe("RUNNING");
    expect(await f.approver(it)).toEqual({ kind: "user", id: OWNER });
  });

  it("a gate command from the owner's linked Slack account is allowed, as the owner", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    const { item, refusals } = await f.comment(it, slack("U1"));
    expect(refusals).toEqual([]);
    expect(item.stage).toBe("RUNNING");
    expect(await f.approver(it)).toEqual({ kind: "user", id: OWNER });
  });

  it("a gate command from the local CLI as the owner is allowed", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    expect((await f.cli(it, OWNER)).stage).toBe("RUNNING");
    expect(await f.approver(it)).toEqual({ kind: "user", id: OWNER });
  });

  it("a gate command from the dashboard as the owner is allowed", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    const { item, request } = await f.dashboard(it, OWNER);
    expect(request.refusal).toBeNull();
    expect(item.stage).toBe("RUNNING");
    expect(await f.approver(it)).toEqual({ kind: "user", id: OWNER });
  });
});

describe("one owner check: anyone else is refused as not_owner", () => {
  it("the same gate command from any other GitHub account is refused with the owner reply, and nothing changes", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    const { item, refusals } = await f.comment(it, gh("666"));
    expect(refusals).toEqual([REPLY]);
    expect(item).toEqual(it);
    expect(await f.auth.authorize({ user_id: "github:666" as UserId, attributes: {} }, "approve_spec")).toEqual({ allow: false, reason: "not_owner" });
  });

  it("the same gate command from any other Slack account is refused with the owner reply, and nothing changes", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    const { item, refusals } = await f.comment(it, slack("U2"));
    expect(refusals).toEqual([REPLY]);
    expect(item).toEqual(it);
  });

  it("the anonymous identity is never the owner: its gate command is refused, and it never claims an empty store", async () => {
    const f = await setup();
    const it = await f.atSpecGate();
    expect(await f.cli(it, ANONYMOUS_USER)).toEqual(it);
    const fresh = new OwnerAuth({ store: (await newStore(new FakeClock())).store, claimer: ANONYMOUS_USER });
    expect(await fresh.authorize({ user_id: ANONYMOUS_USER, attributes: {} }, "approve_spec")).toEqual({ allow: false, reason: "not_owner" });
  });

  it("a stored role grants nothing: an approver who is not the owner is refused", async () => {
    const f = await setup();
    await f.store.setLocalUserRole("local:bob@example.com" as UserId, "approver", OWNER);
    const it = await f.atSpecGate();
    const { item, refusals } = await f.comment(it, slack("U2"));
    expect(refusals).toEqual([REPLY]);
    expect(item.stage).toBe("READY");
  });
});

describe("one owner check: the rule", () => {
  const actions: AuthAction[] = ["approve_spec", "approve_merge", "record_verdict", "use_tool", "approve_tool"];

  it("every gate action needs the owner; submit_work stays open (intake keeps its own gate on the source)", async () => {
    const { store } = await newStore(new FakeClock());
    await store.claimLocalOwner(OWNER);
    const auth = new OwnerAuth({ store, claimer: null });
    const as = (user_id: string, a: AuthAction) => auth.authorize({ user_id: user_id as UserId, attributes: {} }, a);
    for (const a of actions) {
      expect(await as(OWNER, a), a).toEqual({ allow: true });
      expect(await as("github:2", a), a).toEqual({ allow: false, reason: "not_owner" });
    }
    expect(await as("github:2", "submit_work")).toEqual({ allow: true });
  });

  it("while the store has no owner, only the claimer (cli_user) becomes it; nobody else does", async () => {
    const { store } = await newStore(new FakeClock());
    const auth = new OwnerAuth({ store, claimer: OWNER });
    expect(await auth.authorize({ user_id: "github:2" as UserId, attributes: {} }, "approve_spec")).toEqual({ allow: false, reason: "not_owner" });
    expect(await store.listLocalUsers()).toEqual([]);
    expect(await auth.authorize({ user_id: OWNER, attributes: {} }, "approve_spec")).toEqual({ allow: true });
    expect((await store.listLocalUsers()).map((u) => [u.user_id, u.role])).toEqual([[OWNER, "owner"]]);
  });

  it("resolves a linked account to its user, an unlinked GitHub account to github:<id>, an unlinked Slack account to no user", async () => {
    const f = await setup();
    expect(await f.auth.resolve(slack("U1"))).toEqual({ user_id: OWNER, attributes: {} });
    expect(await f.auth.resolve(gh("7"))).toEqual({ user_id: "github:7", attributes: {} });
    expect(await f.auth.resolve({ provider: "local", subject: "me@example.com" })).toEqual({ user_id: "local:me@example.com", attributes: {} });
    expect(await f.auth.resolve(slack("U404"))).toBeNull();
  });

  it("no code asks GitHub for a repository permission", () => {
    const SRC = join(import.meta.dirname, "..", "src");
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
    expect(files(SRC).filter((f) => /\/collaborators\//.test(readFileSync(f, "utf8"))).map((f) => relative(SRC, f))).toEqual([]);
  });

  it("the controller decides permission only through its one authorize helper", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "src", "controller", "units", "auth", "auth.unit.ts"), "utf8");
    expect(text.match(/\.authorize\(principal, action/g)).toHaveLength(1);
  });
});

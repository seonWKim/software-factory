import { describe, expect, it } from "vitest";
import type { FactoryConfig } from "../src/core/config.js";
import { Controller } from "../src/core/controller.js";
import { LiveSettings, baseFromConfig } from "../src/core/settings.js";
import { PROTECTED_PATHS, protectedCategory } from "../src/core/standing.js";
import type { Tier, WorkItem, WorkerId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { newStore } from "./helpers/store.js";
import { FakeAuth, FakeForge, FakeSource, alice, cleanScanner, config, issueRef, mallory, silent, triageSpec } from "./helpers/fakes.js";

const RULE = "spec-t1";
/** A floor at tier 1, so a spec that touches it stays at tier 1 and only the floor-path check keeps it at the gate. */
const LOW_FLOOR = "docs/floor/";

async function factory() {
  const cfg: FactoryConfig = {
    ...config,
    settings: { ...config.settings, defaults: { ...config.settings.defaults, floors: [...(config.settings.defaults.floors ?? []), { prefix: LOW_FLOOR, tier: 1 }] } },
  };
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const source = new FakeSource();
  const forge = new FakeForge(source);
  const settings = new LiveSettings({ config: cfg, base: baseFromConfig(cfg), source: store });
  const controller = new Controller({
    store, source, forge, auth: new FakeAuth(), clock, config: cfg, settings, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
  });
  let n = 0;
  let comment = 1000;
  const claimTriage = () => store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["triage"], lease_ms: 60_000 });
  const send = async (e: SourceEvent) => {
    clock.advance(1000);
    source.queue.push(e);
    await controller.tickIntake();
  };
  /** A new item whose triage run answered with a spec of `tier` touching `paths`. */
  const triaged = async (tier: Tier = 1, paths: string[] = ["docs/guide.md"]): Promise<WorkItem> => {
    const src = issueRef(++n);
    await send({ kind: "item_requested", source: src, requester: alice, title: `t${n}`, body: "b" });
    const spec = { ...triageSpec, tier, allowed_paths: paths, files_to_change: paths };
    // Every queued triage run gets this spec: a revised item's new triage run too.
    for (let run = await claimTriage(); run; run = await claimTriage()) {
      await store.completeRun(run.id, run.lease!.token, { status: "succeeded", summary: "s", data: { spec, tokens: 10 } });
    }
    clock.advance(1000);
    await controller.tickRuns();
    return (await store.getWorkItemBySource("github_issue", src.id))!;
  };
  const approve = (it: WorkItem, cid = String(++comment)) =>
    send({ kind: "spec_approved", source: it.source, comment_id: cid, approver: alice, note: "" });
  const standing = (it: WorkItem, args: string, who = alice, cid = String(++comment)) =>
    send({ kind: "standing_requested", source: it.source, comment_id: cid, requester: who, args });
  /** `count` tier 1 specs, each approved in turn. */
  const approvals = async (count: number): Promise<WorkItem[]> => {
    const out: WorkItem[] = [];
    for (let i = 0; i < count; i++) {
      const it = await triaged();
      await approve(it);
      out.push(it);
    }
    return out;
  };
  const posts = (prefix: string, it?: WorkItem) =>
    source.comments.filter((c) => c.marker.startsWith(`<!-- factory:${prefix}`) && (!it || c.source.id === it.source.id));
  const rule = async () => (await store.listStandingRules()).find((r) => r.gate === "spec" && r.tier === 1);
  const get = async (it: WorkItem) => (await store.getWorkItem(it.id))!;
  return { clock, store, source, controller, settings, triaged, approve, standing, approvals, posts, rule, get, send, next: () => String(++comment) };
}

type F = Awaited<ReturnType<typeof factory>>;

async function ruleOn(f: F): Promise<void> {
  const host = await f.triaged(2);
  await f.standing(host, `accept ${RULE}`);
  expect((await f.rule())?.enabled).toBe(true);
}

describe("standing approvals: the proposal", () => {
  it("ten tier 1 approvals in a row post one proposal on the tenth item; later approvals and a second check post nothing", async () => {
    const f = await factory();
    const items = await f.approvals(10);
    const tenth = items.at(-1)!;
    expect(items.slice(0, -1).flatMap((it) => f.posts("standing-proposal", it))).toEqual([]);
    const proposal = f.posts("standing-proposal", tenth);
    expect(proposal).toHaveLength(1);
    expect(proposal[0]!.body).toContain(`/standing accept ${RULE}`);
    expect(proposal[0]!.body).toContain(`/standing decline ${RULE}`);
    expect(await f.store.listStandingProposals()).toContainEqual(expect.objectContaining({ gate: "spec", tier: 1, run_length: 10, threshold: 10 }));

    const later = await f.approvals(2);
    expect(later.flatMap((it) => f.posts("standing-proposal", it))).toEqual([]);
    // The check run again for the tenth item (another replica, a repeat) finds the same proposal and posts nothing.
    await (f.controller as unknown as { proposeStanding(it: WorkItem): Promise<void> }).proposeStanding(await f.get(tenth));
    await f.controller.tickOutbox();
    expect(f.posts("standing-proposal")).toHaveLength(1);
  });

  it("a redelivered /approve on the tenth item posts nothing new", async () => {
    const f = await factory();
    await f.approvals(9);
    const tenth = await f.triaged();
    const cid = f.next();
    await f.approve(tenth, cid);
    await f.approve(tenth, cid);
    expect(f.posts("standing-proposal")).toHaveLength(1);
    expect(f.posts("refused:", tenth)).toEqual([]);
  });

  it("approvals at other tiers neither count nor get a proposal", async () => {
    const f = await factory();
    for (let i = 0; i < 10; i++) await f.approve(await f.triaged(2));
    expect(f.posts("standing-proposal")).toEqual([]);
  });

  it("a declined proposal is not posted again until the run resets and reaches the threshold again", async () => {
    const f = await factory();
    const first = await f.approvals(10);
    await f.standing(first.at(-1)!, `decline ${RULE}`);
    expect(await f.rule()).toMatchObject({ enabled: false, set_by: "github:1" });
    expect(f.posts("standing:", first.at(-1)!)).toHaveLength(1);
    // A raised threshold met in the same run stays quiet: the decline was during this run.
    await f.store.setSettingOverride({ key: "standing_approvals.threshold", project: "", value: "12", actor: "github:1" });
    await f.approvals(4);
    expect(f.posts("standing-proposal")).toHaveLength(1);
    // A /revise at tier 1 resets the run; twelve more approvals reach the threshold again.
    const revised = await f.triaged();
    await f.send({ kind: "revise_requested", source: revised.source, comment_id: f.next(), requester: alice, feedback: "narrower" });
    const second = await f.approvals(12);
    expect(f.posts("standing-proposal", second.at(-1)!)).toHaveLength(1);
    expect(f.posts("standing-proposal")).toHaveLength(2);
  });

  it("reads standing_approvals.threshold at each decision, with no restart", async () => {
    const f = await factory();
    await f.store.setSettingOverride({ key: "standing_approvals.threshold", project: "", value: "3", actor: "github:1" });
    const items = await f.approvals(3);
    expect(f.posts("standing-proposal", items.at(-1)!)).toHaveLength(1);
    expect(f.posts("standing-proposal", items.at(-1)!)[0]!.body).toContain("`standing_approvals.threshold` = 3");
  });
});

describe("standing approvals: /standing", () => {
  it("accept turns the rule on with the user's ID; a second accept or a redelivery changes nothing and posts nothing new", async () => {
    const f = await factory();
    const it = await f.triaged(2);
    const cid = f.next();
    await f.standing(it, `accept ${RULE}`, alice, cid);
    const on = await f.rule();
    expect(on).toMatchObject({ enabled: true, set_by: "github:1" });
    expect(f.posts("standing:", it)).toHaveLength(1);
    expect(f.posts("standing:", it)[0]!.body).toContain(`standing:${RULE}`);
    // Redelivered (the same comment, handled directly) and a second accept in a new comment.
    f.clock.advance(1000);
    await f.controller.handleEvent({ kind: "standing_requested", source: it.source, comment_id: cid, requester: alice, args: `accept ${RULE}` });
    await f.standing(it, `accept ${RULE}`);
    expect(await f.rule()).toEqual(on);
    expect(f.posts("standing:", it)).toHaveLength(1);
    expect(f.posts("refused:", it)).toEqual([]);
  });

  it("with no arguments shows the rule's state", async () => {
    const f = await factory();
    const it = await f.triaged(2);
    await f.standing(it, "");
    expect(f.posts("standing:", it)[0]!.body).toMatch(new RegExp(`\`${RULE}\`.*: off`));
    expect(await f.rule()).toBeUndefined();
  });

  it("is refused for a user who may not approve specs, and for an unknown rule or action", async () => {
    const f = await factory();
    const it = await f.triaged(2);
    await f.standing(it, `accept ${RULE}`, mallory);
    await f.standing(it, "accept spec-t3");
    await f.standing(it, "maybe");
    const refusals = f.posts("refused:", it).map((c) => c.body);
    expect(refusals).toHaveLength(3);
    expect(refusals[0]).toContain("write permission");
    expect(refusals[1]).toContain("`spec-t1`");
    expect(refusals[2]).toContain("/standing accept <rule>");
    expect(await f.rule()).toBeUndefined();
  });
});

describe("standing approvals: the rule at the spec gate", () => {
  it("approves the next tier 1 spec as standing:<rule-id> with the owner's user ID, and its note names the rule and how to turn it off", async () => {
    const f = await factory();
    await ruleOn(f);
    const it = await f.get(await f.triaged(1));
    expect(it).toMatchObject({ stage: "RUNNING", blocked_on: "none" });
    const change = (await f.store.listStateChanges(it.id)).find((c) => c.reason === "standing_approved")!;
    expect(change.actor).toEqual({ kind: "system", id: `standing:${RULE}` });
    expect(change.detail).toMatchObject({ standing_rule: RULE, owner_id: "github:1", gate: "spec", tier: 1 });
    expect((await f.store.listRuns(it.id)).some((r) => r.kind === "implement" && r.status === "queued")).toBe(true);
    const note = f.posts("spec:", it)[0]!.body;
    expect(note).toContain(`standing rule \`${RULE}\``);
    expect(note).toContain(`/standing decline ${RULE}`);
  });

  it("leaves a tier 2 spec at the gate", async () => {
    const f = await factory();
    await ruleOn(f);
    expect(await f.get(await f.triaged(2))).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  const protectedCases: [string, string][] = [
    ["gates", "src/core/policy.ts"],
    ["prompts", "prompts/triage.md"],
    ["permissions", "src/impl/grant/github-grant.ts"],
    ["permissions", ".claude/settings.json"],
    ["tools", "src/core/tools/bash.ts"],
    ["guard_settings", "factory.config.json"],
    ["floor_paths", `${LOW_FLOOR}x.md`],
  ];

  it.each(protectedCases)("never approves a spec whose allowed paths touch %s (%s)", async (category, path) => {
    const f = await factory();
    await ruleOn(f);
    const it = await f.get(await f.triaged(1, ["docs/guide.md", path]));
    expect(it.tier).toBe(1);
    expect(it).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(protectedCategory([path], [{ prefix: LOW_FLOOR, tier: 1 }])).toBe(category);
  });

  it("each category has prefixes, and a path that covers one counts as touching it", () => {
    for (const prefixes of Object.values(PROTECTED_PATHS)) expect(prefixes.length).toBeGreaterThan(0);
    expect(protectedCategory(["src/impl/"], [])).toBe("permissions");
    expect(protectedCategory(["docs/guide.md"], [])).toBeNull();
  });
});

describe("standing approvals: the owner turns a rule off", () => {
  /** A tier 1 item the rule approved, whose implement run failed too large, so `/revise` and `/reject` apply. */
  async function approvedByRule(f: F): Promise<WorkItem> {
    const it = await f.triaged(1);
    const run = (await f.store.claimRun({ worker_id: "w1" as WorkerId, kinds: ["implement"], lease_ms: 60_000 }))!;
    await f.store.completeRun(run.id, run.lease!.token, { status: "failed", error_code: "diff_too_large", detail: "too big", infra: false });
    await f.controller.tickRuns();
    expect(await f.get(it)).toMatchObject({ blocked_on: "human" });
    return it;
  }

  it.each([
    ["/reject", (it: WorkItem, cid: string): SourceEvent => ({ kind: "spec_rejected", source: it.source, comment_id: cid, approver: alice, reason: "no" })],
    ["/revise", (it: WorkItem, cid: string): SourceEvent => ({ kind: "revise_requested", source: it.source, comment_id: cid, requester: alice, feedback: "smaller" })],
  ])("%s on an item the rule approved turns it off with one reply", async (cmd, event) => {
    const f = await factory();
    await ruleOn(f);
    const it = await approvedByRule(f);
    const cid = f.next();
    await f.send(event(it, cid));
    expect(await f.rule()).toMatchObject({ enabled: false, set_by: "github:1" });
    const replies = f.posts("standing-off:", it);
    expect(replies).toHaveLength(1);
    expect(replies[0]!.body).toContain(`\`${cmd}\``);
    expect(replies[0]!.body).toContain(`/standing accept ${RULE}`);
    // The next tier 1 spec waits for /approve again.
    expect(await f.get(await f.triaged(1))).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("a /reject on an item a person approved leaves the rule on", async () => {
    const f = await factory();
    await ruleOn(f);
    const it = await f.triaged(2);
    await f.send({ kind: "spec_rejected", source: it.source, comment_id: f.next(), approver: alice, reason: "no" });
    expect((await f.rule())?.enabled).toBe(true);
    expect(f.posts("standing-off:")).toEqual([]);
  });
});

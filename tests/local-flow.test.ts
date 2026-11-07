import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { GitHubAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { GrantSource, Role } from "../src/interfaces/auth-provider.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, FakeForge, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, mallory, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// A local task end to end (issue #200): filed and approved from the CLI, read by the `local` source, applied by
// the controller, built, reviewed, merged. Since issue #318 local commands are authorized by the `local` auth
// plugin (local users in the store), GitHub comments by the GitHub one: here GitHubAuthProvider over a static grant
// and a remote grant standing in for GitHub, which can be made unreachable.

const OWNER = "github:1" as UserId;
const ME = "local:me@example.com" as UserId;
const DEV = "local:dev@example.com" as UserId;
const ANON = "local:anonymous" as UserId;

/** The GitHub permission check: a remote grant that counts its calls and throws while GitHub is unreachable. */
class GitHubGrant implements GrantSource {
  readonly remote = true;
  calls = 0;
  reachable = true;
  async denies(): Promise<boolean> {
    return false;
  }
  async roles(): Promise<readonly Role[]> {
    this.calls++;
    if (!this.reachable) throw new Error("GitHub unreachable (rate limited)");
    return [];
  }
}

async function factory() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const forge = new FakeForge(gh);
  const local = new LocalSource(store);
  const github = new GitHubGrant();
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} }), github];
  const auth = new GitHubAuthProvider(store, grants);
  const local_auth = new LocalAuthProvider(store, grants);
  const controller = new Controller({
    store, sources: [gh, local], forge, auth, local_auth, clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
  });
  const runner = new FakeRunner({
    triage: () => ({ output: triageSpec }),
    implement: () => ({ output: { summary: "the summary", next_steps: "the next steps" } }),
    review: () => ({ output: { verdict: "pass", tier: 2, findings: [], summary: "s" } }),
  });
  const broker = new FakeBroker();
  const worker = new Worker({
    id: "w1" as WorkerId, store, sandbox: new FakeSandbox(), runner, broker, storage: new MemoryStorage(), clock, config, prompts,
    log: silent, scanner: cleanScanner, toolEnv: {}, awake: new NoKeepAwake(),
  });
  const step = async () => {
    await controller.tickIntake();
    while (await worker.tick()) await controller.tickRuns();
    await controller.tickRuns();
  };
  let n = 0;
  const cli = (user: UserId, a: CliAction) => {
    const d: LocalCliDeps = {
      store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}`,
    };
    return runLocalCli(d, a);
  };
  const refusals = async (id: WorkItemId) =>
    (await store.listItemMessages(id)).filter((m) => m.marker.startsWith("<!-- factory:refused:")).map((m) => m.body);
  return { clock, store, gh, forge, github, controller, broker, step, cli, refusals };
}

describe("local task flow", () => {
  it("solo: with the GitHub plugin selected and GitHub unreachable, a CLI task is approved, built, reviewed, merged, closed", async () => {
    const f = await factory();
    f.github.reachable = false;
    const created = await f.cli(ME, { action: "create", title: "Add a scope gate", bodyFile: "body.md" });
    expect(created.code).toBe(0);
    const id = created.lines[0] as WorkItemId;

    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    const spec = (await f.store.listItemMessages(id)).map((m) => m.body).join("\n");
    expect(spec).toContain(triageSpec.done_criteria[0]);

    expect((await f.cli(ME, { action: "command", command: "approve", id, text: "looks good" })).code).toBe(0);
    await f.step();
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: 42 });

    f.forge.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${id}`, merge_sha: "m1", merger: alice });
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });

    const reasons = (await f.store.listStateChanges(id)).map((c) => c.reason);
    const order = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "pr_merged"];
    const at = order.map((r) => reasons.indexOf(r));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const approval = (await f.store.listStateChanges(id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: ME });
    // The local owner, from the environment identity, with no link and no GitHub permission call.
    expect((await f.store.listLocalUsers()).map((u) => [u.user_id, u.role])).toEqual([[ME, "owner"]]);
    expect(await f.store.listLinks(ME)).toEqual([]);
    expect(f.github.calls).toBe(0);

    // No issue was created on the fake GitHub, and nothing about the local item was posted there.
    expect(f.gh.subIssues).toEqual([]);
    expect(f.gh.subIssueCalls).toBe(0);
    expect(f.gh.comments.filter((c) => c.source.type === "local")).toEqual([]);
    expect(f.broker.calls.filter((c) => /issue/.test(c.name))).toEqual([]);
  });

  it("a GitHub comment is still authorized by the GitHub auth plugin", async () => {
    const f = await factory();
    await f.cli(ME, { action: "create", title: "t", bodyFile: "b" }); // a local owner exists; it is not a GitHub approver
    f.gh.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    await f.step();
    const item = (await f.store.getWorkItemBySource("github_issue", issueRef(5).id))!;
    expect(item).toMatchObject({ blocked_reason: "spec_pending" });

    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "900", approver: mallory, note: "" });
    await f.step();
    expect(f.gh.comments.find((c) => c.marker === "<!-- factory:refused:900 -->")!.body).toContain("needs write permission");
    expect(f.github.calls).toBeGreaterThan(0);
    // A local identity sent as a GitHub account is a GitHub account: the local owner row does not count there.
    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "901", approver: { provider: "github", subject: "1" }, note: "" });
    await f.step();
    expect((await f.store.listStateChanges(item.id)).find((c) => c.reason === "spec_approved")!.actor).toEqual({ kind: "user", id: OWNER });
  });

  it("enterprise: a local user without a role is refused; once the owner grants approver, the same command is applied", async () => {
    const f = await factory();
    const id = (await f.cli(ME, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    expect((await f.cli(DEV, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await f.step();
    const [refusal] = await f.refusals(id);
    expect(refusal).toContain(`factory users add ${DEV} --role approver`);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });

    expect((await f.cli(DEV, { action: "users_add", user: DEV, role: "approver" })).code).toBe(1);
    expect((await f.cli(ME, { action: "users_add", user: DEV, role: "approver" })).code).toBe(0);
    expect((await f.cli(DEV, { action: "command", command: "approve", id, text: "" })).code).toBe(0);
    await f.step();
    const approval = (await f.store.listStateChanges(id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: DEV });
  });

  it("anonymous may file a task but its approve is refused, and it never becomes the owner", async () => {
    const f = await factory();
    const id = (await f.cli(ANON, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    await f.cli(ANON, { action: "command", command: "approve", id, text: "" });
    await f.step();
    expect(await f.refusals(id)).toHaveLength(1);
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    expect(await f.store.listLocalUsers()).toEqual([]);
  });
});

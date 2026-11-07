import { describe, expect, it } from "vitest";
import { Controller } from "../src/core/controller.js";
import { type CliAction, type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkerId, WorkItemId } from "../src/core/types.js";
import { Worker } from "../src/core/worker.js";
import { GitHubAuthProvider } from "../src/impl/auth/github-auth-provider.js";
import { NoKeepAwake } from "../src/impl/awake/no-keep-awake.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { StaticGrant } from "../src/impl/grant/static.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import {
  FakeBroker, FakeRunner, FakeSandbox, FakeSource, MemoryStorage, alice, cleanScanner, config, issueRef, mallory, prompts, silent, triageSpec,
} from "./helpers/fakes.js";
import { PROJECT_KEY, newStore } from "./helpers/store.js";

// A local task end to end (issue #200): filed and approved from the CLI, read by the `local` source, applied by
// the controller with the real authorize check (GitHubAuthProvider over a static grant), built, reviewed, merged.

const OWNER = "github:1" as UserId;
const OUTSIDER = "github:666" as UserId;

/** Links the local account named `user` to that factory user, as a `/link` from it would. */
async function linkLocal(store: FactoryStore, user: UserId, code: string) {
  await store.createLinkCode(user, code);
  expect(await store.redeemLinkCode(code, { provider: "local", subject: user })).toMatchObject({ ok: true, user_id: user });
}

async function factory() {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const gh = new FakeSource();
  const local = new LocalSource(store);
  const grants = [new StaticGrant({ roles: { [OWNER]: { "*": ["approver"] } }, deny: {} })];
  const auth = new GitHubAuthProvider(store, grants);
  const controller = new Controller({ store, sources: [gh, local], auth, clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
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
  const cli = (user: UserId | null, a: CliAction) => {
    const d: LocalCliDeps = {
      store, user, project: async () => PROJECT_KEY, read: async () => "the body", newId: () => `id${++n}`,
    };
    return runLocalCli(d, a);
  };
  return { clock, store, gh, controller, broker, step, cli };
}

describe("local task flow", () => {
  it("files a task from the CLI, approves its spec from the CLI, and reaches implemented, reviewed, merged and closed", async () => {
    const f = await factory();
    await linkLocal(f.store, OWNER, "code-owner");
    const created = await f.cli(OWNER, { action: "create", title: "Add a scope gate", bodyFile: "body.md" });
    expect(created.code).toBe(0);
    const id = created.lines[0] as WorkItemId;

    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
    const spec = (await f.store.listItemMessages(id)).map((m) => m.body).join("\n");
    expect(spec).toContain(triageSpec.done_criteria[0]);

    const approved = await f.cli(OWNER, { action: "command", command: "approve", id, text: "looks good" });
    expect(approved.code).toBe(0);
    await f.step();
    await f.step();
    const reviewed = (await f.store.getWorkItem(id))!;
    expect(reviewed).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending", pr_number: 42 });

    f.gh.queue.push({ kind: "pr_merged", pr_number: 42, head_branch: `factory/${id}`, merge_sha: "m1", merger: alice });
    await f.step();
    expect(await f.store.getWorkItem(id)).toMatchObject({ stage: "CLOSED", close_reason: "completed", merge_sha: "m1" });

    const reasons = (await f.store.listStateChanges(id)).map((c) => c.reason);
    const order = ["intake", "triaged", "spec_approved", "implemented", "review_passed", "pr_merged"];
    const at = order.map((r) => reasons.indexOf(r));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const approval = (await f.store.listStateChanges(id)).find((c) => c.reason === "spec_approved")!;
    expect(approval.actor).toEqual({ kind: "user", id: OWNER });

    // No issue was created on the fake GitHub, and nothing about the local item was posted there.
    expect(f.gh.subIssues).toEqual([]);
    expect(f.gh.subIssueCalls).toBe(0);
    expect(f.gh.comments.filter((c) => c.source.type === "local")).toEqual([]);
    expect(f.broker.calls.filter((c) => /issue/.test(c.name))).toEqual([]);
  });

  it("a refused CLI command gets the same refusal text as the GitHub command for the same refusal", async () => {
    const f = await factory();
    await linkLocal(f.store, OUTSIDER, "code-outsider");

    // The same user, refused for the same reason: once on a GitHub item by comment, once on a local item by CLI.
    f.gh.queue.push({ kind: "item_requested", source: issueRef(5), requester: alice, title: "t", body: "b" });
    const local = (await f.cli(OWNER, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    const ghItem = (await f.store.getWorkItemBySource("github_issue", issueRef(5).id))!;
    expect(ghItem).toMatchObject({ blocked_reason: "spec_pending" });
    expect(await f.store.getWorkItem(local)).toMatchObject({ blocked_reason: "spec_pending" });

    f.gh.queue.push({ kind: "spec_approved", source: issueRef(5), comment_id: "900", approver: mallory, note: "" });
    expect((await f.cli(OUTSIDER, { action: "command", command: "approve", id: local, text: "" })).code).toBe(0);
    await f.step();

    const ghRefusal = f.gh.comments.find((c) => c.marker === "<!-- factory:refused:900 -->")!.body;
    const localRefusal = (await f.store.listItemMessages(local)).find((m) => m.marker.startsWith("<!-- factory:refused:"))!.body;
    expect(ghRefusal).toContain("needs write permission");
    expect(localRefusal).toBe(ghRefusal);
    expect(await f.store.getWorkItem(local)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });

  it("a CLI user whose local account is not linked is refused with the controller's not-linked reply", async () => {
    const f = await factory();
    const local = (await f.cli(OWNER, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await f.step();
    await f.cli(OWNER, { action: "command", command: "approve", id: local, text: "" });
    await f.step();
    const refusal = (await f.store.listItemMessages(local)).find((m) => m.marker.startsWith("<!-- factory:refused:"))!.body;
    expect(refusal).toContain("not linked to a factory user");
    expect(await f.store.getWorkItem(local)).toMatchObject({ stage: "READY", blocked_reason: "spec_pending" });
  });
});

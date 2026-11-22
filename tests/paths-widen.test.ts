// `/paths +<path>...` and `factory task paths` (design 05-interactive-sessions): the owner widens a RUNNING item's
// allowed paths in place, in one state change; the session finish's scope gate and the next implement attempt read the
// widened list from the store. Fakes only: sandbox, broker, runner, source and auth; the SQLite store and controller are real.

import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { COMMANDS, commandSpec, parseComment, withholdReplyLines } from "../src/core/commands.js";
import { commentEvent } from "../src/core/comment-event.js";
import { COMMAND_TABLE, chatCliArgv, parseChatCommand } from "../src/core/command-table.js";
import { type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import { Sessions } from "../src/core/session.js";
import type { UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { SourceEvent } from "../src/interfaces/source-adapter.js";
import { FakeAuth, FakeIssues, FakeSandbox, MemorySessionFiles } from "./helpers/fakes/runner.js";
import { FakeBroker } from "./helpers/fakes/broker.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { alice, cleanScanner, config, issueRef, mallory, silent } from "./helpers/fakes/config.js";
import { pipeline } from "./helpers/harness.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";

const paths = (it: WorkItem, n: string, note: string, requester = alice): SourceEvent =>
  ({ kind: "paths_requested", source: it.source, comment_id: n, requester, note });

/** A pipeline whose first item is RUNNING with its implement run queued (triage auto-approved), allowed `.github/workflows/`. */
async function implementing() {
  const f = await pipeline();
  const it0 = await f.submit();
  await f.w1.tick(); // triage
  await f.controller.tickRuns(); // spec auto-approved: implement queued
  expect(await f.item(it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none", allowed_paths: [".github/workflows/"] });
  const snapshot = async () => JSON.stringify([await f.item(it0), await f.store.listStateChanges(it0.id), await f.runs(it0)]);
  const send = async (e: SourceEvent) => {
    f.source.queue.push(e);
    await f.controller.tickIntake();
  };
  const refusal = (n: string) => f.source.comments.find((c) => c.marker === `<!-- factory:refused:${n} -->`)?.body;
  return { ...f, it0, snapshot, send, refusal };
}

describe("/paths on a running item", () => {
  it("adds each path not yet covered, in one paths_requested state change naming the owner, the added paths and the note", async () => {
    const f = await implementing();
    const before = (await f.store.listStateChanges(f.it0.id)).length;
    await f.send(paths(f.it0, "501", "+src/x.ts +tests/y.test.ts +.github/workflows/ci.yml +`./src/x.ts`\nthe test asserts the old text"));
    expect(await f.item(f.it0)).toMatchObject({ stage: "RUNNING", blocked_on: "none", allowed_paths: [".github/workflows/", "src/x.ts", "tests/y.test.ts"] });
    const added = (await f.store.listStateChanges(f.it0.id)).slice(before);
    expect(added.map((c) => c.reason)).toEqual(["paths_requested"]);
    expect(added[0]).toMatchObject({
      actor: { kind: "user", id: "github:1" },
      detail: { comment_id: "501", added_paths: JSON.stringify(["src/x.ts", "tests/y.test.ts"]), note: "the test asserts the old text" },
      changes: { allowed_paths: { from: [".github/workflows/"], to: [".github/workflows/", "src/x.ts", "tests/y.test.ts"] } },
    });
    // No run is queued or stopped: the implement run already queued takes the list when it starts.
    expect((await f.runs(f.it0)).map((r) => [r.kind, r.status])).toEqual([["triage", "succeeded"], ["implement", "queued"]]);
    expect(f.refusal("501")).toBeUndefined();
  });

  it("paths already covered add nothing: no state change, one reply saying they are already allowed", async () => {
    const f = await implementing();
    const before = await f.snapshot();
    await f.send(paths(f.it0, "502", "+.github/workflows/ci.yml"));
    expect(await f.snapshot()).toBe(before);
    expect(f.source.comments.find((c) => c.marker === "<!-- factory:already-allowed:502 -->")?.body).toContain("already allowed: .github/workflows/ci.yml");
  });

  it("a non-owner is refused with the owner commands' refusal shape, and nothing changes", async () => {
    const f = await implementing();
    const before = await f.snapshot();
    await f.send(paths(f.it0, "503", "+src/x.ts", mallory));
    expect(await f.snapshot()).toBe(before);
    expect(f.refusal("503")).toMatch(/^`\/paths` was not applied: /);
    // The same shape as another owner command refused for the same person.
    await f.send({ kind: "retry_requested", source: f.it0.source, comment_id: "504", requester: mallory });
    expect(f.refusal("503")!.replace("/paths", "/retry")).toBe(f.refusal("504"));
  });

  it("an item that is not RUNNING is refused with its phase, and nothing changes", async () => {
    const f = await pipeline({ config: { dials: { spec_gate_min_tier: 1, auto_merge_max_tier: 0 } } });
    const it0 = await f.submit();
    await f.step(); // triage: the spec waits for approval
    expect((await f.item(it0)).stage).toBe("READY");
    const before = JSON.stringify([await f.item(it0), await f.store.listStateChanges(it0.id)]);
    f.source.queue.push(paths(it0, "505", "+src/x.ts"));
    await f.controller.tickIntake();
    expect(JSON.stringify([await f.item(it0), await f.store.listStateChanges(it0.id)])).toBe(before);
    expect(f.source.comments.find((c) => c.marker === "<!-- factory:refused:505 -->")?.body)
      .toContain("the item is spec waiting for approval; `/paths` applies only while the item is being implemented");
  });

  it("refuses absolute, `..` and glob paths, more than 10 paths, no path and a word without `+`, by the +paths rules; nothing changes", async () => {
    const f = await implementing();
    const before = await f.snapshot();
    const eleven = Array.from({ length: 11 }, (_, i) => `+src/f${i}.ts`).join(" ");
    const bad: [string, RegExp][] = [
      ["+/etc/passwd", /is an absolute path/],
      ["+src/../secrets.ts", /is a path with `\.\.`/],
      ["+src/**/*.ts", /is a glob/],
      [eleven, /at most 10 paths per command, not 11/],
      ["", /needs at least one path/],
      ["+src/x.ts tests/y.test.ts", /each path after `\/paths` starts with `\+`/],
      // No form removes a path: a `-<path>` word is refused like any word without its `+`.
      ["-.github/workflows/", /each path after `\/paths` starts with `\+`/],
    ];
    for (const [i, [text, why]] of bad.entries()) {
      await f.send(paths(f.it0, `51${i}`, text));
      expect(f.refusal(`51${i}`), text).toMatch(why);
    }
    expect(await f.snapshot()).toBe(before);
  });

  it("the next worker implement attempt uses the widened list: a file under an added path passes its scope gate", async () => {
    const f = await implementing();
    f.sandbox.changedFiles = [".github/workflows/scope.yml", "tests/y.test.ts"];
    await f.send(paths(f.it0, "520", "+tests/y.test.ts"));
    await f.step();
    expect(await f.item(f.it0)).toMatchObject({ stage: "REVIEW", blocked_reason: "merge_pending" });
    expect((await f.runs(f.it0, "implement"))[0]!.outcome).toMatchObject({ status: "succeeded" });
  });
});

describe("/paths during an interactive session", () => {
  it("a session finish that touched an added path passes the scope gate; before the widening it is refused", async () => {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const sandbox = new FakeSandbox();
    sandbox.changedFiles = ["src/a/x.ts", "tests/y.test.ts"];
    const sessions = new Sessions({
      store, sandbox, broker: new FakeBroker(), scanner: cleanScanner, auth: new FakeAuth(), clock, config, log: silent, files: new MemorySessionFiles(),
      issues: new FakeIssues({}), toolEnv: {}, owner: "session:host:1",
    });
    const source = new FakeSource();
    const controller = new ControllerRole({ store, source, auth: new FakeAuth(), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false });
    const { item } = await store.createWorkItem({ ...issue(1), title: "Item 1" }, system);
    const r = await store.transition({ id: item.id, expected_version: 1, actor: system, reason: "seed", patch: { stage: "RUNNING", allowed_paths: ["src/a/"], tier: 2, done_criteria: ["x"] } });
    if (!r.ok) throw new Error(r.reason);
    expect((await sessions.start({ target: item.id, person: alice })).ok).toBe(true);
    const refused = await sessions.finish({});
    expect([refused.ok, refused.lines.join("\n")]).toEqual([false, expect.stringContaining("scope: files outside allowed_paths: tests/y.test.ts")]);

    source.queue.push(paths(r.item, "530", "+tests/y.test.ts\nthe session needs the test"));
    await controller.tickIntake();
    expect((await store.getWorkItem(item.id))!.allowed_paths).toEqual(["src/a/", "tests/y.test.ts"]);
    expect((await sessions.finish({})).ok).toBe(true);
    expect((await store.listStateChanges(item.id)).map((c) => c.reason)).toContain("paths_requested");
  });
});

describe("factory task paths", () => {
  const ME = "local:me@example.com" as UserId;
  const OTHER = "local:other@example.com" as UserId;

  async function local() {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner, repeated_failure_rule: false,
    });
    let n = 0;
    const deps = (user: UserId): LocalCliDeps => ({ answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "body", newId: () => `id${++n}` });
    const id = (await runLocalCli(deps(ME), { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId; // ME becomes the owner
    const cur = (await store.getWorkItem(id))!;
    const r = await store.transition({ id, expected_version: cur.version, actor: system, reason: "seed", patch: { stage: "RUNNING", blocked_on: "none", blocked_reason: null, allowed_paths: ["src/a/"], tier: 2 } });
    if (!r.ok) throw new Error(r.reason);
    const run = async (user: UserId, args: string[]) => {
      const a = parseLocalCliArgs("task", args);
      if ("error" in a) throw new Error(a.error);
      const out = await runLocalCli(deps(user), a);
      await controller.tickCommands();
      return out;
    };
    return { store, id, run };
  }

  it("parses to the stored `/paths` command, which the controller applies through the same handler as the chat command", async () => {
    const { store, id, run } = await local();
    expect(parseLocalCliArgs("task", ["paths", id, "+src/b.ts", "+tests/b.test.ts"])).toEqual({ action: "command", command: "paths", id, text: "+src/b.ts +tests/b.test.ts" });
    expect(parseLocalCliArgs("task", ["paths", id])).toMatchObject({ error: expect.stringContaining("task paths needs a work item ID and at least one +<path>") });
    const out = await run(ME, ["paths", id, "+src/b.ts", "+tests/b.test.ts"]);
    expect(out.lines[0]).toContain(`stored \`/paths\` for ${id} as ${ME}`);
    expect((await store.getWorkItem(id))!.allowed_paths).toEqual(["src/a/", "src/b.ts", "tests/b.test.ts"]);
    const change = (await store.listStateChanges(id)).find((c) => c.reason === "paths_requested");
    expect(change).toMatchObject({ actor: { kind: "user", id: ME }, detail: { added_paths: JSON.stringify(["src/b.ts", "tests/b.test.ts"]) } });
  });

  it("from anyone but the owner it is refused, and nothing changes", async () => {
    const { store, id, run } = await local();
    const before = JSON.stringify([await store.getWorkItem(id), await store.listStateChanges(id)]);
    await run(OTHER, ["paths", id, "+src/b.ts"]);
    expect(JSON.stringify([await store.getWorkItem(id), await store.listStateChanges(id)])).toBe(before);
  });
});

describe("the /paths forms", () => {
  it("the comment, chat and table forms map to one paths_requested event", () => {
    expect(parseComment("/paths +src/x.ts +tests/y.test.ts")).toEqual({ kind: "command", name: "paths", text: "+src/x.ts +tests/y.test.ts" });
    expect(commentEvent(issueRef(1), "1", alice, "/paths +src/x.ts\nwhy")).toEqual({ kind: "paths_requested", source: issueRef(1), comment_id: "1", requester: alice, note: "+src/x.ts\nwhy" });
    const chat = parseChatCommand("/paths +src/x.ts +tests/y.test.ts");
    expect(chat).toMatchObject({ kind: "command", entry: { name: "task paths", who: "approve_spec", item: true } });
    if (chat?.kind !== "command") throw new Error("paths");
    const { word, args } = chatCliArgv(chat, "wi_1");
    expect(parseLocalCliArgs(word, args)).toEqual({ action: "command", command: "paths", id: "wi_1", text: "+src/x.ts +tests/y.test.ts" });
    expect(commandSpec("paths")).toMatchObject({ usage: "/paths +<path>...", changes_state: true });
  });

  it("removing a path is not supported: no command or CLI form removes an allowed path", () => {
    const removes = (s: string) => /\bremov\w* (an? )?(allowed )?path/i.test(s) && !/never removes|which never removes/i.test(s);
    expect(COMMANDS.filter((c) => removes(c.description)).map((c) => c.name)).toEqual([]);
    expect(COMMAND_TABLE.filter((c) => removes(c.does)).map((c) => c.name)).toEqual([]);
  });

  it("an agent's own `/paths +` line is withheld, as its `/retry +` lines are", () => {
    expect(withholdReplyLines("done\n/paths +src/x.ts")).toBe("done");
  });
});

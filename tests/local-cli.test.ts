import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliUserConfig } from "../src/core/config.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import {
  CLI_TOP_WORDS, type CliAction, type CliIdentity, type LocalCliDeps, cliCommandListMarkdown, cliIdentity, parseLocalCliArgs,
  runLocalCli,
} from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { COMMAND_TABLE, SENTENCE_FORM, cliUsageOf } from "../src/core/command-table.js";
import { helpReply, itemCommandState, refusalText, specNotWaiting } from "../src/core/commands.js";
import { VERDICT_USAGE } from "../src/core/verdict.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { FakeSource, cleanScanner, config, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// The writer side of local intake (issue #200): CLI commands that create local items, append item commands to
// the command log, and print a task's state and messages. No GitHub call: the deps hold no GitHub client.

const USER = "github:12345" as UserId;

async function setup(user: UserId = USER, from: CliIdentity["from"] = "cli_user") {
  const { store } = await newStore();
  const reads: string[] = [];
  let n = 0;
  const d: LocalCliDeps = {
    store, identity: { user, from }, project: async () => PROJECT_KEY, read: async (p) => (reads.push(p), "the body\n"), newId: () => `id${++n}`,
  };
  const run = (a: CliAction) => runLocalCli(d, a);
  /** The same store, another person's terminal. */
  const as = (other: string) => (a: CliAction) => runLocalCli({ ...d, identity: { user: other as UserId, from: "git user.email" } }, a);
  return { store, d, run, reads, as };
}

/** Puts `id` at `patch` (the spec gate unless given), as the controller would have. */
async function at(store: FactoryStore, id: WorkItemId, patch: Parameters<FactoryStore["transition"]>[0]["patch"] = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" }) {
  const it = (await store.getWorkItem(id))!;
  const r = await store.transition({ id, expected_version: it.version, actor: system, reason: "test_setup", patch });
  if (!r.ok) throw new Error("setup");
}

/** Every row a CLI command could touch. */
async function snapshot(store: FactoryStore) {
  const items = await store.listWorkItems(100);
  const runs = await Promise.all(items.map((i) => store.listRuns(i.id)));
  const changes = await Promise.all(items.map((i) => store.listStateChanges(i.id)));
  return { items, runs, changes, commands: await store.listCliCommandsAfter(0, 1000) };
}

describe("parseLocalCliArgs", () => {
  it("parses each command", () => {
    expect(parseLocalCliArgs("task", ["create", "--title", "T", "--body-file", "b.md"])).toEqual({ action: "create", title: "T", bodyFile: "b.md" });
    expect(parseLocalCliArgs("task", ["create", "--body-file", "b.md", "--title", "T"])).toEqual({ action: "create", title: "T", bodyFile: "b.md" });
    expect(parseLocalCliArgs("task", ["list"])).toEqual({ action: "list" });
    expect(parseLocalCliArgs("task", ["show", "wi_1"])).toEqual({ action: "show", id: "wi_1" });
    expect(parseLocalCliArgs("approve", ["wi_1"])).toEqual({ action: "command", command: "approve", id: "wi_1", text: "" });
    expect(parseLocalCliArgs("revise", ["wi_1", "more", "tests"])).toEqual({ action: "command", command: "revise", id: "wi_1", text: "more tests" });
    expect(parseLocalCliArgs("reject", ["wi_1", "no"])).toMatchObject({ command: "reject", text: "no" });
    expect(parseLocalCliArgs("retry", ["wi_1"])).toMatchObject({ command: "retry", text: "" });
    expect(parseLocalCliArgs("resolve", ["wi_1"])).toEqual({ action: "command", command: "resolve", id: "wi_1", text: "" });
    expect(parseLocalCliArgs("resolve", ["wi_1", "keep", "main's", "gate"])).toEqual({ action: "command", command: "resolve", id: "wi_1", text: "keep main's gate" });
    expect(parseLocalCliArgs("verdict", ["wi_1", "changes", "major", "rename", "it"])).toEqual({ action: "command", command: "verdict", id: "wi_1", text: "changes major rename it" });
    expect(parseLocalCliArgs("verdict", ["wi_1", "accept"])).toEqual({ action: "command", command: "verdict", id: "wi_1", text: "accept" });
    expect(parseLocalCliArgs("help", [])).toEqual({ action: "help", id: null });
    expect(parseLocalCliArgs("help", ["wi_1"])).toEqual({ action: "help", id: "wi_1" });
    expect(parseLocalCliArgs("help", ["wi_1", "wi_2"])).toMatchObject({ error: expect.stringContaining("usage:") });
  });

  it("anything incomplete or unknown is an error with the usage", () => {
    for (const [w, a] of [
      ["task", []], ["task", ["create", "--title", "T"]], ["task", ["create", "--body-file", "b"]], ["task", ["create", "--title"]],
      ["task", ["create", "--title", "T", "--body-file", "b", "--label", "x"]], ["task", ["show"]], ["task", ["list", "x"]],
      ["task", ["frob"]], ["approve", []], ["retry", []], ["resolve", []], ["verdict", []], ["users", ["list"]],
    ] as [string, string[]][]) {
      const r = parseLocalCliArgs(w, a);
      expect({ w, a, r }).toMatchObject({ r: { error: expect.stringContaining("usage:") } });
    }
  });

  it("a malformed verdict (unknown verdict, unknown severity, missing reason) is an error with the `/verdict` usage line", () => {
    for (const text of [[], ["lgtm"], ["changes", "huge", "rename", "it"], ["changes", "minor"], ["reject", "major"]]) {
      const r = parseLocalCliArgs("verdict", ["wi_1", ...text]);
      expect({ text, r }).toMatchObject({ r: { error: expect.stringContaining(VERDICT_USAGE) } });
    }
  });

  it("the top-level words are the first word of every task and item command in the command table, `confirm` among them", () => {
    // The settings handler takes its own words; the sentence form takes any word no handler claims (src/main.ts).
    const local = COMMAND_TABLE.filter((c) => c.group !== "settings" && c.group !== "sentence");
    expect([...new Set(local.map((c) => c.name.split(" ")[0]))]).toEqual([...CLI_TOP_WORDS]);
    expect(CLI_TOP_WORDS).toContain("confirm");
    expect(CLI_TOP_WORDS).not.toContain(SENTENCE_FORM);
  });
});

describe("task create", () => {
  it("creates one local work item with its triage run queued and prints its ID", async () => {
    const { store, run, reads } = await setup();
    const r = await run({ action: "create", title: "Add a gate", bodyFile: "body.md" });
    expect(r.code).toBe(0);
    expect(r.lines).toHaveLength(1);
    const item = (await store.getWorkItem(r.lines[0] as WorkItemId))!;
    expect(item).toMatchObject({
      title: "Add a gate", requester_id: USER, project: PROJECT_KEY, problem: "Add a gate\n\nthe body", stage: "NEW",
      source: { type: "local", id: "local-id1", link: "local:local-id1" },
    });
    expect(reads).toEqual(["body.md"]);
    expect((await store.listRuns(item.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "queued"]]);
    expect((await store.listStateChanges(item.id))[0]).toMatchObject({ reason: "intake", actor: { kind: "user", id: USER } });
  });

  it("with no stored project it fails and creates nothing", async () => {
    const { store, d } = await setup();
    const r = await runLocalCli({ ...d, project: async () => null }, { action: "create", title: "t", bodyFile: "b" });
    expect(r.code).toBe(1);
    expect(await store.listWorkItems(10)).toEqual([]);
  });
});

describe("task list and task show", () => {
  it("list prints each local item's ID, title, stage and blocked reason; GitHub items are left out", async () => {
    const { store, run } = await setup();
    await store.createWorkItem(issue(9), system);
    const id = (await run({ action: "create", title: "Local one", bodyFile: "b" })).lines[0]!;
    const r = await run({ action: "list" });
    expect(r).toEqual({ code: 0, lines: [`${id}\tLocal one\tNEW\t-`] });
  });

  it("show prints the item's state, spec, runs and stored messages", async () => {
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "Local one", bodyFile: "b" })).lines[0] as WorkItemId;
    await store.recordItemMessage({ work_item_id: id, marker: "m1", body: "the spec comment\nline two" });
    const r = await run({ action: "show", id });
    expect(r.code).toBe(0);
    const text = r.lines.join("\n");
    for (const s of ["State", "stage: NEW", "blocked_reason: -", "Spec", "problem: Local one", "Runs", "triage  queued", "Messages", "the spec comment", "line two"]) {
      expect(text).toContain(s);
    }
    expect(r.lines.indexOf("State")).toBeLessThan(r.lines.indexOf("Spec"));
    expect(r.lines.indexOf("Spec")).toBeLessThan(r.lines.indexOf("Runs"));
    expect(r.lines.indexOf("Runs")).toBeLessThan(r.lines.indexOf("Messages"));
  });

  it("show lists a task's sub-tasks in phase order with ID, title, stage and blocked reason, or (none)", async () => {
    const { store, run } = await setup();
    const parent = (await run({ action: "create", title: "Parent", bodyFile: "b" })).lines[0] as WorkItemId;
    const sub = (n: number) => ({ type: "local" as const, id: `p-phase-${n}`, link: `local:p-phase-${n}` });
    const none = await run({ action: "show", id: parent });
    expect(none.lines[none.lines.indexOf("Sub-tasks") + 1]).toBe("  (none)");
    // Filed out of order: the list follows the phase number.
    const two = (await store.createWorkItem(
      { ...issue(2), source: sub(2), title: "Phase 2/2: B", parent: { id: parent, phase: 2 }, hold: { blocked_on: "upstream", blocked_reason: "phase_hold" } },
      system,
    )).item;
    const one = (await store.createWorkItem({ ...issue(1), source: sub(1), title: "Phase 1/2: A", parent: { id: parent, phase: 1 } }, system)).item;
    const r = await run({ action: "show", id: parent });
    const at = r.lines.indexOf("Sub-tasks");
    expect(at).toBeGreaterThan(r.lines.indexOf("Spec"));
    expect(at).toBeLessThan(r.lines.indexOf("Runs"));
    expect(r.lines.slice(at + 1, at + 3)).toEqual([
      `  1. ${one.id}\tPhase 1/2: A\tNEW\t-`,
      `  2. ${two.id}\tPhase 2/2: B\tNEW\tphase_hold`,
    ]);
  });

  it("show for a missing item fails", async () => {
    const { run } = await setup();
    expect((await run({ action: "show", id: "wi_missing" as WorkItemId })).code).toBe(1);
  });
});

describe("approve, retry, revise, reject, resolve", () => {
  it("each stores one command in the command log and changes no item state", async () => {
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await at(store, id);
    const before = await snapshot(store);
    for (const command of ["approve", "retry", "revise", "reject", "resolve"] as const) {
      const r = await run({ action: "command", command, id, text: command === "retry" ? "" : `${command} text` });
      expect(r.code).toBe(0);
    }
    const after = await snapshot(store);
    expect({ ...after, commands: [] }).toEqual({ ...before, commands: [] });
    const added = after.commands.slice(before.commands.length);
    expect(added.map((c) => ({ actor: c.actor, command: c.command, args: c.args }))).toEqual([
      { actor: USER, command: "approve", args: { item: id, text: "approve text" } },
      { actor: USER, command: "retry", args: { item: id } },
      { actor: USER, command: "revise", args: { item: id, text: "revise text" } },
      { actor: USER, command: "reject", args: { item: id, text: "reject text" } },
      { actor: USER, command: "resolve", args: { item: id, text: "resolve text" } },
    ]);
    expect(new Set(added.map((c) => c.key)).size).toBe(added.length);
  });

  it("a missing item stores nothing", async () => {
    const { store, run } = await setup();
    expect((await run({ action: "command", command: "approve", id: "wi_missing" as WorkItemId, text: "" })).code).toBe(1);
    expect(await store.listCliCommandsAfter(0, 100)).toEqual([]);
  });

  it("a GitHub item's command is stored like a local one's, marked to be mirrored on its issue; a local one's is not", async () => {
    const { store, run } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    await at(store, gh.id);
    const r = await run({ action: "command", command: "approve", id: gh.id, text: "ship it" });
    expect(r).toEqual({ code: 0, lines: [expect.stringContaining(`stored \`/approve\` for ${gh.id} as ${USER}`)] });
    expect(await store.listCliCommandsAfter(0, 100)).toEqual([
      expect.objectContaining({ actor: USER, command: "approve", args: { item: gh.id, text: "ship it" }, mirror: true }),
    ]);
    expect((await store.listUnmirroredCliCommands(100)).map((c) => c.args.item)).toEqual([gh.id]);
  });
});

describe("verdict on an item of a sync source (issue #523)", () => {
  it("stores one verdict and posts no mirror comment", async () => {
    const ME = "local:me@example.com" as UserId;
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const github = new FakeSource();
    const local = new OwnerAuth(store);
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store), github], auth: local, clock, config, log: silent, scanner: cleanScanner,
      repeated_failure_rule: false,
    });
    const gh = (await store.createWorkItem(issue(3), system)).item;
    await at(store, gh.id, { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" });
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "v1" };
    expect((await runLocalCli(d, { action: "command", command: "verdict", id: gh.id, text: "accept none fine" })).code).toBe(0);
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([expect.objectContaining({ command: "verdict", args: { item: gh.id, text: "accept none fine" } })]);
    expect(await store.listUnmirroredCliCommands(10)).toEqual([]);
    await controller.tickCommands();
    expect((await store.listVerdicts(gh.id)).map((v) => [v.verdict, v.severity, v.reason, v.target])).toEqual([["accept", "none", "fine", "issue"]]);
    expect(github.comments).toEqual([]);
  });
});

describe("approve's own check (issue #528)", () => {
  it("where approve does not apply, it is refused with the controller's text before any write: no row, no owner", async () => {
    const { store, run } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    const done = (await store.createWorkItem(issue(4), system)).item;
    await at(store, done.id, { stage: "CLOSED", close_reason: "completed" });
    const before = await snapshot(store);
    expect(await run({ action: "command", command: "approve", id: gh.id, text: "ship it" })).toEqual({
      code: 1, lines: [refusalText("/approve", specNotWaiting("triaging"))],
    });
    expect(await run({ action: "command", command: "approve", id: done.id, text: "" })).toEqual({ code: 1, lines: ["`/approve` was not applied: the work item is closed."] });
    expect(await snapshot(store)).toEqual(before);
    expect(await store.getOwner()).toBeNull();
  });

  it("an implement run held by coordination cost is still approved: the hold is in no field, so the controller decides", async () => {
    const { store, run } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    await at(store, gh.id, { stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    expect((await run({ action: "command", command: "approve", id: gh.id, text: "" })).code).toBe(0);
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.command)).toEqual(["approve"]);
  });

  it("the other item commands are stored in any state; the controller answers them", async () => {
    const { store, run } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    expect((await run({ action: "command", command: "reject", id: gh.id, text: "no" })).code).toBe(0);
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => c.command)).toEqual(["reject"]);
  });
});

describe("factory help", () => {
  it("prints the /help reply: every command with no item, the ones that apply now marked with one", async () => {
    const { store, run } = await setup();
    expect(await run({ action: "help", id: null })).toEqual({ code: 0, lines: helpReply(null).split("\n") });
    const gh = (await store.createWorkItem(issue(3), system)).item;
    await at(store, gh.id);
    const it = (await store.getWorkItem(gh.id))!;
    const r = await run({ action: "help", id: gh.id });
    expect(r).toEqual({ code: 0, lines: helpReply(itemCommandState(it, [])).split("\n") });
    expect(r.lines.join("\n")).toContain("`/approve [notes]` **(now)**");
    expect((await run({ action: "help", id: "wi_missing" as WorkItemId })).code).toBe(1);
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });
});

describe("a local resolve command at the controller", () => {
  const ME = "local:me@example.com" as UserId;

  /** A local item filed from the CLI by ME (the local owner), set to `blocked_reason` on PR 42 after review. */
  async function local(blocked_reason: string) {
    const clock = new FakeClock();
    const { store } = await newStore(clock);
    const controller = new ControllerRole({
      store, sources: [new LocalSource(store)], auth: new OwnerAuth(store), clock, config, log: silent, scanner: cleanScanner,
      repeated_failure_rule: false,
    });
    let n = 0;
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "b", newId: () => `id${++n}` };
    const id = (await runLocalCli(d, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    const it = (await store.getWorkItem(id))!;
    const r = await store.transition({
      id, expected_version: it.version, actor: system, reason: "test_setup",
      patch: { stage: "REVIEW", blocked_on: "human", blocked_reason, change_ref: "42" },
    });
    if (!r.ok) throw new Error("setup");
    const resolve = async (text: string) => {
      expect((await runLocalCli(d, { action: "command", command: "resolve", id, text })).code).toBe(0);
      await controller.tickIntake();
    };
    const resolveRuns = async () => (await store.listRuns(id)).filter((x) => x.kind === "resolve");
    return { store, id, resolve, resolveRuns, tickAgain: () => controller.tickIntake() };
  }

  it("on merge_conflict_pending: one resolve run with the notes, the item RUNNING; another tick adds none", async () => {
    const f = await local("merge_conflict_pending");
    await f.resolve("keep main's gate");
    expect((await f.resolveRuns()).map((r) => [r.status, r.input])).toEqual([["queued", { notes: "keep main's gate" }]]);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "RUNNING", blocked_on: "none", blocked_reason: null });
    const accepted = (await f.store.listStateChanges(f.id)).find((c) => c.reason === "resolve_requested")!;
    expect(accepted.actor).toEqual({ kind: "user", id: ME });
    await f.tickAgain();
    expect(await f.resolveRuns()).toHaveLength(1);
  });

  it("in any other state: refused, the reply names the state, and nothing is enqueued", async () => {
    const f = await local("merge_pending");
    const before = await f.store.getWorkItem(f.id);
    await f.resolve("");
    expect(await f.resolveRuns()).toEqual([]);
    expect(await f.store.getWorkItem(f.id)).toEqual(before);
    const refusals = (await f.store.listItemMessages(f.id)).filter((m) => m.marker.startsWith("<!-- factory:refused:"));
    expect(refusals.map((m) => m.body)).toEqual([expect.stringContaining("`/resolve` was not applied")]);
    expect(refusals[0]!.body).toContain("waiting for a human merge");
  });
});

describe("the CLI identity", () => {
  it("is cli_user when set, else local:<git user.email>, else local:<OS user>, else local:anonymous", () => {
    expect(cliIdentity(USER, { gitEmail: "a@b.c", osUser: "kim" })).toEqual({ user: USER, from: "cli_user" });
    expect(cliIdentity(null, { gitEmail: " A@B.c\n", osUser: "kim" })).toEqual({ user: "local:a@b.c", from: "git user.email" });
    expect(cliIdentity(null, { gitEmail: null, osUser: "kim" })).toEqual({ user: "local:kim", from: "OS user" });
    expect(cliIdentity(null, { gitEmail: "", osUser: "two words" })).toEqual({ user: "local:anonymous", from: "anonymous" });
    expect(cliIdentity(null, { gitEmail: null, osUser: null })).toEqual({ user: "local:anonymous", from: "anonymous" });
  });

  it("cli_user is optional: absent is null, a factory user ID is kept, anything else throws", () => {
    expect(cliUserConfig({})).toBeNull();
    expect(cliUserConfig({ cli_user: "github:12345" })).toBe("github:12345");
    expect(() => cliUserConfig({ cli_user: "alice" })).toThrow("cli_user must be a factory user ID");
    expect(() => cliUserConfig({ cli_user: 5 })).toThrow("cli_user");
  });
});

describe("the owner", () => {
  it("the first identity to write becomes the owner; a second one does not", async () => {
    const { store, run, as } = await setup("local:me@example.com" as UserId);
    expect(await store.getOwner()).toBeNull();
    expect((await run({ action: "list" })).code).toBe(0);
    expect(await store.getOwner()).toBeNull();
    await run({ action: "create", title: "t", bodyFile: "b" });
    await as("local:dev@example.com")({ action: "create", title: "t", bodyFile: "b" });
    expect(await store.getOwner()).toBe("local:me@example.com");
  });

  it("anonymous may create, list and show but never becomes the owner", async () => {
    const { store, run } = await setup("local:anonymous" as UserId, "anonymous");
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    expect((await store.getWorkItem(id))!.requester_id).toBe("local:anonymous");
    expect((await run({ action: "show", id })).code).toBe(0);
    expect(await store.getOwner()).toBeNull();
  });

  it("`factory users` is gone: `users list` (and every users verb) is an unknown command", () => {
    for (const args of [["list"], ["add", "local:a@b.c", "--role", "approver"], ["remove", "local:a@b.c"]]) {
      expect(parseLocalCliArgs("users", args)).toEqual({ error: expect.stringContaining('unknown command "users"') });
    }
    expect(CLI_TOP_WORDS).not.toContain("users");
    expect(COMMAND_TABLE.filter((c) => c.name.startsWith("users"))).toEqual([]);
  });
});

describe("SET_UP.md", () => {
  it("lists every CLI command, exactly as the command table has them", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(cliCommandListMarkdown());
    const listed = setup.split("\n").filter((l) => l.startsWith("- `factory ")).map((l) => /^- `factory ([^`]+)`/.exec(l)![1]);
    expect(listed).toEqual(COMMAND_TABLE.map(cliUsageOf));
  });
});

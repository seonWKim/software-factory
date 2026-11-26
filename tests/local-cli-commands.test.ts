import { describe, expect, it } from "vitest";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { CLI_NAME_ENV, type LocalCliDeps, cliName, parseLocalCliArgs, parseSentence, runLocalCli, runSentence } from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import { SENTENCE_FORM } from "../src/core/command-table.js";
import { helpReply, itemCommandState, refusalText, specNotWaiting } from "../src/core/commands.js";
import { OwnerAuth } from "../src/core/authorize.js";
import { coordinatorLimitQuestion } from "../src/core/alarms.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { FakeSource } from "./helpers/fakes/source.js";
import { cleanScanner, config, silent } from "./helpers/fakes/config.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";
import { classifierAnswer } from "./helpers/classifier.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../src/interfaces/llm-provider.js";
import { USER, answers, at, setup, snapshot } from "./helpers/local-cli.js";

describe("hold", () => {
  it("parses `hold <id> <wi_ or tk_ id>` and stores `/hold` for the controller; a missing or bad ID is refused", async () => {
    expect(parseLocalCliArgs("hold", ["wi_a", "wi_b"])).toEqual({ action: "command", command: "hold", id: "wi_a", text: "wi_b" });
    for (const args of [["wi_a"], ["wi_a", "soon"], ["wi_a", "wi_b", "wi_c"]]) expect(parseLocalCliArgs("hold", args), args.join(" ")).toHaveProperty("error");
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "First", bodyFile: "a.md" })).lines[0] as WorkItemId;
    const r = await run({ action: "command", command: "hold", id, text: "wi_other" });
    expect(r.code).toBe(0);
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => [c.command, c.args])).toEqual([["hold", { item: id, text: "wi_other" }]]);
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

describe("the command name in hints", () => {
  it("cliName: the wrapper's FACTORY_CLI_NAME when it is one word, else factory", () => {
    expect(CLI_NAME_ENV).toBe("FACTORY_CLI_NAME");
    expect(cliName({ FACTORY_CLI_NAME: "gb" })).toBe("gb");
    expect(cliName({ FACTORY_CLI_NAME: " gb " })).toBe("gb");
    expect(cliName({})).toBe("factory");
    expect(cliName({ FACTORY_CLI_NAME: "" })).toBe("factory");
    expect(cliName({ FACTORY_CLI_NAME: "two words" })).toBe("factory");
  });

  it("with the name gb, every stored command's hint starts with gb; merge is stored as `gb merge`", async () => {
    const { store, d } = await setup();
    const gb = { ...d, cli: "gb" };
    const id = (await runLocalCli(gb, { action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await at(store, id);
    for (const command of ["approve", "revise", "reject", "retry", "resolve"] as const) {
      const r = await runLocalCli(gb, { action: "command", command, id, text: "" });
      expect(r.lines).toEqual([expect.stringContaining(`stored \`/${command}\` for ${id}`)]);
      expect(r.lines[0]).toMatch(new RegExp(`see \`gb task show ${id}\`$`));
    }
    const merge = await runLocalCli(gb, { action: "command", command: "merge", id, text: "" });
    expect(merge.lines.join("\n")).toContain("`gb merge`");
    expect(merge.lines.join("\n")).not.toContain("factory merge");
  });

  it("with no name, the hints say factory as before (chat callers pass none)", async () => {
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    await at(store, id);
    const r = await run({ action: "command", command: "approve", id, text: "" });
    expect(r.lines[0]).toMatch(new RegExp(`see \`factory task show ${id}\`$`));
    expect((await run({ action: "command", command: "merge", id, text: "" })).lines.join("\n")).toContain("`factory merge`");
  });

  it("the sentence form's hints use the name: the proposal's confirm line, the confirm reply, the work-request line", async () => {
    const { store, d } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    await at(store, gh.id);
    /** Answers the classifier with `command` and the interpreter with `answer`. */
    const llm = (answer: Record<string, unknown>): LLMProvider => ({
      async complete(req: LLMRequest): Promise<LLMResponse> {
        return classifierAnswer(req) ?? { text: JSON.stringify(answer), parsed: answer, stop_reason: "end", usage: { input_tokens: 1, output_tokens: 1, cost_usd: null } };
      },
    });
    const approve = llm({ kind: "commands", entries: [{ item: gh.id, command: "approve", args: "" }] });
    const sd = { store, scanner: cleanScanner, identity: d.identity, refusal: async () => null, newId: () => "ab12", cli: "gb" };
    const proposed = await runSentence({ ...sd, llm: approve }, "approve that one");
    expect(proposed.lines[0]).toContain("run `gb confirm prop_ab12`");
    const confirmed = await runLocalCli({ ...d, cli: "gb" }, { action: "confirm", proposal: "prop_ab12" });
    expect(confirmed.lines[0]).toMatch(/^stored `gb confirm prop_ab12`/);
    const request = await runSentence({ ...sd, llm: llm({ kind: "request", entries: [], text: "I can make this a task: a dark mode." }) }, "add a dark mode please");
    expect(request.lines).toEqual([expect.stringContaining("`gb task create --title <t> --body-file <f>`")]);
    const { cli: _, ...plain } = sd;
    expect((await runSentence({ ...plain, newId: () => "cd34", llm: approve }, "approve that one")).lines[0]).toContain("run `factory confirm prop_cd34`");
  });

  it("the sentence form's usage error uses the name too", () => {
    expect(parseSentence(["x"], "gb")).toEqual({ error: expect.stringContaining(`two words: gb ${SENTENCE_FORM}`) });
    expect(parseSentence(["x"])).toEqual({ error: expect.stringContaining(`two words: factory ${SENTENCE_FORM}`) });
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
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => "v1", answers };
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
    const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "b", newId: () => `id${++n}`, answers };
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

describe("a bare approve <usd> or reject answers the coordinator limit question (design 06-spend)", () => {
  const raise = (store: Awaited<ReturnType<typeof setup>>["store"]) =>
    coordinatorLimitQuestion({ store, scanner: cleanScanner, log: silent }, { day: "2026-01-01", limit_usd: 5, spent_usd: 6, unknown: 0 });

  it("parses `approve 10` as the common approve with a value; any other word stays the item command", () => {
    expect(parseLocalCliArgs("approve", ["10"])).toEqual({ action: "settle", command: "approve", value: "10" });
    expect(parseLocalCliArgs("approve", ["$12.50"])).toEqual({ action: "settle", command: "approve", value: "$12.50" });
    expect(parseLocalCliArgs("approve", ["wi_a"])).not.toMatchObject({ action: "settle" });
  });

  it("approve 10 sets spend.coordinator_daily_usd and answers the question; reject sets nothing", async () => {
    const { store, run } = await setup();
    await raise(store);
    expect(await run({ action: "settle", command: "approve", value: "10" })).toMatchObject({ code: 0, lines: [expect.stringContaining("spend.coordinator_daily_usd is now $10.00")] });
    expect((await store.listSettingOverrides()).find((o) => o.key === "spend.coordinator_daily_usd")).toMatchObject({ value: "10", set_by: USER });
    expect((await store.listAlerts({ limit: 10 })).find((a) => a.pattern === "coordinator_limit")!.dismissed_at).toBeDefined();

    const other = await setup();
    await raise(other.store);
    expect(await other.run({ action: "settle", command: "reject" })).toMatchObject({ code: 0, lines: [expect.stringContaining("stay stopped until the UTC day ends")] });
    expect((await other.store.listSettingOverrides()).find((o) => o.key === "spend.coordinator_daily_usd")).toBeUndefined();
  });

  it("a bare approve with no amount is refused while the question is open, and another person cannot answer", async () => {
    const { store, run, as } = await setup();
    await raise(store);
    expect(await run({ action: "settle", command: "approve" })).toMatchObject({ code: 1, lines: [expect.stringContaining("positive dollar amount")] });
    await run({ action: "create", title: "claims the owner", bodyFile: "b" });
    expect((await as("local:someone-else")({ action: "settle", command: "approve", value: "10" })).code).toBe(1);
    expect((await store.listSettingOverrides()).find((o) => o.key === "spend.coordinator_daily_usd")).toBeUndefined();
  });
});

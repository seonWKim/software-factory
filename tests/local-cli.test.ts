import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CREATE_NEXT_STEP, type CliAction, cliCommandListMarkdown, CLI_TOP_WORDS, parseLocalCliArgs, resolveItem, runLocalCli, shortItemId,
} from "../src/core/local-cli.js";
import { parseLocalCliArgs as parseArgs } from "../src/core/local-cli-parse.js";
import type { WorkItemId } from "../src/core/types.js";
import { COMMAND_TABLE, SENTENCE_FORM, cliUsageOf } from "../src/core/command-table.js";
import { VERDICT_USAGE } from "../src/core/verdict.js";
import { PROJECT_KEY, issue, system, w1 } from "./helpers/store.js";
import { USER, at, setup, snapshot } from "./helpers/local-cli.js";

// The writer side of local intake (issue #200): CLI commands that create local items, append item commands to
// the command log, and print a task's state and messages. No GitHub call: the deps hold no GitHub client.
// Item commands are in local-cli-commands.test.ts, decision answers in local-cli-decisions.test.ts, identity in local-cli-identity.test.ts.

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
      ["task", ["frob"]], ["revise", []], ["retry", []], ["resolve", []], ["verdict", []], ["users", ["list"]],
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
    // The settings handler takes its own words, and so does the queue's (src/cli/handlers/run-next).
    const local = COMMAND_TABLE.filter((c) => c.group !== "settings" && c.group !== "sentence" && c.group !== "queue");
    expect([...new Set(local.map((c) => c.name.split(" ")[0]))]).toEqual([...CLI_TOP_WORDS]);
    expect(CLI_TOP_WORDS).toContain("confirm");
    expect(CLI_TOP_WORDS).not.toContain(SENTENCE_FORM);
  });
});

describe("a bare approve or reject: the newest held skill version (design 07-self-improvement)", () => {
  const held = async (store: Awaited<ReturnType<typeof setup>>["store"], ref_id: string, hash: string) => {
    const v = (await store.recordSkillVersion({ ref_id, folder_hash: hash, text: hash, source: "claude" }))!;
    await store.db.run("UPDATE controller_skill_version_gates SET state = 'held' WHERE ref_id = ? AND version = ?", [ref_id, v.version]);
    return v.version;
  };

  it("parses as a settle; with a work item ID it is the item command as before", () => {
    expect(parseLocalCliArgs("approve", [])).toEqual({ action: "settle", command: "approve" });
    expect(parseLocalCliArgs("reject", [])).toEqual({ action: "settle", command: "reject" });
    expect(parseLocalCliArgs("approve", ["wi_1"])).toEqual({ action: "command", command: "approve", id: "wi_1", text: "" });
  });

  it("with no held version it fails with the parser's refusal and usage, word for word, and writes nothing", async () => {
    const { store, run } = await setup();
    const before = await snapshot(store);
    for (const command of ["approve", "reject"] as const) {
      const parsed = parseArgs(command, []);
      expect(await run({ action: "settle", command })).toEqual({ code: 1, lines: ("error" in parsed ? parsed.error : "").split("\n") });
    }
    expect(await snapshot(store)).toEqual(before);
    expect(await store.getOwner()).toBeNull();
  });

  it("approve passes the newest held version, so it is current; a second bare approve settles the next held one", async () => {
    const { store, run } = await setup();
    await held(store, "sr_a", "a1");
    await held(store, "sr_a", "a2");
    const r = await run({ action: "settle", command: "approve" });
    expect(r).toMatchObject({ code: 0, lines: [expect.stringContaining("version 2 of skill sr_a")] });
    expect(await store.getSkillVersionGate("sr_a", 2)).toMatchObject({ state: "passed", detail: expect.objectContaining({ settled_by: USER }) });
    expect(await store.getSkillVersionGate("sr_a", 1)).toMatchObject({ state: "held" });
    expect((await store.currentSkillVersion("sr_a"))?.version).toBe(2);
    expect(await store.getOwner()).toBe(USER);
    await run({ action: "settle", command: "approve" });
    expect(await store.getSkillVersionGate("sr_a", 1)).toMatchObject({ state: "passed" });
  });

  it("reject rejects the newest held version: the version current before it stays current", async () => {
    const { store, run } = await setup();
    await store.recordSkillVersion({ ref_id: "sr_b", folder_hash: "b1", text: "b1", source: "claude" });
    await store.db.run("UPDATE controller_skill_version_gates SET state = 'passed' WHERE ref_id = 'sr_b' AND version = 1");
    await held(store, "sr_b", "b2");
    expect(await run({ action: "settle", command: "reject" })).toMatchObject({ code: 0, lines: [expect.stringContaining("version 2 of skill sr_b")] });
    expect(await store.getSkillVersionGate("sr_b", 2)).toMatchObject({ state: "rejected" });
    expect((await store.currentSkillVersion("sr_b"))?.version).toBe(1);
  });
});

describe("task create", () => {
  it("creates one local work item with its triage run queued and prints its ID, its link and the next step", async () => {
    const { store, d, reads } = await setup();
    const r = await runLocalCli({ ...d, ui: {} }, { action: "create", title: "Add a gate", bodyFile: "body.md" });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([r.lines[0], shortItemId(r.lines[0]!), `http://127.0.0.1:4310/app/items/${r.lines[0]}`, "triage queued; you'll be asked to approve the spec"]);
    expect(r.lines[1]).toBe(r.lines[0]!.slice(3, 11));
    const item = (await store.getWorkItem(r.lines[0] as WorkItemId))!;
    expect(item).toMatchObject({
      title: "Add a gate", requester_id: USER, project: PROJECT_KEY, problem: "Add a gate\n\nthe body", stage: "NEW",
      source: { type: "local", id: "local-id1", link: "local:local-id1" },
    });
    expect(reads).toEqual(["body.md"]);
    expect((await store.listRuns(item.id)).map((x) => [x.kind, x.status])).toEqual([["triage", "queued"]]);
    expect((await store.listStateChanges(item.id))[0]).toMatchObject({ reason: "intake", actor: { kind: "user", id: USER } });
  });

  it("the link uses the configured ui.port; with no port (a chat caller) only the ID and the next step print", async () => {
    const { d } = await setup();
    const linked = await runLocalCli({ ...d, ui: { port: 5123 } }, { action: "create", title: "t", bodyFile: "b" });
    expect(linked.lines[2]).toBe(`http://127.0.0.1:5123/app/items/${linked.lines[0]}`);
    const bare = await runLocalCli(d, { action: "create", title: "t", bodyFile: "b" });
    expect(bare.lines).toEqual([bare.lines[0], shortItemId(bare.lines[0]!), CREATE_NEXT_STEP]);
    expect(bare.lines[0]).toMatch(/^wi_/);
  });

  it("with no stored project it fails and creates nothing", async () => {
    const { store, d } = await setup();
    const r = await runLocalCli({ ...d, project: async () => null }, { action: "create", title: "t", bodyFile: "b" });
    expect(r.code).toBe(1);
    expect(await store.listWorkItems(10)).toEqual([]);
  });
});

describe("task create --depends-on (design 05-dependencies, 2026-11-20)", () => {
  it("--help lists --depends-on <id>, and the flag parses with a wi_ or tk_ ID only", () => {
    const help = parseLocalCliArgs("task", ["create", "--help"]);
    expect(help).toMatchObject({ error: expect.stringContaining("--depends-on <id>") });
    expect((help as { error: string }).error).toContain("task create --title <t> --body-file <f> [--depends-on <id>]");
    expect(parseLocalCliArgs("task", ["create", "--title", "T", "--body-file", "b.md", "--depends-on", "wi_abc"])).toEqual({
      action: "create", title: "T", bodyFile: "b.md", depends_on: "wi_abc",
    });
    expect(parseLocalCliArgs("task", ["create", "--depends-on", "tk_1", "--title", "T", "--body-file", "b.md", "--project", "home"])).toEqual({
      action: "create", title: "T", bodyFile: "b.md", depends_on: "tk_1", project: "home",
    });
    for (const bad of ["#12", "abc", ""]) {
      expect(parseLocalCliArgs("task", ["create", "--title", "T", "--body-file", "b.md", "--depends-on", bad]), bad).toMatchObject({ error: expect.stringContaining("--depends-on") });
    }
  });

  it("stores a `Depends on: <id>` line in the new item's problem", async () => {
    const { store, run } = await setup();
    const first = (await run({ action: "create", title: "First", bodyFile: "a.md" })).lines[0] as WorkItemId;
    const r = await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: first });
    expect(r.code).toBe(0);
    const item = (await store.getWorkItem(r.lines[0] as WorkItemId))!;
    expect(item.problem).toBe(`Second\n\nthe body\n\nDepends on: ${first}`);
    expect(item.issue_text).toBe(item.problem);
  });

  it("takes a work item's short ID (the 11-char `wi_` prefix) and writes the item's full ID", async () => {
    const { store, run } = await setup();
    const first = (await run({ action: "create", title: "First", bodyFile: "a.md" })).lines[0] as WorkItemId;
    const r = await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: first.slice(0, 11) });
    expect(r.code).toBe(0);
    expect((await store.getWorkItem(r.lines[0] as WorkItemId))!.problem).toBe(`Second\n\nthe body\n\nDepends on: ${first}`);
  });

  it("refuses an ID that names no local item, with a message and nothing written", async () => {
    const { store, run } = await setup();
    await store.createWorkItem(issue(9), system);
    const gh = (await store.listWorkItems(10))[0]!.id;
    const before = await snapshot(store);
    for (const id of ["wi_nosuch", "tk_nosuch", gh, "wi_"]) {
      const r = await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: id });
      expect(r, id).toEqual({ code: 1, lines: [`--depends-on ${id} names no local work item or built task, so nothing was created`] });
    }
    expect(await snapshot(store)).toEqual(before);
  });

  // Found 2026-11-27: the edge was written only by the coordination pass, so an implement run queued by the spec's
  // approval was claimed before that pass and ran before its dependency merged.
  it("records the edge to the named item's source key at once, so a queued implement run is held before any coordination pass", async () => {
    const { store, run } = await setup();
    const first = (await run({ action: "create", title: "First", bodyFile: "a.md" })).lines[0] as WorkItemId;
    const firstSource = (await store.getWorkItem(first))!.source.id;
    for (const given of [first.slice(0, 11), first.slice(3, 11)]) {
      const id = (await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: parseDependsOn(given) })).lines[0] as WorkItemId;
      expect(await store.listDependencyEdges({ work_item_id: id }), given).toMatchObject([{ depends_on: firstSource, kind: "depends_on", state: "open" }]);
    }
    const second = (await run({ action: "create", title: "Third", bodyFile: "b.md", depends_on: first.slice(0, 11) })).lines[0] as WorkItemId;
    await at(store, second, { stage: "RUNNING", tier: 2, allowed_paths: ["lib/"], files_to_change: ["lib/a.ts"] });
    await store.enqueueRun({ work_item_id: second, kind: "implement", idempotency_key: `${second}:implement` });
    expect(await store.claimRun({ worker_id: w1, kinds: ["implement"], lease_ms: 60_000 })).toBeNull();
  });

  it("a --project task's edge names the dependency's task source key; a tk_ ID still writes its line as given", async () => {
    const { store, run } = await setup();
    await store.createProject({ id: "pj_home", name: "Home", created_by: USER });
    const a = await run({ action: "create", title: "First", bodyFile: "a.md", project: "home" });
    const tk = a.lines[2]!.split(" ")[1]!;
    const firstSource = (await store.getWorkItem(a.lines[0] as WorkItemId))!.source.id;
    expect(firstSource).toBe(`local-task-${tk}`);
    for (const depends_on of [tk, (a.lines[0] as string).slice(0, 11)]) {
      const r = await run({ action: "create", title: "Second", bodyFile: "b.md", project: "home", depends_on });
      expect(r.code, depends_on).toBe(0);
      const id = r.lines[0] as WorkItemId;
      expect((await store.getWorkItem(id))!.problem, depends_on).toBe(`Second\n\nthe body\n\nDepends on: ${depends_on.startsWith("tk_") ? tk : a.lines[0]}`);
      expect(await store.listDependencyEdges({ work_item_id: id }), depends_on).toMatchObject([{ depends_on: firstSource, kind: "depends_on" }]);
    }
  });

  it("refuses a prefix of several items' IDs, naming how many, and an unknown bare short ID, with nothing written", async () => {
    const { store, run } = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 17; i++) ids.push((await run({ action: "create", title: `Item ${i}`, bodyFile: "a.md" })).lines[0]!);
    // 17 IDs over 16 hex digits: at least two share their first one.
    const shared = [...new Set(ids.map((id) => id.slice(0, 4)))].find((p) => ids.filter((id) => id.startsWith(p)).length > 1)!;
    const count = ids.filter((id) => id.startsWith(shared)).length;
    const before = await snapshot(store);
    expect(await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: shared })).toEqual({
      code: 1, lines: [`--depends-on ${shared} names ${count} work items; give more of its ID, so nothing was created`],
    });
    const unknown = parseDependsOn("0000000000");
    expect(await run({ action: "create", title: "Second", bodyFile: "b.md", depends_on: unknown })).toEqual({
      code: 1, lines: ["--depends-on wi_0000000000 names no local work item or built task, so nothing was created"],
    });
    expect(await snapshot(store)).toEqual(before);
  });
});

/** The `--depends-on` value `task create` parses `given` to. */
function parseDependsOn(given: string): string {
  const a = parseLocalCliArgs("task", ["create", "--title", "T", "--body-file", "b.md", "--depends-on", given]);
  if ("error" in a || a.action !== "create" || a.depends_on === undefined) throw new Error(`--depends-on ${given} did not parse`);
  return a.depends_on;
}

describe("task list and task show", () => {
  it("list prints each local item's ID, short ID, title, stage and blocked reason; GitHub items are left out", async () => {
    const { store, run } = await setup();
    await store.createWorkItem(issue(9), system);
    const id = (await run({ action: "create", title: "Local one", bodyFile: "b" })).lines[0]!;
    const r = await run({ action: "list" });
    expect(r).toEqual({ code: 0, lines: [`${id}\t${id.slice(3, 11)}\tLocal one\tNEW\t-`] });
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

describe("work item IDs as a person reads them (design 05-sources, short IDs)", () => {
  /** 17 items, so two share their first hex character (pigeonhole): that character names several. */
  async function many() {
    const s = await setup();
    const ids: WorkItemId[] = [];
    for (let n = 1; n <= 17; n++) ids.push((await s.store.createWorkItem(issue(n), system)).item.id);
    const hex = ids.map((id) => id.slice(3, 4)).find((c, i, all) => all.indexOf(c) !== i)!;
    return { ...s, ids, hex, shared: ids.filter((id) => id.startsWith(`wi_${hex}`)).sort() };
  }

  it("shortItemId is the 8 hex characters after wi_; any other ID as it is", () => {
    expect(shortItemId("wi_c86970ff1a73401c952d9228d6156b6d")).toBe("c86970ff");
    expect(shortItemId("local-f77945b7-9bb4")).toBe("local-f77945b7-9bb4");
  });

  it("task show resolves the full ID, the short ID and any unique prefix of either, with or without wi_", async () => {
    const { run, ids, hex } = await many();
    const id = ids.find((x) => !x.startsWith(`wi_${hex}`))!;
    const full = await run({ action: "show", id });
    expect(full.code).toBe(0);
    for (const token of [shortItemId(id), `wi_${shortItemId(id)}`, id.slice(3, 9), id.slice(0, 9), id.slice(3)]) {
      expect(await run({ action: "show", id: token as WorkItemId }), token).toEqual(full);
    }
  });

  it("an ambiguous prefix lists every matching full ID with its short ID, exits 1 and writes nothing", async () => {
    const { store, run, hex, shared } = await many();
    const before = await snapshot(store);
    for (const a of [
      { action: "show", id: hex }, { action: "help", id: `wi_${hex}` },
      ...(["approve", "retry", "revise", "reject", "resolve", "verdict", "merge"] as const).map((command) => ({ action: "command", command, id: hex, text: command === "verdict" ? "accept none fine" : "" })),
    ] as CliAction[]) {
      const r = await run(a);
      expect(r.code, a.action).toBe(1);
      expect(r.lines.slice(1)).toEqual(shared.map((id) => `  ${id}\t${shortItemId(id)}`));
    }
    expect(await snapshot(store)).toEqual(before);
    expect(await store.getOwner()).toBeNull();
  });

  it("a token with no match, or with no hex characters after wi_, is refused as no work item and reads no rows", async () => {
    const { store, run } = await many();
    for (const token of ["wi_", "", "wi_zz", "f77945b7-x", "wi_ffffffffffffffffffffffffffffffff0"]) {
      expect(await run({ action: "show", id: token as WorkItemId })).toEqual({ code: 1, lines: [`no work item ${token}`] });
    }
    const reads: string[] = [];
    const counted = { findWorkItemIds: (p: string) => (reads.push(p), store.findWorkItemIds(p)), getWorkItem: (id: WorkItemId) => (reads.push(id), store.getWorkItem(id)) };
    for (const token of ["wi_", "", "zz", "wi_-x", "missing"]) expect(await resolveItem(counted, token)).toEqual({ code: 1, lines: [`no work item ${token}`] });
    expect(reads).toEqual([]);
  });

  it("every item command and help resolve a short ID; the stored command carries the full ID", async () => {
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    const short = shortItemId(id) as WorkItemId;
    const commands = ["approve", "retry", "revise", "reject", "resolve", "verdict", "merge"] as const;
    for (const command of commands) {
      // approve where the spec waits for it, the others where the item waits for a merge.
      await at(store, id, command === "approve" ? undefined : { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" });
      expect(await run({ action: "help", id: short })).toEqual(await run({ action: "help", id }));
      const r = await run({ action: "command", command, id: short, text: command === "verdict" ? "accept none fine" : "" });
      expect(r.lines.join("\n"), command).toContain(id);
    }
    const stored = await store.listCliCommandsAfter(0, 100);
    expect(stored.map((c) => c.command)).toEqual(expect.arrayContaining([...commands]));
    for (const c of stored) expect(c.args.item).toBe(id);
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

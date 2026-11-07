import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliUserConfig } from "../src/core/config.js";
import {
  CLI_COMMANDS, CLI_TOP_WORDS, type CliAction, type LocalCliDeps, NO_CLI_USER, cliCommandListMarkdown, parseLocalCliArgs, runLocalCli,
} from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// The writer side of local intake (issue #200): CLI commands that create local items, append item commands to
// the command log, and print a task's state and messages. No GitHub call: the deps hold no GitHub client.

const USER = "github:12345" as UserId;

async function setup(user: UserId | null = USER) {
  const { store } = await newStore();
  const reads: string[] = [];
  let n = 0;
  const d: LocalCliDeps = {
    store, user, project: async () => PROJECT_KEY, read: async (p) => (reads.push(p), "the body\n"), newId: () => `id${++n}`,
  };
  const run = (a: CliAction) => runLocalCli(d, a);
  return { store, d, run, reads };
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
  });

  it("anything incomplete or unknown is an error with the usage", () => {
    for (const [w, a] of [
      ["task", []], ["task", ["create", "--title", "T"]], ["task", ["create", "--body-file", "b"]], ["task", ["create", "--title"]],
      ["task", ["create", "--title", "T", "--body-file", "b", "--label", "x"]], ["task", ["show"]], ["task", ["list", "x"]],
      ["task", ["frob"]], ["approve", []], ["retry", []],
    ] as [string, string[]][]) {
      const r = parseLocalCliArgs(w, a);
      expect({ w, a, r }).toMatchObject({ r: { error: expect.stringContaining("usage:") } });
    }
  });

  it("the top-level words are the first word of every command, and each has a table entry", () => {
    expect([...new Set(CLI_COMMANDS.map((c) => c.name.split(" ")[0]))]).toEqual([...CLI_TOP_WORDS]);
    for (const c of CLI_COMMANDS) expect(c.usage.startsWith(c.name)).toBe(true);
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

  it("show for a missing item fails", async () => {
    const { run } = await setup();
    expect((await run({ action: "show", id: "wi_missing" as WorkItemId })).code).toBe(1);
  });
});

describe("approve, retry, revise, reject", () => {
  it("each stores one command in the command log and changes no item state", async () => {
    const { store, run } = await setup();
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    const before = await snapshot(store);
    for (const command of ["approve", "retry", "revise", "reject"] as const) {
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
    ]);
    expect(new Set(added.map((c) => c.key)).size).toBe(added.length);
  });

  it("a missing or non-local item stores nothing", async () => {
    const { store, run } = await setup();
    const gh = (await store.createWorkItem(issue(3), system)).item;
    expect((await run({ action: "command", command: "approve", id: "wi_missing" as WorkItemId, text: "" })).code).toBe(1);
    const r = await run({ action: "command", command: "approve", id: gh.id, text: "" });
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain("not a local work item");
    expect(await store.listCliCommandsAfter(0, 100)).toEqual([]);
  });
});

describe("the configured CLI user", () => {
  it("with no configured user every command prints an error, exits with code 1 and writes nothing", async () => {
    const { store, run } = await setup(null);
    const actions: CliAction[] = [
      { action: "create", title: "t", bodyFile: "b" },
      { action: "list" },
      { action: "show", id: "wi_1" as WorkItemId },
      ...(["approve", "retry", "revise", "reject"] as const).map((command) => ({ action: "command" as const, command, id: "wi_1" as WorkItemId, text: "" })),
    ];
    for (const a of actions) expect(await run(a)).toEqual({ code: 1, lines: [NO_CLI_USER] });
    expect(await snapshot(store)).toEqual({ items: [], runs: [], changes: [], commands: [] });
  });

  it("cli_user is read from the config: absent is null, a factory user ID is kept, anything else throws", () => {
    expect(cliUserConfig({})).toBeNull();
    expect(cliUserConfig({ cli_user: "github:12345" })).toBe("github:12345");
    expect(() => cliUserConfig({ cli_user: "alice" })).toThrow("cli_user must be a factory user ID");
    expect(() => cliUserConfig({ cli_user: 5 })).toThrow("cli_user");
  });
});

describe("SET_UP.md", () => {
  it("lists every CLI command, exactly as the CLI's command table has them", () => {
    const setup = readFileSync(new URL("../SET_UP.md", import.meta.url), "utf8");
    expect(setup).toContain(cliCommandListMarkdown());
    const listed = setup.split("\n").filter((l) => l.startsWith("- `factory ")).map((l) => /^- `factory ([^`]+)`/.exec(l)![1]);
    expect(listed).toEqual(CLI_COMMANDS.map((c) => c.usage));
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cliUserConfig } from "../src/core/config.js";
import {
  CLI_COMMANDS, CLI_TOP_WORDS, type CliAction, type CliIdentity, type LocalCliDeps, cliCommandListMarkdown, cliIdentity, parseLocalCliArgs,
  runLocalCli,
} from "../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
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
    expect(parseLocalCliArgs("users", ["list"])).toEqual({ action: "users_list" });
    expect(parseLocalCliArgs("users", ["add", "local:a@b.c", "--role", "approver"])).toEqual({ action: "users_add", user: "local:a@b.c", role: "approver" });
    expect(parseLocalCliArgs("users", ["remove", "local:a@b.c"])).toEqual({ action: "users_remove", user: "local:a@b.c" });
  });

  it("anything incomplete or unknown is an error with the usage", () => {
    for (const [w, a] of [
      ["task", []], ["task", ["create", "--title", "T"]], ["task", ["create", "--body-file", "b"]], ["task", ["create", "--title"]],
      ["task", ["create", "--title", "T", "--body-file", "b", "--label", "x"]], ["task", ["show"]], ["task", ["list", "x"]],
      ["task", ["frob"]], ["approve", []], ["retry", []], ["users", []], ["users", ["add", "alice", "--role", "approver"]],
      ["users", ["add", "local:a", "--role", "owner"]], ["users", ["add", "local:a"]], ["users", ["remove"]], ["users", ["list", "x"]],
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

describe("local users", () => {
  it("the first identity to write becomes the owner; a second one does not", async () => {
    const { store, run, as } = await setup("local:me@example.com" as UserId);
    expect(await store.listLocalUsers()).toEqual([]);
    expect((await run({ action: "list" })).code).toBe(0);
    expect(await store.listLocalUsers()).toEqual([]);
    await run({ action: "create", title: "t", bodyFile: "b" });
    await as("local:dev@example.com")({ action: "create", title: "t", bodyFile: "b" });
    expect((await store.listLocalUsers()).map((u) => [u.user_id, u.role])).toEqual([["local:me@example.com", "owner"]]);
  });

  it("anonymous may create, list and show but never becomes the owner or an approver", async () => {
    const { store, run } = await setup("local:anonymous" as UserId, "anonymous");
    const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
    expect((await store.getWorkItem(id))!.requester_id).toBe("local:anonymous");
    expect((await run({ action: "show", id })).code).toBe(0);
    expect(await store.listLocalUsers()).toEqual([]);
    expect((await run({ action: "users_add", user: "local:x" as UserId, role: "approver" })).code).toBe(1);
  });

  it("only the owner adds and removes roles; anonymous cannot be made an approver; the owner stays", async () => {
    const { store, run, as } = await setup("local:me@example.com" as UserId);
    const dev = "local:dev@example.com" as UserId;
    expect(await run({ action: "users_add", user: dev, role: "approver" })).toEqual({ code: 0, lines: [`${dev} is now an approver`] });
    expect((await as(dev)({ action: "users_add", user: "local:eve" as UserId, role: "approver" })).lines[0]).toContain("only the local owner");
    expect((await run({ action: "users_add", user: "local:anonymous" as UserId, role: "approver" })).lines[0]).toContain("read and create only");
    expect((await run({ action: "users_add", user: "local:me@example.com" as UserId, role: "requester" })).code).toBe(1);
    expect((await run({ action: "users_remove", user: "local:me@example.com" as UserId })).code).toBe(1);
    expect((await run({ action: "users_list" })).lines.slice(1)).toEqual([
      "local:me@example.com\towner\tadded by local:me@example.com",
      `${dev}\tapprover\tadded by local:me@example.com`,
    ]);
    expect(await run({ action: "users_remove", user: dev })).toEqual({ code: 0, lines: [`removed ${dev}`] });
    expect(await store.getLocalUser(dev)).toBeNull();
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

// `factory verdict` (issues #513, #523): the CLI's item command for `/verdict`. It runs the controller's parser before any
// write, so a malformed verdict prints the usage line and stores nothing; a valid one is one command row, which the
// controller applies as the comment `/verdict`: one verdict row, no change to stage, blocked_on or blocked_reason.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { commandFooter, commandState, commandsFor } from "../src/core/commands.js";
import { type CliAction, type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItemId, WorkItemPatch } from "../src/core/types.js";
import { VERDICT_USAGE } from "../src/core/verdict.js";
import { LocalAuthProvider } from "../src/impl/auth/local-auth-provider.js";
import { FakeClock } from "../src/impl/clock/fake-clock.js";
import { LocalSource } from "../src/impl/source/local-source.js";
import { ControllerRole } from "../src/runtime/roles/controller-role.js";
import { cleanScanner, config, silent } from "./helpers/fakes.js";
import { PROJECT_KEY, newStore, system } from "./helpers/store.js";

const ME = "local:me@example.com" as UserId;

/** A local item filed from the CLI by ME (the local owner), put at `patch`; the controller reads the command log. */
async function setup(patch: WorkItemPatch) {
  const clock = new FakeClock();
  const { store } = await newStore(clock);
  const controller = new ControllerRole({
    store, sources: [new LocalSource(store)], auth: new LocalAuthProvider(store), clock, config, log: silent, scanner: cleanScanner,
    repeated_failure_rule: false,
  });
  let n = 0;
  const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "b", newId: () => `id${++n}` };
  const run = (a: CliAction) => runLocalCli(d, a);
  const id = (await run({ action: "create", title: "t", bodyFile: "b" })).lines[0] as WorkItemId;
  const it = (await store.getWorkItem(id))!;
  const r = await store.transition({ id, expected_version: it.version, actor: system, reason: "test_setup", patch });
  if (!r.ok) throw new Error("setup");
  /** Parses `factory verdict <id> <words>` as main.ts does, then runs it. */
  const verdict = async (...words: string[]) => {
    const a = parseLocalCliArgs("verdict", [id, ...words]);
    if ("error" in a) throw new Error(a.error);
    return run(a);
  };
  return { store, id, run, verdict, tick: () => controller.tickIntake() };
}

const MERGE_PENDING_PR: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending", change_ref: "42" };
const MERGE_PENDING_LOCAL: WorkItemPatch = { stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" };

describe("factory verdict", () => {
  it("parses as an item command whose text is the verdict", () => {
    expect(parseLocalCliArgs("verdict", ["wi_1", "changes", "minor", "rename", "the", "flag"])).toEqual({
      action: "command", command: "verdict", id: "wi_1", text: "changes minor rename the flag",
    });
    expect(parseLocalCliArgs("verdict", [])).toMatchObject({ error: expect.stringContaining("verdict needs a work item ID") });
  });

  it("a valid verdict stores one command row and changes no item state", async () => {
    const f = await setup(MERGE_PENDING_PR);
    const before = await f.store.getWorkItem(f.id);
    const r = await f.verdict("accept", "none", "looks right");
    expect(r).toEqual({ code: 0, lines: [expect.stringContaining(`stored \`/verdict\` for ${f.id} as ${ME}`)] });
    expect((await f.store.listCliCommandsAfter(0, 100)).map((c) => ({ actor: c.actor, command: c.command, args: c.args }))).toEqual([
      { actor: ME, command: "verdict", args: { item: f.id, text: "accept none looks right" } },
    ]);
    expect(await f.store.getWorkItem(f.id)).toEqual(before);
  });

  it("a malformed verdict is an error with the usage line and stores nothing", async () => {
    const f = await setup(MERGE_PENDING_PR);
    for (const words of [["lgtm"], ["changes"], ["reject", "huge", "no"], ["changes", "minor"]]) {
      const a = parseLocalCliArgs("verdict", [f.id, ...words]);
      expect(a, words.join(" ")).toMatchObject({ error: expect.stringContaining(VERDICT_USAGE) });
    }
    expect(await f.store.listCliCommandsAfter(0, 100)).toEqual([]);
  });

  it("the controller applies a valid CLI verdict as /verdict: one verdict row, no change to stage, blocked_on or blocked_reason", async () => {
    const f = await setup(MERGE_PENDING_PR);
    expect((await f.verdict("changes", "minor", "rename the flag")).code).toBe(0);
    await f.tick();
    const [cmd] = await f.store.listCliCommandsAfter(0, 10);
    expect(await f.store.listVerdicts(f.id)).toEqual([expect.objectContaining({
      verdict: "changes", severity: "minor", reason: "rename the flag", comment_id: cmd!.key, target: "issue", implicit: false,
    })]);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
    const verdictChange = (await f.store.listStateChanges(f.id)).find((c) => c.reason === "human_verdict");
    expect(verdictChange).toMatchObject({ actor: { kind: "user", id: ME }, changes: {} });
    // Read again: the same row stores nothing more.
    await f.tick();
    expect(await f.store.listVerdicts(f.id)).toHaveLength(1);
  });

  it("a local item with no PR takes a CLI verdict, as the controller accepts it (decision 3), with no PR head", async () => {
    const f = await setup(MERGE_PENDING_LOCAL);
    expect((await f.verdict("accept")).code).toBe(0);
    await f.tick();
    expect(await f.store.listVerdicts(f.id)).toEqual([expect.objectContaining({ verdict: "accept", severity: "none", reason: null, pr_head: null })]);
    expect(await f.store.getWorkItem(f.id)).toMatchObject({ stage: "REVIEW", blocked_on: "human", blocked_reason: "merge_pending" });
  });
});

describe("verdict on a local item with no PR (decision 3)", () => {
  it("applies in the command rules, so the footer and the dashboard list it; an item of another source still needs its PR", async () => {
    const at = { stage: "REVIEW" as const, blocked_on: "human" as const, blocked_reason: "merge_pending", change_ref: null };
    const local = commandState({ ...at, source: { type: "local", id: "local-1", link: "local:local-1" } });
    const github = commandState({ ...at, source: { type: "github", id: "o/r#1", link: "https://example.invalid/1" } });
    expect(commandsFor(local).map((c) => c.name)).toContain("verdict");
    expect(commandFooter(local)).toContain("`/verdict accept|changes|reject <severity> <reason>`");
    expect(commandsFor(github).map((c) => c.name)).not.toContain("verdict");
    // A closed local item that was not merged still takes none, as the controller refuses it.
    expect(commandsFor(commandState({ ...at, stage: "CLOSED", blocked_on: "none", blocked_reason: null, source: { type: "local", id: "l", link: "l" } })).map((c) => c.name))
      .not.toContain("verdict");
  });
});

describe("auto_merge_max_tier (decision 1: unchanged)", () => {
  it("stays 0 in factory.config.json", () => {
    const cfg = JSON.parse(readFileSync(new URL("../factory.config.json", import.meta.url), "utf8")) as { dials?: { auto_merge_max_tier?: number } };
    expect(cfg.dials?.auto_merge_max_tier).toBe(0);
  });

  it("no file this change added code to names it", () => {
    for (const f of ["../src/core/local-cli.ts", "../src/core/commands.ts", "../src/core/verdict.ts", "../src/ui/commands.ts", "../web/src/views/item-commands.tsx"]) {
      expect(readFileSync(new URL(f, import.meta.url), "utf8"), f).not.toContain("auto_merge_max_tier");
    }
  });
});

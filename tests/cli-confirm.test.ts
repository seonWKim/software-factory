import { describe, expect, it } from "vitest";
import { CONFIRM_COMMAND } from "../src/core/interpret.js";
import { type LocalCliDeps, parseLocalCliArgs, runLocalCli } from "../src/core/local-cli.js";
import type { UserId, WorkItem, WorkItemId } from "../src/core/types.js";
import type { FactoryStore } from "../src/interfaces/factory-store.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// `factory confirm <proposal-id>` (design 04-gate-commands): one `proposal_confirm` command row for a stored proposal
// with a pending command, as the CLI identity; the controller applies it (tests/command-proposals.test.ts). Store only.

const ME = "local:me@example.com" as UserId;
const PROP = "prop_cli1";

async function setup() {
  const { store } = await newStore();
  let n = 0;
  const d: LocalCliDeps = { store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `k${++n}` };
  const { item } = await store.createWorkItem(issue(1), system);
  return { store, d, item };
}

const propose = (store: FactoryStore, item: WorkItem) =>
  store.recordCommandProposals([
    { proposal_id: PROP, idx: 0, work_item_id: item.id, command: "approve", args: "ship it", author_id: ME },
    { proposal_id: PROP, idx: 1, work_item_id: "wi_other" as WorkItemId, command: "retry", args: "", author_id: ME },
  ]);

describe("factory confirm <proposal-id>", () => {
  it("takes exactly one proposal ID", () => {
    expect(parseLocalCliArgs("confirm", [PROP])).toEqual({ action: "confirm", proposal: PROP });
    for (const args of [[], [PROP, "extra"], ["prop:bad"], ["two words"]]) {
      expect(parseLocalCliArgs("confirm", args)).toMatchObject({ error: expect.stringContaining("usage:") });
    }
  });

  it("stores one confirm command row naming the proposal and the first pending command's item; no item changes", async () => {
    const { store, d, item } = await setup();
    await propose(store, item);
    const before = await store.getWorkItem(item.id);
    const r = await runLocalCli(d, { action: "confirm", proposal: PROP });
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([expect.stringContaining(`stored \`factory confirm ${PROP}\` as ${ME}`)]);
    expect(r.lines[0]).toContain("its 2 pending commands");
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => [c.key, c.actor, c.command, c.args])).toEqual([
      ["cli:k1", ME, CONFIRM_COMMAND, { item: item.id, proposal: PROP }],
    ]);
    expect(await store.listUnmirroredCliCommands(10)).toEqual([]);
    expect(await store.getWorkItem(item.id)).toEqual(before);
    expect((await store.listCommandProposals(PROP)).map((x) => x.status)).toEqual(["pending", "pending"]);
  });

  it("an unknown proposal fails and stores nothing", async () => {
    const { store, d } = await setup();
    expect(await runLocalCli(d, { action: "confirm", proposal: "prop_nope" })).toEqual({ code: 1, lines: ["no proposal prop_nope"] });
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });

  it("a proposal with nothing pending stores nothing and says what already happened to each command", async () => {
    const { store, d, item } = await setup();
    await propose(store, item);
    for (const idx of [0, 1]) await store.answerCommandProposal({ proposal_id: PROP, idx, from: "pending", to: idx === 0 ? "applied" : "cancelled", answered_by: ME });
    const r = await runLocalCli(d, { action: "confirm", proposal: PROP });
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe(`nothing was applied: every command of ${PROP} was already applied or answered`);
    expect(r.lines.slice(1)).toEqual([`  ${item.id}\t/approve ship it\tapplied`, "  wi_other\t/retry\tcancelled"]);
    expect(await store.listCliCommandsAfter(0, 10)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { type LocalCliDeps, runLocalCli } from "../src/core/local-cli.js";
import type { UserId } from "../src/core/types.js";
import { answersDetail, splitAnswers } from "../src/shared/command-notes.js";
import { PROJECT_KEY, issue, newStore, system } from "./helpers/store.js";

// The CLI's command rows record who wrote them (design 08-permissions, 2026-11-27): a person typing a command is a
// `human_command`. Store only.

const ME = "local:me@example.com" as UserId;

describe("the CLI's command rows", () => {
  it("are stored with write_origin human_command", async () => {
    const { store } = await newStore();
    let n = 0;
    const d: LocalCliDeps = { answers: { split: splitAnswers, detail: answersDetail }, store, identity: { user: ME, from: "git user.email" }, project: async () => PROJECT_KEY, read: async () => "", newId: () => `k${++n}` };
    const { item } = await store.createWorkItem(issue(1), system);
    await store.recordCommandProposals([{ proposal_id: "prop_cli1", idx: 0, work_item_id: item.id, command: "approve", args: "", author_id: ME }]);
    expect((await runLocalCli(d, { action: "confirm", proposal: "prop_cli1" })).code).toBe(0);
    expect((await store.listCliCommandsAfter(0, 10)).map((c) => [c.key, c.write_origin])).toEqual([["cli:k1", "human_command"]]);
  });
});

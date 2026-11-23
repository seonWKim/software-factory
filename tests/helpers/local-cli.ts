import { splitAnswers, answersDetail } from "../../src/shared/command-notes.js";
import { type CliAction, type CliIdentity, type LocalCliDeps, runLocalCli } from "../../src/core/local-cli.js";
import type { UserId, WorkItemId } from "../../src/core/types.js";
import type { FactoryStore } from "../../src/interfaces/factory-store.js";
import { PROJECT_KEY, newStore, system } from "./store.js";

export const USER = "github:12345" as UserId;
/** The decision answers parser the callers pass in (src/core cannot import src/shared). */
export const answers = { split: splitAnswers, detail: answersDetail };

export async function setup(user: UserId = USER, from: CliIdentity["from"] = "cli_user") {
  const { store } = await newStore();
  const reads: string[] = [];
  let n = 0;
  const d: LocalCliDeps = {
    store, identity: { user, from }, project: async () => PROJECT_KEY, read: async (p) => (reads.push(p), "the body\n"), newId: () => `id${++n}`, answers,
  };
  const run = (a: CliAction) => runLocalCli(d, a);
  /** The same store, another person's terminal. */
  const as = (other: string) => (a: CliAction) => runLocalCli({ ...d, identity: { user: other as UserId, from: "git user.email" } }, a);
  return { store, d, run, reads, as };
}

/** Puts `id` at `patch` (the spec gate unless given), as the controller would have. */
export async function at(store: FactoryStore, id: WorkItemId, patch: Parameters<FactoryStore["transition"]>[0]["patch"] = { stage: "READY", blocked_on: "human", blocked_reason: "spec_pending" }) {
  const it = (await store.getWorkItem(id))!;
  const r = await store.transition({ id, expected_version: it.version, actor: system, reason: "test_setup", patch });
  if (!r.ok) throw new Error("setup");
}

/** Every row a CLI command could touch. */
export async function snapshot(store: FactoryStore) {
  const items = await store.listWorkItems(100);
  const runs = await Promise.all(items.map((i) => store.listRuns(i.id)));
  const changes = await Promise.all(items.map((i) => store.listStateChanges(i.id)));
  return { items, runs, changes, commands: await store.listCliCommandsAfter(0, 1000) };
}

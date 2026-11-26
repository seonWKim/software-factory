import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { answersDetail, splitAnswers } from "../../../shared/command-notes.js";
import { Plugins, type CliIdentity, type FactoryStore } from "../../command.js";

/** The two legacy lookups (src/core's storedProjectCaps, src/ui's storeProjectResolver), passed in and typed by shape so this file imports neither (dependency-direction ratchet). */
export interface LocalCliLookups {
  storedProjectCaps: (store: FactoryStore, config: { file: object; layers: Loaded["config"]["settings"] }, repo: string, key: string | null, project: string) => Promise<{ max_diff_lines: number; max_diff_files: number }>;
  storeProjectResolver: (store: FactoryStore, repo: { owner: string; name: string }) => () => Promise<{ key: string } | null>;
}

type Loaded = ConstructorParameters<typeof Plugins>[0];

/** What `runLocalCli` is called with: the store, the CLI identity, the project resolver, file reader, id generator, clock, UI settings, answer helpers and caps lookup. */
export async function buildLocalCliDeps(
  store: FactoryStore,
  loaded: Loaded,
  identity: CliIdentity,
  cli: string,
  drafts: boolean, // `schedule draft` and `improve`: the model, scanner and terminal ask are built
  { storedProjectCaps, storeProjectResolver }: LocalCliLookups,
) {
  const { owner, name } = loaded.config.repo;
  // `schedule draft` and `improve` only: the configured model (null when it cannot be built: the feature is off), the
  // scanner, and a y/N ask while stdin is a terminal.
  const drafting = drafts ? await draftParts(loaded) : {};
  const resolveProject = storeProjectResolver(store, { owner, name });
  return {
    store,
    identity,
    project: async () => (await resolveProject())?.key ?? null,
    read: (path: string) => readFile(path, "utf8"),
    newId: () => randomUUID(),
    clock: await new Plugins(loaded).clock(), // today's UTC day, for the coordinator limit question (design 06-spend)
    cli,
    ui: loaded.file.ui ?? {},
    answers: { split: splitAnswers, detail: answersDetail },
    ...drafting,
    caps: async (project: string) => storedProjectCaps(store, { file: {}, layers: loaded.config.settings }, `${owner}/${name}`, (await resolveProject())?.key ?? null, project),
  };
}

/** The model, the egress scanner and the terminal ask `schedule draft` and `improve` take (src/core/schedule-draft.ts). */
async function draftParts(loaded: Loaded) {
  const p = new Plugins(loaded), secrets = await p.secrets();
  const llm = await p.llm(secrets).catch(() => null);
  return { llm, scanner: await p.scanner(secrets), ...(process.stdin.isTTY ? { ask: terminalAsk } : {}) };
}

/** A y/N question read from the terminal, after the lines it is about: only y or yes is a yes. */
async function terminalAsk(shown: readonly string[], question: string): Promise<boolean> {
  for (const line of shown) console.log(line);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

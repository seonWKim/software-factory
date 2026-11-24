import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { type CliAction, type LocalCliDeps, storedProjectCaps } from "../../../core/local-cli.js";
import { answersDetail, splitAnswers } from "../../../shared/command-notes.js";
import { storeProjectResolver } from "../../../ui/settings-api.js";
import { Plugins, type CliIdentity, type FactoryStore } from "../../command.js";

type Loaded = ConstructorParameters<typeof Plugins>[0];

/** What `runLocalCli` is called with: the store, the CLI identity, the project resolver, file reader, id generator, UI settings, answer helpers and caps lookup. */
export async function buildLocalCliDeps(
  store: FactoryStore,
  loaded: Loaded,
  identity: CliIdentity,
  cli: string,
  action: CliAction,
): Promise<LocalCliDeps> {
  const { owner, name } = loaded.config.repo;
  // `schedule draft` and `improve` only: the configured model (null when it cannot be built: the feature is off), the
  // scanner, and a y/N ask while stdin is a terminal.
  const drafting = action.action === "schedule" && ["draft", "improve"].includes(action.command.verb) ? await draftParts(loaded) : {};
  const resolveProject = storeProjectResolver(store, { owner, name });
  return {
    store,
    identity,
    project: async () => (await resolveProject())?.key ?? null,
    read: (path) => readFile(path, "utf8"),
    newId: () => randomUUID(),
    cli,
    ui: loaded.file.ui ?? {},
    answers: { split: splitAnswers, detail: answersDetail },
    ...drafting,
    caps: async (project) => storedProjectCaps(store, { file: {}, layers: loaded.config.settings }, `${owner}/${name}`, (await resolveProject())?.key ?? null, project),
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

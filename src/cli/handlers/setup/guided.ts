// The guided `factory setup` (owner decision 2026-11-08). Each step shows its default and Enter takes it; `--yes`
// takes every default. The shared choices (store, sync plugins) go to factory.config.json after a diff and a
// question; the mode and the auto-merge tier are runtime settings (`factory settings`), set through that command;
// then the secret, database, plugin, check and canary steps of src/setup.ts. `--me` only registers the person.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Loaded, Plugins, buildStatsStore, settingsBase } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { cliIdentity } from "../../../core/local-cli.js";
import { AUTO_MERGE_TIER_MAX, MODES, type Mode, resolveSettings } from "../../../core/settings.js";
import { ProfileStore } from "../../../identity/index.js";
import { storeSql } from "../../../impl/store/sql/store-sql.js";
import { type SetupRun, setupFinish, setupSecrets } from "../../../setup.js";
import { type CommandContext, loadCommands } from "../../index.js";
import { cliEnvironment, gitUserName } from "../../support.js";
import { type Ask, defaultsAsk, terminalAsk } from "./ask.js";
import { applyChoices, configDiffLines, currentChoices, editConfigText, parseSlackChannels } from "./config-edit.js";
import { registerMe } from "./me.js";

export interface GuidedOptions {
  rotate: SetupRun["rotate"];
  /** Take every default without asking. */
  yes: boolean;
  /** Only register the person (ID and display name); shared config and secrets are not touched. */
  me: boolean;
}

interface ModeChoice {
  mode: Mode;
  auto_merge_max_tier: number;
}

const BUILT_IN_MODE: ModeChoice = { mode: "manual", auto_merge_max_tier: 0 };

export async function guidedSetup(ctx: CommandContext, o: GuidedOptions): Promise<number> {
  if (!o.yes && !process.stdin.isTTY) {
    console.error("setup is interactive: run it in a terminal, or pass --yes to take every default");
    return 1;
  }
  const ask = o.yes ? defaultsAsk() : terminalAsk();
  let n = 0;
  const step = (title: string) => console.log(`\n${++n}. ${title}`);
  let loaded = await ctx.load();
  if (o.me) {
    step("You");
    return (await youStep(loaded, ask)) ? 0 : 1;
  }

  const text = await readFile(loaded.configFile, "utf8");
  const raw = JSON.parse(text) as Record<string, never>;
  const current = currentChoices(raw, loaded.config.local_only !== true);
  step("Store");
  console.log("   sqlite: one machine, no server. mysql: a shared database for a team and several replicas.");
  const store = await ask.choose("   Store", ["sqlite", "mysql"] as const, current.store);

  step("Plugins");
  console.log("   Local intake, specs, branches, review and merge always work. GitHub and Slack are optional sync plugins.");
  const github = await ask.yesNo("   Sync with GitHub (issues, labels, pushes and PRs)?", current.github);
  const slack = await ask.yesNo("   Take work from Slack threads?", current.slack);
  let channels = current.slack_channels;
  if (slack && (ask.interactive || channels.length === 0)) {
    const answer = await ask.text("   Slack channel IDs (C…, comma separated; SET_UP.md, Slack)", channels.join(", "), (a) => {
      const p = parseSlackChannels(a);
      return !p.ok ? `not a channel ID: ${p.bad}` : p.channels.length === 0 ? "at least one channel ID" : null;
    });
    const parsed = parseSlackChannels(answer);
    channels = parsed.ok ? parsed.channels : [];
  }
  if (slack && channels.length === 0) {
    console.log("   Slack stays off: no channel ID given");
  }
  const changes = applyChoices(raw, { store, github, slack: slack && channels.length > 0, slack_channels: channels });
  if (changes.size === 0) {
    console.log(`   ${loaded.configFile}: no change`);
  } else {
    console.log(`   Changes to ${loaded.configFile}:`);
    for (const line of configDiffLines(raw, changes)) console.log(`     ${line}`);
    if (await ask.yesNo("   Write them?", true)) {
      const reloaded = await writeConfig(ctx, loaded.configFile, text, editConfigText(text, changes));
      if (reloaded === null) return 1;
      loaded = reloaded;
    } else {
      console.log("   not written; the steps below use the file as it is");
    }
  }

  step("Mode");
  console.log("   manual: a person approves every spec and merges every change. auto: the factory approves and merges what it may");
  console.log("   (below tier 4, off the gate list; docs/design/03-risk.md). A runtime setting, stored in the database, not the file.");
  const now = (await currentMode(loaded)) ?? BUILT_IN_MODE;
  const mode = await ask.choose("   Mode", MODES, now.mode);
  const tiers = Array.from({ length: AUTO_MERGE_TIER_MAX + 1 }, (_, i) => String(i));
  const tier = Number(await ask.choose("   auto_merge_max_tier: the highest tier auto mode merges by itself (0: none)", tiers, String(now.auto_merge_max_tier)));

  const run: SetupRun = { loaded, rotate: o.rotate, ask, step };
  if (!(await setupSecrets(run))) return 1;

  step("You and the mode");
  await youStep(loaded, ask);
  await applyMode(ctx, loaded, { mode, auto_merge_max_tier: tier });
  return setupFinish(run);
}

/** Writes the new text atomically and loads it; on a config the loader refuses, puts the old text back. */
async function writeConfig(ctx: CommandContext, file: string, before: string, after: string): Promise<Loaded | null> {
  const save = async (t: string) => {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, t);
    await rename(tmp, file);
  };
  await save(after);
  try {
    const loaded = await ctx.load();
    console.log("   written");
    return loaded;
  } catch (err) {
    await save(before);
    console.log(`   refused by the config check, the file is unchanged: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** The store, opened and migrated; null (with the reason printed) when it is not ready yet. */
async function openStore(loaded: Loaded) {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  let store: Awaited<ReturnType<typeof buildStatsStore>> | null = null;
  try {
    store = await buildStatsStore(loaded);
    await store.migrate();
    return store;
  } catch (err) {
    await store?.close();
    console.log(`   the store is not ready: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return null;
  }
}

/** Registers the person (`registerMe`). False when the store is not ready or nothing could be stored. */
async function youStep(loaded: Loaded, ask: Ask): Promise<boolean> {
  const store = await openStore(loaded);
  if (!store) {
    console.log("   skipped: run `npm run migrate` if the line above says so, then `npm run setup -- --me`");
    return false;
  }
  try {
    const r = await registerMe({
      store,
      profiles: new ProfileStore(storeSql(store)),
      identity: cliIdentity(cliUserConfig(loaded.file), await cliEnvironment(loaded.root)),
      gitName: await gitUserName(loaded.root),
      ask,
      now: (await new Plugins(loaded).clock()).now().toISOString(),
    });
    for (const line of r.lines) console.log(line);
    return r.ok;
  } finally {
    await store.close();
  }
}

/** The global mode and auto-merge tier in effect (stored override, else the built-in default); null when the store is not ready. */
async function currentMode(loaded: Loaded): Promise<ModeChoice | null> {
  const store = await openStore(loaded);
  if (!store) return null;
  try {
    const g = resolveSettings(settingsBase(loaded), await store.listSettingOverrides()).global;
    return { mode: g.mode.value, auto_merge_max_tier: g.auto_merge_max_tier.value };
  } finally {
    await store.close();
  }
}

/** Sets each key that differs through `factory settings set`: the same approve_merge check and audit row. */
async function applyMode(ctx: CommandContext, loaded: Loaded, choice: ModeChoice): Promise<void> {
  const now = await currentMode(loaded);
  if (now === null) {
    console.log(`   mode not set; later: npm run factory -- settings set mode ${choice.mode}`);
    return;
  }
  const settings = (await loadCommands()).get("settings")!;
  for (const key of ["mode", "auto_merge_max_tier"] as const) {
    if (now[key] === choice[key]) {
      console.log(`   ${key}: ${choice[key]} (unchanged)`);
      continue;
    }
    if ((await settings.run(["set", key, String(choice[key])], { ...ctx, name: "settings" })) !== 0) {
      console.log(`   ${key} not set; later: npm run factory -- settings set ${key} ${choice[key]}`);
    }
  }
}

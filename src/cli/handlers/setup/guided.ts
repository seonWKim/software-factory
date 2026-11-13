// The guided `factory setup` (owner decision 2026-11-08; one step frame and a progress record since issue #501).
// Every step runs through `runStep` (src/setup.ts): a title, one line on why, its questions with their defaults
// (Enter takes one; `--yes` takes every default without reading the terminal), then a ✓ or ✗ line. The shared
// choices (the sync plugins) go to factory.config.json after a diff and a question; the mode and the auto-merge
// tier are runtime settings, set through `factory settings`. After each finished step its name goes to the
// progress record, so the next run offers to continue from the step that did not finish.

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { syncCalendars } from "../../../calendar/index.js";
import { type Loaded, Plugins, buildStatsStore, settingsBase } from "../../../compose.js";
import { cliUserConfig } from "../../../core/config.js";
import { type CliIdentity, cliIdentity } from "../../../core/local-cli.js";
import { AUTO_MERGE_TIER_MAX, MODES, type Mode, resolveSettings } from "../../../core/settings.js";
import { ProfileStore, checkDisplayName } from "../../../identity/index.js";
import { storeSql } from "../../../impl/store/sql/store-sql.js";
import {
  CONNECT_COMMANDS,
  type ConnectContext,
  MAX_TOKEN_DAYS,
  type SetupIo,
  type SetupState,
  type SetupStep,
  type StepResult,
  calendarFeed,
  canaryStep,
  checksStep,
  connectHooks,
  neededSecrets,
  openBrowser,
  pluginSetupStep,
  removeSecret,
  runStep,
  secretFileStep,
  secretsToPrompt,
  setSecret,
} from "../../../setup.js";
import { type CommandContext, loadCommands } from "../../index.js";
import { cliEnvironment, gitUserName } from "../../support.js";
import { type Ask, defaultsAsk, readHidden, terminalAsk } from "./ask.js";
import { applyChoices, configDiffLines, currentChoices, editConfigText, parseSlackChannels } from "./config-edit.js";
import { clearProgress, readProgress, writeProgress } from "./progress.js";

export interface GuidedOptions {
  rotate: SetupState["rotate"];
  /** Take every default without asking. */
  yes: boolean;
}

/** The shared state plus the command context, for reloading the config and running `factory settings`. */
export interface GuidedState extends SetupState {
  ctx: CommandContext;
}

export async function guidedSetup(ctx: CommandContext, o: GuidedOptions): Promise<number> {
  if (!o.yes && !process.stdin.isTTY) {
    console.error("setup is interactive: run it in a terminal, or pass --yes to take every default");
    return 1;
  }
  const io = terminalIo(o.yes);
  const loaded = await ctx.load();
  const s: GuidedState = { loaded, github: loaded.config.local_only !== true, rotate: o.rotate, ctx };
  return runSetup(SETUP_STEPS, s, io);
}

/** The terminal, or under `--yes` every default: then nothing reads the terminal, not even for a secret. */
export function terminalIo(yes: boolean): SetupIo {
  return {
    ask: yes ? defaultsAsk() : terminalAsk(),
    secret: yes
      ? async () => {
          throw new Error("--yes never reads the terminal");
        }
      : readHidden,
    print: (line) => console.log(line),
  };
}

/**
 * Runs `steps` in order through the one step frame. A progress record from an earlier run that stopped offers
 * "Continue from step N?" (or start over). After each ✓ step the record gets its name; a step that says `stop`
 * ends the run there. When every step finished with ✓ the record is deleted. The exit code: 0 only then.
 */
export async function runSetup<S extends SetupState>(steps: readonly SetupStep<S>[], s: S, io: SetupIo): Promise<number> {
  let progress = (await readProgress(s.loaded.stateDir)) ?? { done: [] };
  const next = steps.findIndex((st) => !progress.done.includes(st.name));
  let from = 0;
  if (next > 0) {
    io.print(`The last setup run stopped before step ${next + 1} (${steps[next]!.title}).`);
    if ((await io.ask.choose(`Continue from step ${next + 1}?`, ["yes", "start over"] as const, "yes")) === "yes") {
      from = next;
      if (progress.github !== undefined) s.github = progress.github;
    }
  }
  if (from === 0) {
    progress = { done: [] };
    await clearProgress(s.loaded.stateDir);
  }
  const failed: number[] = [];
  for (let i = from; i < steps.length; i++) {
    const step = steps[i]!;
    const r = await runStep(i + 1, step, s, io);
    if (r.ok) {
      progress = { done: [...progress.done.filter((d) => d !== step.name), step.name], github: s.github };
      await writeProgress(s.loaded.stateDir, progress);
    } else failed.push(i + 1);
    if (r.stop) return 1;
  }
  if (failed.length > 0) {
    io.print(`\nSetup ended with ✗ at step ${failed.join(", ")}. Fix them, then run \`npm run setup\` again: it continues from step ${failed[0]}.`);
    return 1;
  }
  await clearProgress(s.loaded.stateDir);
  io.print(`\nReady. Start the factory with \`npm run factory -- dev\`, then label an issue "${s.loaded.config.intake_label}".`);
  return 0;
}

/** factory.config.json as text and parsed. */
async function readConfig(loaded: Loaded) {
  const text = await readFile(loaded.configFile, "utf8");
  return { text, raw: JSON.parse(text) as Record<string, never> };
}

/** Shows the change as a diff and writes it after a yes; a no keeps the file as it is and says `declined`. */
async function writeChoices(
  s: GuidedState,
  io: SetupIo,
  config: Awaited<ReturnType<typeof readConfig>>,
  changes: ReturnType<typeof applyChoices>,
  what: string,
  declined = "the steps below use your answers and the file as it is",
): Promise<StepResult> {
  const file = s.loaded.configFile;
  if (changes.size === 0) return { ok: true, line: `${what} (${file}: no change)` };
  io.print(`   Changes to ${file}:`);
  for (const line of configDiffLines(config.raw, changes)) io.print(`     ${line}`);
  if (!(await io.ask.yesNo("   Write them?", true))) {
    return { ok: true, line: `${what}; ${file} not written, ${declined}` };
  }
  const reloaded = await writeConfig(s.ctx, file, config.text, editConfigText(config.text, changes));
  if (typeof reloaded === "string") return { ok: false, stop: true, line: `refused by the config check, the file is unchanged: ${reloaded}` };
  s.loaded = reloaded;
  return { ok: true, line: `${what} (written to ${file})` };
}

const currentOf = (s: SetupState, raw: Record<string, never>) => currentChoices(raw, s.loaded.config.local_only !== true);

const pluginsStep: SetupStep<GuidedState> = {
  name: "plugins",
  title: "Plugins",
  why: "Local intake, specs, branches, review and merge always work. GitHub and Slack are optional sync plugins.",
  async run(s, io) {
    const config = await readConfig(s.loaded);
    const current = currentOf(s, config.raw);
    const github = await io.ask.yesNo("   Sync with GitHub (issues, labels, pushes and PRs)?", current.github);
    const slack = await io.ask.yesNo("   Take work from Slack threads?", current.slack);
    let channels = current.slack_channels;
    if (slack && (io.ask.interactive || channels.length === 0)) {
      const answer = await io.ask.text("   Slack channel IDs (C…, comma separated; SET_UP.md, Slack)", channels.join(", "), (a) => {
        const p = parseSlackChannels(a);
        return !p.ok ? `not a channel ID: ${p.bad}` : p.channels.length === 0 ? "at least one channel ID" : null;
      });
      const parsed = parseSlackChannels(answer);
      channels = parsed.ok ? parsed.channels : [];
    }
    const slackOn = slack && channels.length > 0;
    if (slack && !slackOn) io.print("   Slack stays off: no channel ID given");
    // The answer counts even when the diff is declined: GitHub off means no GitHub secret is asked or checked.
    s.github = github;
    const changes = applyChoices(config.raw, { github, slack: slackOn, slack_channels: channels });
    return writeChoices(s, io, config, changes, `GitHub ${github ? "on" : "off"}, Slack ${slackOn ? "on" : "off"}`);
  },
};

/** What to do for a secret before its hidden prompt; a secret with no entry gets its purpose. */
function secretGuide(d: Awaited<ReturnType<typeof secretsToPrompt>>[number], repo: { owner: string; name: string }): string[] {
  if (d.name === "CLAUDE_CODE_OAUTH_TOKEN") {
    return [
      "   In a separate, plain terminal run:  claude setup-token",
      "   Sign in with your Claude subscription in the browser, then copy the token it prints (shown once).",
    ];
  }
  if (d.name === "GITHUB_TOKEN") {
    return [
      `   Open ${GITHUB_TOKEN_URL} and create a fine-grained token with:`,
      `     Expiration:          your choice locally; ≤ ${MAX_TOKEN_DAYS} days if the factory is shared`,
      `     Repository access:   Only select repositories → ${repo.owner}/${repo.name}`,
      "     Contents:            Read and write",
      "     Issues:              Read and write",
      "     Pull requests:       Read and write",
      "     Metadata:            Read-only (added automatically)",
      "     Everything else:     No access",
    ];
  }
  return [`   ${d.name}: ${d.purpose}`];
}

const GITHUB_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/**
 * Every secret the selected plugins declare (less GitHub's with GitHub off) that is missing or rotated, asked in
 * this run with hidden input. Under `--yes` nothing is read: the missing ones are the ✗ line.
 */
export const secretsStep: SetupStep<SetupState> = {
  name: "secrets",
  title: "Secrets",
  why: "The credentials the selected plugins declare; each missing one is asked with hidden input and written only to the secret file.",
  async run({ loaded, github, rotate }, io) {
    const declared = neededSecrets(loaded, github);
    io.print(`   Needed: ${declared.map((d) => d.name).join(", ") || "none"}`);
    let missing = await secretsToPrompt(declared, await new Plugins(loaded).secrets(), rotate);
    if (missing.length === 0) {
      if (!(await io.ask.yesNo("   Every needed secret is set. Replace one?", false))) return { ok: true, line: "every needed secret is set" };
      const options = declared.map((d) => d.name);
      if (options.length === 0) return { ok: true, line: "nothing to replace" };
      const name = await io.ask.choose("   Which one", options, options[0]!);
      missing = declared.filter((d) => d.name === name).slice(0, 1);
    } else if (!(await io.ask.yesNo(`   Paste ${missing.map((d) => d.name).join(", ")} now (hidden input)?`, io.ask.interactive))) {
      // The default is no under `--yes`: nothing is read from the terminal there.
      const how = io.ask.interactive ? "" : " under --yes";
      return { ok: false, line: `missing, not asked${how}: ${missing.map((d) => d.name).join(", ")} (run npm run setup in a terminal to paste them)` };
    }
    const names = missing.map((d) => d.name).join(", ");
    const left: string[] = [];
    for (const d of missing) {
      for (const line of secretGuide(d, loaded.config.repo)) io.print(line);
      if (d.name === "GITHUB_TOKEN") await openBrowser(GITHUB_TOKEN_URL);
      try {
        await setSecret(loaded.secretsFile, d.name, await io.secret(`   Paste ${d.name} (hidden): `));
        io.print(`   saved ${d.name}`);
      } catch (err) {
        io.print(`   ${err instanceof Error ? err.message : String(err)}`);
        left.push(d.name);
      }
    }
    return left.length === 0
      ? { ok: true, line: `saved ${names}` }
      : { ok: false, line: `still missing: ${left.join(", ")} (run npm run setup again to paste them)` };
  },
};

const databaseStep: SetupStep<GuidedState> = {
  name: "database",
  title: "Database",
  why: "Where the factory keeps its work: a SQLite file on this machine, no server.",
  async run(s, io) {
    if (!(await io.ask.yesNo(`   Create or update the SQLite store under ${join(s.loaded.stateDir, "db")}?`, true))) {
      return { ok: false, stop: true, line: "no store: the factory needs one (run npm run setup again)" };
    }
    const store = await openStore(s.loaded, io.print);
    if (!store) return { ok: false, stop: true, line: "the store is not ready: fix the line above, then run npm run setup again" };
    await store.close();
    return { ok: true, line: "SQLite store ready" };
  },
};

/** Registers the person (`registerYou`): the ID, a display name, the owner claim. */
export interface YouDeps {
  store: { claimOwner(user_id: CliIdentity["user"]): Promise<string> };
  profiles: Pick<ProfileStore, "get" | "set">;
  identity: CliIdentity;
  /** git user.name: the default name, never an ID. */
  gitName: string | null;
  ask: Pick<Ask, "text">;
  /** ISO time of the write. */
  now: string;
}

/**
 * "You" (owner decision 2026-11-08): the person's ID stays the CLI identity; setup asks for a display name, prefilled
 * from git user.name, and Identity stores it once against that ID. The first person becomes the owner, as on a first
 * writing command (design 08-permissions, One owner). `ok` false when nothing could be stored (the anonymous identity).
 */
export async function registerYou(d: YouDeps): Promise<{ ok: boolean; lines: string[] }> {
  const user = d.identity.user;
  if (d.identity.from === "anonymous") {
    return {
      ok: false,
      lines: [
        `   you are ${user}: nothing in this environment names you, so nothing is stored.`,
        "   Set git user.email (or cli_user in factory.config.json), then run `npm run setup` again.",
      ],
    };
  }
  const existing = await d.profiles.get(user);
  const answer = await d.ask.text("   Your display name (shown next to your ID in the CLI and UI)", existing?.display_name ?? d.gitName ?? "", (a) => {
    const c = checkDisplayName(a);
    return c.ok ? null : c.reason;
  });
  const checked = checkDisplayName(answer);
  const lines: string[] = [];
  if (checked.ok) {
    await d.profiles.set(user, checked.name, "self", d.now);
    lines.push(`   you are ${user} (from ${d.identity.from}), shown as "${checked.name}"`);
  } else {
    lines.push(`   you are ${user} (from ${d.identity.from}); no display name stored (${checked.reason}; git user.name is not set either)`);
  }
  const owner = await d.store.claimOwner(user);
  lines.push(owner === user ? "   you are the owner: you may approve and merge" : `   the owner is ${owner}: only the owner may send commands`);
  return { ok: true, lines };
}

export const youStep: SetupStep<SetupState> = {
  name: "you",
  title: "You",
  why: "Your display name, stored once against your ID; the first person to register becomes the owner.",
  async run({ loaded }, io) {
    const store = await openStore(loaded, io.print);
    if (!store) return { ok: false, line: "skipped: the store is not ready (run npm run migrate if the line above says so, then npm run setup)" };
    try {
      const r = await registerYou({
        store,
        profiles: new ProfileStore(storeSql(store)),
        identity: cliIdentity(cliUserConfig(loaded.file), await cliEnvironment(loaded.root)),
        gitName: await gitUserName(loaded.root),
        ask: io.ask,
        now: (await new Plugins(loaded).clock()).now().toISOString(),
      });
      for (const line of r.lines.slice(1)) io.print(line);
      return { ok: r.ok, line: r.lines[0]!.trim() };
    } finally {
      await store.close();
    }
  },
};

interface ModeChoice {
  mode: Mode;
  auto_merge_max_tier: number;
}

const BUILT_IN_MODE: ModeChoice = { mode: "manual", auto_merge_max_tier: 0 };

const modeStep: SetupStep<GuidedState> = {
  name: "mode",
  title: "Mode",
  why: "manual: a person approves every spec and merges every change. auto: the factory approves and merges below tier 4, off the gate list.",
  async run(s, io) {
    const now = (await currentMode(s.loaded, io.print)) ?? BUILT_IN_MODE;
    const mode = await io.ask.choose("   Mode", MODES, now.mode);
    const tiers = Array.from({ length: AUTO_MERGE_TIER_MAX + 1 }, (_, i) => String(i));
    const tier = Number(await io.ask.choose("   auto_merge_max_tier: the highest tier auto mode merges by itself (0: none)", tiers, String(now.auto_merge_max_tier)));
    return applyMode(s.ctx, s.loaded, { mode, auto_merge_max_tier: tier }, io.print);
  },
};

/** Every step of `npm run setup`, in order. A step's number is its place here, so it is the same on every run. */
export const SETUP_STEPS: readonly SetupStep<GuidedState>[] = [
  pluginsStep,
  secretFileStep,
  secretsStep,
  databaseStep,
  youStep,
  modeStep,
  pluginSetupStep,
  checksStep,
  canaryStep,
];

/** Writes the new text atomically and loads it; on a config the loader refuses, puts the old text back and returns why. */
async function writeConfig(ctx: CommandContext, file: string, before: string, after: string): Promise<Loaded | string> {
  const save = async (t: string) => {
    const tmp = `${file}.tmp-${process.pid}`;
    await writeFile(tmp, t);
    await rename(tmp, file);
  };
  await save(after);
  try {
    return await ctx.load();
  } catch (err) {
    await save(before);
    return err instanceof Error ? err.message : String(err);
  }
}

/** The store, opened and migrated; null (with the reason printed) when it is not ready yet. */
async function openStore(loaded: Loaded, print: (line: string) => void) {
  await mkdir(join(loaded.stateDir, "db"), { recursive: true, mode: 0o700 });
  let store: Awaited<ReturnType<typeof buildStatsStore>> | null = null;
  try {
    store = await buildStatsStore(loaded);
    await store.migrate();
    return store;
  } catch (err) {
    await store?.close();
    print(`   the store is not ready: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`);
    return null;
  }
}

/** The global mode and auto-merge tier in effect (stored override, else the built-in default); null when the store is not ready. */
async function currentMode(loaded: Loaded, print: (line: string) => void): Promise<ModeChoice | null> {
  const store = await openStore(loaded, print);
  if (!store) return null;
  try {
    const g = resolveSettings(settingsBase(loaded), await store.listSettingOverrides()).global;
    return { mode: g.mode.value, auto_merge_max_tier: g.auto_merge_max_tier.value };
  } finally {
    await store.close();
  }
}

/** Sets each key that differs through `factory settings set`: the same approve_merge check and audit row. */
async function applyMode(ctx: CommandContext, loaded: Loaded, choice: ModeChoice, print: (line: string) => void): Promise<StepResult> {
  const now = await currentMode(loaded, print);
  if (now === null) return { ok: false, line: `mode not set; later: npm run factory -- settings set mode ${choice.mode}` };
  const settings = (await loadCommands()).get("settings")!;
  const later: string[] = [];
  for (const key of ["mode", "auto_merge_max_tier"] as const) {
    if (now[key] === choice[key]) continue;
    if ((await settings.run(["set", key, String(choice[key])], { ...ctx, name: "settings" })) !== 0) {
      later.push(`npm run factory -- settings set ${key} ${choice[key]}`);
    }
  }
  return later.length === 0
    ? { ok: true, line: `mode ${choice.mode}, auto_merge_max_tier ${choice.auto_merge_max_tier}` }
    : { ok: false, line: `not set; later: ${later.join("; ")}` };
}

export { CONNECT_COMMANDS };

type Clock = ConnectContext["clock"];

/** `factory setup <kind> <command>`, or with `disconnect` its `--disconnect` form. */
export interface ConnectRequest {
  kind: string;
  command: string;
  disconnect: boolean;
}

/** The terminal, the browser and the Clock; tests fake all three. */
export interface ConnectDeps {
  io: SetupIo;
  openBrowser(url: string): Promise<void>;
  /** Absent: the configured Clock. */
  clock?: Clock;
}

/**
 * Connects (or disconnects) the plugin whose connect hook answers `setup <kind> <command>`. A missing secret file
 * stops it before anything runs. The hook asks, signs in and stores its secrets; then the plugin is listed in (or,
 * on disconnect, dropped from) its kind's top-level list key after a diff and a yes, through the loader check. On
 * connect, one sync of that plugin follows when the key lists it, printing how many events it read. Exit 0 or 1.
 */
export async function connectSetup(ctx: CommandContext, r: ConnectRequest, deps?: ConnectDeps): Promise<number> {
  if (!deps && !process.stdin.isTTY) {
    console.error(`setup ${r.kind} ${r.command} is interactive: run it in a terminal`);
    return 1;
  }
  const { io, clock: given } = deps ?? { io: terminalIo(false) };
  const loaded = await ctx.load();
  const found = connectHooks(loaded.registry).find((h) => h.kind === r.kind && h.hook.command === r.command);
  if (!found) {
    io.print(`setup: no plugin connects through "setup ${r.kind} ${r.command}"`);
    return 1;
  }
  const { kind, name, hook } = found;
  const file = loaded.secretsFile;
  if (!(await stat(file).then(() => true, () => false))) {
    io.print(`No secret file at ${file}: run npm run setup first (it creates it), then this command again. Nothing was written.`);
    return 1;
  }
  // The secrets read as if the plugin were selected: it may not be listed yet.
  const asSelected = new Plugins({ ...loaded, plugins: { ...loaded.plugins, calendars: [...new Set([...(loaded.plugins.calendars ?? []), name])] } });
  const clock = given ?? (await asSelected.clock());
  const hc: ConnectContext = {
    secretsFile: file,
    secrets: await asSelected.secrets(),
    ask: { yesNo: (q, d) => io.ask.yesNo(q, d), hidden: (p) => io.secret(p) },
    print: io.print,
    openBrowser: deps?.openBrowser ?? openBrowser,
    async storeSecrets(values) {
      // Checked first, so the values are written together or not at all.
      const bad = [...values].find(([, v]) => !v || /\s/.test(v));
      if (bad) throw new Error(`${bad[0]}: empty or contains whitespace; nothing written`);
      for (const [n, v] of values) await setSecret(file, n, v);
    },
    async removeSecrets(names) {
      for (const n of names) await removeSecret(file, n);
    },
    clock,
  };
  try {
    await (r.disconnect ? hook.disconnect(hc) : hook.connect(hc));
  } catch (err) {
    io.print(`   ✗ ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const s: GuidedState = { loaded, github: loaded.config.local_only !== true, rotate: [], ctx };
  const config = await readConfig(loaded);
  const key = loaded.registry[kind].configKey;
  const now: unknown = config.raw[key];
  const listed = Array.isArray(now) ? now.filter((n): n is string => typeof n === "string") : [];
  const next = r.disconnect ? listed.filter((n) => n !== name) : listed.includes(name) ? listed : [...listed, name];
  const changes: ReturnType<typeof applyChoices> = new Map();
  if (now === undefined ? !r.disconnect : JSON.stringify(next) !== JSON.stringify(now)) changes.set(key, next);
  const what = `${r.disconnect ? "drop" : "list"} ${name} ${r.disconnect ? "from" : "in"} "${key}"`;
  const written = await writeChoices(s, io, config, changes, what, r.disconnect ? "it stays listed" : "it is not turned on and not synced");
  io.print(`   ${written.ok ? "✓" : "✗"} ${written.line}`);
  if (!written.ok) return 1;
  if (r.disconnect || !(s.loaded.plugins.calendars ?? []).includes(name)) return 0;
  return syncOnce(s.loaded, name, clock, io.print);
}

/** One sync of the calendar plugin `name` against the store: prints the events it read, or its error (exit 1). */
async function syncOnce(loaded: Loaded, name: string, clock: Clock, print: (line: string) => void): Promise<number> {
  const store = await openStore(loaded, print);
  if (!store) return 1;
  try {
    const feed = { name, source: await calendarFeed(loaded, name, clock) };
    const out = (await syncCalendars(storeSql(store), [feed], clock.now().getTime())).find((o) => o.source === name);
    if (!out) print(`   ✓ ${name} synced in the last 5 minutes already; it syncs again when due`);
    else if (out.ok) print(`   ✓ synced ${name}: read ${out.events} events`);
    else print(`   ✗ sync of ${name} failed: ${out.error}`);
    return out && !out.ok ? 1 : 0;
  } catch (err) {
    print(`   ✗ sync of ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await store.close();
  }
}

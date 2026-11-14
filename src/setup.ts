// `factory setup` and `factory doctor`. Operator-side commands: they run in the operator's process, and this file
// holds the only code that writes the secret file (the dashboard's calendar connect runs connectCalendar here too). No secret value is ever printed or passed as an argument.

import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type SyncOutcome, syncCalendars } from "./calendar/index.js";
import { type Loaded, Plugins, settingsBase } from "./compose.js";
import { runCanary } from "./canary.js";
import { type LoadedConfig, readOnlyOverlaps } from "./core/config.js";
import { describeSettings, resolveSettings, settingsFor } from "./core/settings.js";
import { llmCheckFromPlugins } from "./llm-check.js";
import { GitHubError } from "./impl/github/github-client.js";
import { prFlagLabels, statusLabels } from "./impl/github/github-issue-source.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import type { FactoryStore } from "./interfaces/factory-store.js";
import type { GitHubApi } from "./interfaces/github-credentials.js";
import { storeSql } from "./impl/store/sql/store-sql.js";
import type { SecretName, SecretStore } from "./interfaces/secret-store.js";
import type { ConnectContext } from "./plugin-api.js";
import { REGISTRY, type SecretDeclaration, connectHooks, createPlugin, declaredSecrets, selectedSetups } from "./plugins.js";
import type { Ask } from "./cli/handlers/setup/ask.js";

export const MAX_TOKEN_DAYS = 30;

/**
 * The secrets setup asks for and doctor checks: what the selected plugins declare, less the `github_auth` plugin's
 * when GitHub is off: no GitHub plugin selected (`local_only`), or setup's GitHub answer `no` in `github` (a declined
 * config diff leaves the file selecting it). Its credentials are built only for a GitHub plugin, so with GitHub off
 * GITHUB_TOKEN or GITHUB_APP_ID is never read, though `github_auth` stays selected for turning it back on.
 */
export function neededSecrets(
  loaded: Pick<Loaded, "registry" | "plugins" | "config">,
  github = loaded.config.local_only !== true,
): SecretDeclaration[] {
  const declared = declaredSecrets(loaded.registry, loaded.plugins);
  if (github) return declared;
  const unread = new Set((loaded.registry.github_auth.secrets[loaded.plugins.github_auth] ?? []).map((d) => d.name));
  return declared.filter((d) => !unread.has(d.name));
}

// doctor

/**
 * `warn`: reported, but does not fail doctor. Used for hardening that local use may skip. `token_days`: the
 * GitHub token expiry check only, the whole days left. `fix`: how to fix a FAIL whose `msg` reports outside text
 * as it came (an error, a version), so the text itself stays as reported; other FAIL lines say it in `msg`.
 */
export type Check = { ok: boolean; msg: string; warn?: boolean; token_days?: number; fix?: string };

/** A check's result in one word: what doctor prints and the status page shows. */
export type CheckStatus = "ok" | "warn" | "fail";

export function checkStatus(c: Check): CheckStatus {
  return c.ok ? "ok" : c.warn ? "warn" : "fail";
}

const STATUS_WORD: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };
const STATUS_MARK: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗" };

const withFix = (c: Check) => (c.fix && !c.ok ? `${c.msg} (fix: ${c.fix})` : c.msg);

/** doctor's line for one check. */
export function checkLine(c: Check): string {
  return `${STATUS_WORD[checkStatus(c)]}  ${withFix(c)}`;
}

/** setup's line for one check, marked like its step results: ✓ ok, ! warn, ✗ FAIL. */
export function markedLine(c: Check): string {
  return `${STATUS_MARK[checkStatus(c)]} ${withFix(c)}`;
}

/** Doctor's exit code: 1 only when a check is FAIL (not warn). */
export function checksExitCode(checks: readonly Check[]): number {
  return checks.every((c) => checkStatus(c) !== "fail") ? 0 : 1;
}

/**
 * The health checks, the one implementation behind both `doctor` and the status page's Health panel.
 * Read-only: writes nothing to the store, makes no model call, and never puts a secret value in a message
 * itself. Messages may carry error text from GitHub, so a surface that shows them to anyone but the operator's terminal must
 * egress-scan them first (the status page does).
 */
export async function doctorChecks(loaded: Loaded, opts: { github?: boolean } = {}): Promise<Check[]> {
  // Setup passes the person's GitHub answer, which a declined config diff leaves unwritten.
  const github = opts.github ?? loaded.config.local_only !== true;
  const checks: Check[] = [configFileCheck(loaded), ...settingsChecks(loaded), ...(await toolchainChecks(loaded.config))];
  const add = (ok: boolean, msg: string, warn = false) => checks.push({ ok, msg, warn });

  try {
    const s = await stat(loaded.secretsFile);
    const mode = (s.mode & 0o777).toString(8);
    const open = (s.mode & 0o077) !== 0;
    add(!open, `secret file at ${loaded.secretsFile} is private (mode ${mode}${open ? `; run: chmod 600 ${loaded.secretsFile}` : ""})`);
  } catch {
    add(false, `secret file exists at ${loaded.secretsFile} (run: npm run setup)`);
    return checks;
  }
  const inside = loaded.secretsFile.startsWith(loaded.root);
  add(!inside, `secret file is outside the repository${inside ? " (move it out and set SOFTWARE_FACTORY_SECRETS_FILE to its path)" : ""}`);

  const plugins = new Plugins(loaded);
  const secrets = await plugins.secrets();
  // One check per secret the selected plugins declare (or per group of alternatives).
  checks.push(...(await secretChecks(neededSecrets(loaded, github), secrets)));
  checks.push(anthropicKeyCheck(process.env.ANTHROPIC_API_KEY));

  const claude = await runProcess(["claude", "--version"], { cwd: loaded.root, env: baseEnv() }).catch(() => null);
  checks.push({ ok: claude?.exit_code === 0, msg: `claude CLI: ${claude?.stdout.trim() || "not found"}`, fix: "install Claude Code and put `claude` on PATH" });

  // No GitHub plugin selected (design 05-sources, Local startup): nothing on GitHub to check, no credential read.
  if (!github) return checks;
  // A missing GITHUB_TOKEN or GITHUB_APP_ID is already a FAIL above when the selected plugin declares it.
  const { credentials } = await plugins.githubAccess({ secrets, clock: await plugins.clock() });
  try {
    if (!(await credentials.token())) return checks;
  } catch (err) {
    const msg = `GitHub credentials: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`;
    checks.push({ ok: false, msg, fix: "check GITHUB_APP_ID and github-app.pem, or run: npm run setup -- --rotate-github" });
    return checks;
  }

  const client = await plugins.githubApi();
  const repo = { owner: loaded.config.repo.owner, name: loaded.config.repo.name };
  try {
    const r = await client.request<{ permissions?: { push?: boolean } }>("GET", `/repos/${repo.owner}/${repo.name}`);
    const grant = credentials.grant?.() ?? null;
    if (grant) {
      // A GitHub App token: GitHub's repo `permissions` field says nothing about it; the mint response does.
      const p = grant.permissions;
      const missing = ["contents", "issues", "pull_requests"].filter((k) => p[k] !== "write");
      const why = missing.length > 0 ? ` (missing: ${missing.join(", ")}; set them in the App's settings and accept on the installation)` : "";
      add(missing.length === 0, `GitHub App can write contents, issues and pull requests on ${repo.owner}/${repo.name}${why}`);
    } else {
      const push = r.permissions?.push === true;
      add(push, `GitHub token can push to ${repo.owner}/${repo.name}${push ? "" : " (give the token Contents: Read and write on it)"}`);
    }
    checks.push(await tokenExpiryCheck(client, repo, new Date(), grant));
  } catch (err) {
    const msg = `GitHub API: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`;
    checks.push({ ok: false, msg, fix: "check the network and that the credential can read the repository" });
    return checks;
  }
  try {
    await client.request("GET", `/repos/${repo.owner}/${repo.name}/labels/${loaded.config.intake_label}`);
    add(true, `label "${loaded.config.intake_label}" exists`);
  } catch (err) {
    if (!(err instanceof GitHubError && err.status === 404)) throw err;
    add(false, `label "${loaded.config.intake_label}" exists (run: npm run setup)`);
  }
  checks.push(...(await statusLabelChecks(client, repo, loaded.config.status_label_prefix)));
  return checks;
}

/**
 * ANTHROPIC_API_KEY in this shell. Unset is the good state: an API key in the shell would override the subscription
 * token the agents use. Takes the variable's value only to test it; the message never carries it.
 */
export function anthropicKeyCheck(value: string | undefined): Check {
  return value
    ? { ok: false, msg: "ANTHROPIC_API_KEY is set in this shell: run `unset ANTHROPIC_API_KEY` (agents must use CLAUDE_CODE_OAUTH_TOKEN)" }
    : { ok: true, msg: "ANTHROPIC_API_KEY not set (good: agents use CLAUDE_CODE_OAUTH_TOKEN)" };
}

/**
 * The declared read-only folders (design 05-sandbox.md): one line per toolchain cache (issue #334), then one per
 * read-only input. A folder that overlaps a denied path (the secret file's folder is one) is a FAIL, one per
 * overlap; one that does not exist yet is a warn (for a cache, the warm step may create it); otherwise ok. No
 * `toolchain` block and no `read_only_inputs`: no line.
 */
export async function toolchainChecks(config: Pick<LoadedConfig, "toolchain" | "read_only_inputs" | "deny_paths">): Promise<Check[]> {
  const folders = [
    ...(config.toolchain?.caches ?? []).map((path) => ({ path, label: "toolchain cache", missing: " (the warm step may create it)" })),
    ...(config.read_only_inputs ?? []).map((path) => ({ path, label: "read-only input", missing: "" })),
  ];
  const checks: Check[] = [];
  for (const { path, label, missing } of folders) {
    const overlaps = readOnlyOverlaps([path], config.deny_paths);
    if (overlaps.length > 0) {
      checks.push(...overlaps.map((o) => ({ ok: false, msg: `${label} ${path} overlaps the denied path ${o.denied}` })));
      continue;
    }
    const exists = await stat(path).then((st) => st.isDirectory(), () => false);
    checks.push(exists
      ? { ok: true, msg: `${label} ${path} exists (read-only for agents)` }
      : { ok: false, warn: true, msg: `${label} ${path} does not exist${missing}` });
  }
  return checks;
}

/** At or under this many days left a token is a FAIL; under TOKEN_WARN_DAYS a warn (design §9 Health). */
export const TOKEN_FAIL_DAYS = 0;
export const TOKEN_WARN_DAYS = 3;

/**
 * The GitHub token's expiry line. An App sign-in (`grant` present) is always ok and makes no read: the factory mints
 * a fresh token on each use, so the hour-long mint expiry says nothing. Otherwise the expiry header of one
 * repository GET: whole days left, rounded down: 0 or less is a FAIL, 1 or 2 a warn, 3 or more ok. `token_days`
 * carries the number, so the dashboard's Needs you can read the last run's value without asking GitHub again.
 */
export async function tokenExpiryCheck(
  client: Pick<GitHubApi, "tokenExpiration">,
  repo: { owner: string; name: string },
  now: Date,
  grant: object | null = null,
): Promise<Check> {
  if (grant) return { ok: true, msg: "GitHub App token minted (renewed automatically)" };
  const exp = await client.tokenExpiration(repo);
  // Local use may keep a non-expiring token; a shared or cloud deployment should not.
  if (exp === null) return { ok: false, msg: `GitHub token never expires (fine locally; use ≤ ${MAX_TOKEN_DAYS} days when shared)`, warn: true };
  if (Number.isNaN(exp.getTime())) return { ok: false, msg: "GitHub token expiry is readable" };
  const days = Math.floor((exp.getTime() - now.getTime()) / 86_400_000);
  if (days <= TOKEN_FAIL_DAYS) return { ok: false, msg: `GitHub token expires in ${days} days (run: npm run setup -- --rotate-github)`, token_days: days };
  if (days < TOKEN_WARN_DAYS) return { ok: false, msg: `GitHub token expires in ${days} days (run: npm run setup -- --rotate-github)`, warn: true, token_days: days };
  return { ok: true, msg: `GitHub token expires in ${days} days (recommended ≤ ${MAX_TOKEN_DAYS} when shared)`, token_days: days };
}

/** The one line that names the config file in use: `--config` / FACTORY_CONFIG, or the checked-in file. */
export function configFileCheck(loaded: Pick<Loaded, "configFile" | "externalConfig">): Check {
  const how = loaded.externalConfig === null ? "checked-in" : "--config / FACTORY_CONFIG";
  return { ok: true, msg: `config file: ${loaded.configFile} (${how})` };
}

/**
 * One ok line per project and per-project setting: its effective value and the layer it came from
 * (design 2026-11-01). Informational: the config already loaded, so every value passed its checks. The
 * status page's Health panel shows the same lines, since it runs doctorChecks.
 */
export function settingsChecks(loaded: Pick<Loaded, "config">): Check[] {
  const { owner, name } = loaded.config.repo;
  const projects = [...new Set([`${owner}/${name}`, ...Object.keys(loaded.config.settings.projects)])];
  return projects.flatMap((p) =>
    describeSettings(settingsFor(p, loaded.config.settings)).map((line) => ({ ok: true, msg: `setting for ${p}: ${line}` })),
  );
}

/**
 * One check per declared secret: present is ok, missing is a FAIL with a hint to run setup. Declarations
 * sharing a `oneOf` label make one check that passes when any of them is present. Never prints a value.
 */
export async function secretChecks(declared: readonly SecretDeclaration[], secrets: SecretStore): Promise<Check[]> {
  const order: string[] = [];
  const singles = new Map<string, SecretDeclaration>();
  const groups = new Map<string, { names: SecretName[]; found: SecretName | null }>();
  const present = new Set<SecretName>();
  for (const d of declared) {
    if ((await secrets.get(d.name)) !== null) present.add(d.name);
    if (d.oneOf === undefined) {
      if (!singles.has(d.name)) order.push(d.name);
      singles.set(d.name, d);
      continue;
    }
    let g = groups.get(d.oneOf);
    if (!g) {
      g = { names: [], found: null };
      groups.set(d.oneOf, g);
      order.push(`oneOf:${d.oneOf}`);
    }
    g.names.push(d.name);
    if (!g.found && present.has(d.name)) g.found = d.name;
  }
  return order.map((key): Check => {
    if (key.startsWith("oneOf:")) {
      const label = key.slice("oneOf:".length);
      const g = groups.get(label)!;
      return g.found
        ? { ok: true, msg: `${label} present (${g.found})` }
        : { ok: false, msg: `${label} missing: one of ${g.names.join(", ")} (run: npm run setup)` };
    }
    const d = singles.get(key)!;
    return present.has(d.name)
      ? { ok: true, msg: `${d.name} present` }
      : { ok: false, msg: `${d.name} missing: ${d.purpose} (run: npm run setup)` };
  });
}

/**
 * The declared secrets setup's Secrets step asks for: each one missing from the file or named in `rotate`. A `oneOf`
 * group is asked once, for its first member (CLAUDE_CODE_OAUTH_TOKEN for the model credential), and only when no
 * member is set or one is rotated.
 */
export async function secretsToPrompt(
  declared: readonly SecretDeclaration[],
  secrets: SecretStore,
  rotate: readonly SecretName[],
): Promise<SecretDeclaration[]> {
  const out: SecretDeclaration[] = [];
  const groups = new Set<string>();
  for (const d of declared) {
    if (d.oneOf === undefined) {
      if (rotate.includes(d.name) || (await secrets.get(d.name)) === null) out.push(d);
      continue;
    }
    if (groups.has(d.oneOf)) continue;
    groups.add(d.oneOf);
    const members = declared.filter((m) => m.oneOf === d.oneOf);
    const rotated = members.find((m) => rotate.includes(m.name));
    if (rotated) out.push(rotated);
    else if (await isMissing(members, secrets)) out.push(d);
  }
  return out;
}

async function isMissing(members: readonly SecretDeclaration[], secrets: SecretStore): Promise<boolean> {
  for (const m of members) if ((await secrets.get(m.name)) !== null) return false;
  return true;
}

/**
 * One check per status label and PR flag label. A missing one is a warning, never a FAIL: the factory creates it on first
 * use, so it only means setup has not run since status labels were added.
 */
export async function statusLabelChecks(client: Pick<GitHubApi, "request">, repo: { owner: string; name: string }, prefix: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const l of [...statusLabels(prefix), ...prFlagLabels(prefix)]) {
    try {
      await client.request("GET", `/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(l.name)}`);
      checks.push({ ok: true, msg: `status label "${l.name}" exists` });
    } catch (err) {
      const why = err instanceof GitHubError && err.status === 404
        ? "run: npm run setup"
        : `could not check: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`;
      checks.push({ ok: false, msg: `status label "${l.name}" exists (${why})`, warn: true });
    }
  }
  return checks;
}

/** `llm`: one extra line that runs the LLM check (two real provider calls). Plain doctor calls no model. */
export async function doctor(loaded: Loaded, opts: { llm?: boolean } = {}): Promise<number> {
  const checks = await doctorChecks(loaded);
  if (opts.llm) {
    const r = await llmCheckFromPlugins(new Plugins(loaded), "cheap");
    checks.push({ ok: r.ok, msg: r.summary });
  }
  for (const c of checks) console.log(checkLine(c));
  return checksExitCode(checks);
}

// setup

/** How a setup step talks to the person: questions with a default, hidden input for a secret, and output. */
export interface SetupIo {
  ask: Ask;
  /** Hidden input. Never called under `--yes` (`ask.interactive` false): a missing secret is reported instead. */
  secret(prompt: string): Promise<string>;
  print(line: string): void;
}

/** A step's outcome: its ✓ or ✗ line. `stop`: setup cannot go on (the next run continues from this step). */
export interface StepResult {
  ok: boolean;
  line: string;
  stop?: boolean;
}

/**
 * One `factory setup` step (owner decision 2026-11-08, one frame since issue #501). `name` goes to the progress
 * record; `why` is one line. `run` asks at least one question with its default, then acts.
 */
export interface SetupStep<S> {
  readonly name: string;
  readonly title: string;
  readonly why: string;
  run(s: S, io: SetupIo): Promise<StepResult>;
}

/**
 * The one step frame: `n. title`, the why line, the step's questions (each with its default), then a ✓ or ✗ line.
 * A step that succeeds without asking anything is a bug in the step, so it throws.
 */
export async function runStep<S>(n: number, step: SetupStep<S>, s: S, io: SetupIo): Promise<StepResult> {
  io.print(`\n${n}. ${step.title}`);
  io.print(`   ${step.why}`);
  let asked = 0;
  const ask: Ask = {
    interactive: io.ask.interactive,
    choose: (q, options, dflt) => (asked++, io.ask.choose(q, options, dflt)),
    yesNo: (q, dflt) => (asked++, io.ask.yesNo(q, dflt)),
    text: (q, dflt, check) => (asked++, io.ask.text(q, dflt, check)),
  };
  const r = await step.run(s, { ...io, ask });
  if (r.ok && asked === 0) throw new Error(`setup step "${step.name}" asked no question`);
  io.print(`   ${r.ok ? "✓" : "✗"} ${r.line}`);
  return r;
}

/** What every setup step reads. `github`: the person's GitHub answer, else the config's choice. */
export interface SetupState {
  loaded: Loaded;
  github: boolean;
  rotate: readonly SecretName[];
}

export const secretFileStep: SetupStep<SetupState> = {
  name: "secret-file",
  title: "Secret file",
  why: "Holds every credential, outside the repository, readable only by you (folder 700, file 600).",
  async run({ loaded, github }, io) {
    const file = loaded.secretsFile;
    if (!(await io.ask.yesNo(`   Create or update ${file}?`, true))) {
      return { ok: false, stop: true, line: "secret file not written: setup needs it (run npm run setup again)" };
    }
    await ensureSecretFile(file, join(loaded.root, ".env.example"), neededSecrets(loaded, github).map((d) => d.name), io.print);
    return { ok: true, line: `${file} is ready (folder 700, file 600, outside the repository)` };
  },
};

export const pluginSetupStep: SetupStep<SetupState> = {
  name: "plugin-setup",
  title: "Setup of the selected plugins",
  why: "Each selected plugin's own setup: github-issues creates the intake and status labels on the repository.",
  async run({ loaded, github }, io) {
    if (!(await io.ask.yesNo("   Run it now?", true))) return { ok: false, line: "not run (run npm run setup again)" };
    const hooks = github ? selectedSetups(loaded.registry, loaded.plugins) : [];
    if (hooks.length === 0) return { ok: true, line: "nothing to set up for the selected plugins" };
    const plugins = new Plugins(loaded);
    // Hooks call the forge: with no forge credentials set they cannot run.
    if (!(await (await plugins.githubAccess()).credentials.token())) {
      return { ok: false, line: "skipped: no GitHub credentials (paste them in the Secrets step)" };
    }
    const ctx = { ...plugins.base, github: await plugins.githubApi(), print: io.print };
    for (const h of hooks) {
      io.print(`   ${h.kind} ${h.name}:`);
      await h.setup(ctx);
    }
    return { ok: true, line: `ran ${hooks.map((h) => h.name).join(", ")}` };
  },
};

export const checksStep: SetupStep<SetupState> = {
  name: "checks",
  title: "Checks",
  why: "The checks of `factory doctor`: each line says what it checks, and each ✗ how to fix it.",
  async run({ loaded, github }, io) {
    if (!(await io.ask.yesNo("   Run them now?", true))) {
      return { ok: false, stop: true, line: "not run: setup ends here (run npm run setup again to continue)" };
    }
    const checks = await doctorChecks(loaded, { github });
    for (const c of checks) io.print(`   ${markedLine(c)}`);
    const failed = checks.filter((c) => checkStatus(c) === "fail").length;
    if (failed === 0) return { ok: true, line: "every check passed" };
    return { ok: false, stop: true, line: `${failed} check(s) failed: fix the ✗ lines, then run npm run setup again (it continues from here)` };
  },
};

export const canaryStep: SetupStep<SetupState> = {
  name: "canary",
  title: "Canary (G6)",
  why: "A real agent tries to find a planted fake secret; it must fail. Takes a few minutes and uses your plan.",
  async run({ loaded }, io) {
    if (!(await io.ask.yesNo("   Run it now?", true))) return { ok: true, line: "not run" };
    const report = await runCanary(loaded);
    io.print(JSON.stringify(report, null, 2).replace(/^/gm, "   "));
    return report.passed
      ? { ok: true, line: "the agent did not find the planted secret" }
      : { ok: false, stop: true, line: "Canary FAILED: do not run the factory. Revoke the GitHub token and report the output above." };
  },
};

/**
 * Creates the secret file from the template, then appends, empty, any template key and any `declared`
 * secret name (the selected plugins') the file lacks.
 */
export async function ensureSecretFile(
  file: string,
  template: string,
  declared: readonly SecretName[] = [],
  print: (line: string) => void = console.log,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const text = await readFile(template, "utf8");
  try {
    await stat(file);
  } catch {
    await writeFile(file, text, { mode: 0o600 });
  }
  await chmod(file, 0o600);
  const added = await addMissingKeys(file, [...new Set([...keysOf(text), ...declared])]);
  if (added.length > 0) print(`   added empty ${added.join(", ")} (fill in as needed)`);
}

/** The keys a secret file or its template sets (`KEY=` or `export KEY=`), in order. */
export function keysOf(text: string): string[] {
  return [...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/gm)].map((m) => m[1]!);
}

/** Appends `KEY=` for each key the file lacks. Existing lines and values are untouched; nothing is printed. */
export async function addMissingKeys(file: string, keys: readonly string[]): Promise<string[]> {
  const current = await readFile(file, "utf8");
  const have = new Set(keysOf(current));
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length === 0) return [];
  const tmp = `${file}.tmp-${process.pid}`;
  const sep = current.endsWith("\n") || current === "" ? "" : "\n";
  await writeFile(tmp, `${current}${sep}${missing.map((k) => `${k}=`).join("\n")}\n`, { mode: 0o600 });
  await rename(tmp, file);
  return missing;
}

/** Replaces or appends `name=value`, keeping every other line. Atomic rename, mode 600. */
export async function setSecret(file: string, name: SecretName, value: string): Promise<void> {
  if (!value || /\s/.test(value)) throw new Error(`${name}: empty or contains whitespace; nothing written`);
  const lines = (await readFile(file, "utf8")).split("\n");
  const i = lines.findIndex((l) => l.replace(/^export\s+/, "").startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else lines.push(`${name}=${value}`);
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, lines.join("\n"), { mode: 0o600 });
  await rename(tmp, file);
}

// connect (`factory setup <kind> <command>`, src/cli/handlers/setup/guided.ts, and the dashboard's Calendar section)

export type { ConnectContext };
export { connectHooks };

/** Every connect command of the built-in registry, for the usage text: `setup <kind> <command>`. */
export const CONNECT_COMMANDS = connectHooks(REGISTRY).map((h) => ({ kind: h.kind, name: h.name, command: h.hook.command, configKey: REGISTRY[h.kind].configKey }));

/** One connect or disconnect of calendar plugin `name`: `factory setup calendar <command>`, or the dashboard's Calendar section. */
export interface CalendarConnectRun {
  loaded: Loaded;
  store: FactoryStore; // where the live `calendar` setting and the one sync write
  actor: string; // who connects, as an ID: the setting's audit row
  clock: ConnectContext["clock"];
  name: string;
  disconnect: boolean;
  io: Pick<ConnectContext, "ask" | "print" | "openBrowser">; // the terminal, or the dashboard's request
  beforeWrite?: () => void; // called before each secret write; a throw stops it (the dashboard's check that every asked value was given)
}

/**
 * The one connect and disconnect flow (design 08-settings, 2026-11-13): the CLI and the dashboard both run it, so they
 * cannot disagree. A missing secret file stops it before anything runs. The plugin's connect hook asks, signs in and
 * stores its secrets through this file's writer (mode 600); then the plugin is listed in (or dropped from) the live
 * `calendar` setting, other names kept; a connect then runs one sync of it, whose outcome is `sync` (null on disconnect,
 * or when it synced in the last 5 minutes already). A refusal throws before any write.
 */
export async function connectCalendar(r: CalendarConnectRun): Promise<{ was: readonly string[]; listed: readonly string[]; sync: SyncOutcome | null }> {
  const found = connectHooks(r.loaded.registry).find((h) => h.kind === "calendar" && h.name === r.name);
  if (!found) throw new Error(`no calendar plugin "${r.name}" has a connect hook`);
  const file = r.loaded.secretsFile;
  if (!(await stat(file).then(() => true, () => false))) {
    throw new Error(`No secret file at ${file}: run npm run setup first (it creates it), then connect again. Nothing was written.`);
  }
  // The secrets read as if the plugin were selected: it may not be listed yet. Each build reads the file afresh.
  const selected = new Plugins({ ...r.loaded, plugins: { ...r.loaded.plugins, calendars: [r.name] } });
  const ctx: ConnectContext = {
    ...r.io,
    secretsFile: file,
    secrets: await selected.secrets(),
    async storeSecrets(values) {
      r.beforeWrite?.();
      // Checked first, so the values are written together or not at all.
      const bad = [...values].find(([, v]) => !v || /\s/.test(v));
      if (bad) throw new Error(`${bad[0]}: empty or contains whitespace; nothing written`);
      for (const [n, v] of values) await setSecret(file, n, v);
    },
    async removeSecrets(names) {
      r.beforeWrite?.();
      for (const n of names) await removeSecret(file, n);
    },
    clock: r.clock,
  };
  await (r.disconnect ? found.hook.disconnect(ctx) : found.hook.connect(ctx));
  const was = resolveSettings(settingsBase(r.loaded), await r.store.listSettingOverrides()).values.calendar;
  const listed = r.disconnect ? was.filter((n) => n !== r.name) : was.includes(r.name) ? was : [...was, r.name];
  if (listed.length !== was.length) await r.store.setSettingOverride({ key: "calendar", project: "", value: JSON.stringify(listed), actor: r.actor });
  if (r.disconnect) return { was, listed, sync: null };
  try {
    const source = await createPlugin(r.loaded.registry, "calendar", r.name, { ...selected.base, secrets: await selected.secrets(), clock: r.clock });
    return { was, listed, sync: (await syncCalendars(storeSql(r.store), [{ name: r.name, source }], r.clock.now().getTime())).find((o) => o.source === r.name) ?? null };
  } catch (err) {
    return { was, listed, sync: { source: r.name, ok: false, error: err instanceof Error ? err.message : String(err) } };
  }
}

/** Drops every `name=` line, keeping every other line. A name not in the file writes nothing. Atomic rename, mode 600. */
export async function removeSecret(file: string, name: SecretName): Promise<void> {
  const lines = (await readFile(file, "utf8")).split("\n");
  const kept = lines.filter((l) => !l.replace(/^export\s+/, "").startsWith(`${name}=`));
  if (kept.length === lines.length) return;
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, kept.join("\n"), { mode: 0o600 });
  await rename(tmp, file);
}

export async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  await runProcess([cmd, url], { cwd: process.cwd(), env: baseEnv() }).catch(() => undefined);
}

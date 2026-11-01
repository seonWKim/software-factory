// `factory setup` and `factory doctor`. Operator-side commands: they run in the operator's process and are
// the only code that writes the secret file. No secret value is ever printed or passed as an argument.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Loaded, Plugins } from "./compose.js";
import { runCanary } from "./canary.js";
import { llmCheckFromPlugins } from "./llm-check.js";
import { GitHubClient, GitHubError, type RepoRef } from "./impl/github/github-client.js";
import { ensureLabel, statusLabels } from "./impl/source/github-issue-source.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import type { SchemaVersion } from "./interfaces/factory-store.js";
import { type SecretName, type SecretStore, secretName } from "./interfaces/secret-store.js";
import { type SecretDeclaration, declaredSecrets } from "./plugins.js";

const MAX_TOKEN_DAYS = 30;
const LABEL = { color: "5319e7", description: "Work item for the software factory" };

const CLAUDE_CODE_OAUTH_TOKEN = secretName("CLAUDE_CODE_OAUTH_TOKEN");
const ANTHROPIC_API_KEY = secretName("ANTHROPIC_API_KEY");
const GITHUB_TOKEN = secretName("GITHUB_TOKEN");
const MYSQL_PASSWORD = secretName("MYSQL_PASSWORD");

/** Secrets setup has its own guided step for. Any other declared secret gets the generic prompt. */
const GUIDED: ReadonlySet<SecretName> = new Set([CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN, MYSQL_PASSWORD]);

// doctor

/** `warn`: reported, but does not fail doctor. Used for hardening that local use may skip. */
export type Check = { ok: boolean; msg: string; warn?: boolean };

/** A check's result in one word: what doctor prints and the status page shows. */
export type CheckStatus = "ok" | "warn" | "fail";

export function checkStatus(c: Check): CheckStatus {
  return c.ok ? "ok" : c.warn ? "warn" : "fail";
}

const STATUS_WORD: Record<CheckStatus, string> = { ok: "ok  ", warn: "warn", fail: "FAIL" };

/** doctor's line for one check. */
export function checkLine(c: Check): string {
  return `${STATUS_WORD[checkStatus(c)]}  ${c.msg}`;
}

/** Doctor's exit code: 1 only when a check is FAIL (not warn). */
export function checksExitCode(checks: readonly Check[]): number {
  return checks.every((c) => checkStatus(c) !== "fail") ? 0 : 1;
}

/**
 * The health checks, the one implementation behind both `doctor` and the status page's Health panel.
 * Read-only: writes nothing to the store (the MySQL check reads the schema version, it never migrates),
 * makes no model call, and never puts a secret value in a message itself. Messages may carry error text
 * from MySQL or GitHub, so a surface that shows them to anyone but the operator's terminal must
 * egress-scan them first (the status page does).
 */
export async function doctorChecks(loaded: Loaded): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (ok: boolean, msg: string, warn = false) => checks.push({ ok, msg, warn });

  try {
    const s = await stat(loaded.secretsFile);
    add((s.mode & 0o077) === 0, `secret file at ${loaded.secretsFile} is private (mode ${(s.mode & 0o777).toString(8)})`);
  } catch {
    add(false, `secret file exists at ${loaded.secretsFile}`);
    return checks;
  }
  add(!loaded.secretsFile.startsWith(loaded.root), "secret file is outside the repository");

  const plugins = new Plugins(loaded);
  const secrets = await plugins.secrets();
  // One check per secret the selected plugins declare (or per group of alternatives).
  checks.push(...(await secretChecks(declaredSecrets(loaded.registry, loaded.plugins), secrets)));
  add(!process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is not set in this shell");

  const claude = await runProcess(["claude", "--version"], { cwd: loaded.root, env: baseEnv() }).catch(() => null);
  add(claude?.exit_code === 0, `claude CLI: ${claude?.stdout.trim() || "not found"}`);

  const db = loaded.store;
  // A missing MYSQL_PASSWORD is already a FAIL above.
  if (db.type === "mysql" && (await secrets.get(MYSQL_PASSWORD))) {
    const where = `MySQL ${db.user}@${db.host}:${db.port}/${db.database}`;
    try {
      const store = await plugins.store(secrets, await plugins.clock());
      let v: SchemaVersion;
      try {
        v = await store.schemaVersion();
      } finally {
        await store.close();
      }
      if (v.applied === v.latest) add(true, `${where} reachable, schema up to date`);
      // Not a FAIL: the factory migrates the schema when it starts (build()).
      else if (v.applied < v.latest) add(false, `${where} reachable, schema at version ${v.applied} of ${v.latest} (the factory migrates it when it starts)`, true);
      else add(false, `${where} reachable, schema version ${v.applied} is newer than this code knows (${v.latest}): update the factory`, true);
    } catch (err) {
      add(false, `${where}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    }
  }

  // A missing GITHUB_TOKEN or GITHUB_APP_ID is already a FAIL above when the selected plugin declares it.
  const credentials = await plugins.githubCredentials(secrets, await plugins.clock());
  try {
    if (!(await credentials.token())) return checks;
  } catch (err) {
    add(false, `GitHub credentials: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    return checks;
  }

  const client = new GitHubClient(credentials);
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
      add(r.permissions?.push === true, `GitHub token can push to ${repo.owner}/${repo.name}`);
    }
    const exp = grant ? grant.expires_at : await client.tokenExpiration(repo);
    // Local use may keep a non-expiring token; a shared or cloud deployment should not.
    if (exp === null) add(false, `GitHub token never expires (fine locally; use ≤ ${MAX_TOKEN_DAYS} days when shared)`, true);
    else if (Number.isNaN(exp.getTime())) add(false, "GitHub token expiry is readable");
    else {
      const days = Math.round((exp.getTime() - Date.now()) / 86_400_000);
      add(days <= MAX_TOKEN_DAYS, `GitHub token expires in ${days} days (recommended ≤ ${MAX_TOKEN_DAYS} when shared)`, true);
    }
  } catch (err) {
    add(false, `GitHub API: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
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
 * The declared secrets setup's generic step prompts for: those without a guided step of their own that are
 * missing from the file, or named in `rotate`.
 */
export async function secretsToPrompt(
  declared: readonly SecretDeclaration[],
  secrets: SecretStore,
  rotate: readonly SecretName[],
): Promise<SecretDeclaration[]> {
  const out: SecretDeclaration[] = [];
  for (const d of declared) {
    if (GUIDED.has(d.name)) continue;
    if (rotate.includes(d.name) || (await secrets.get(d.name)) === null) out.push(d);
  }
  return out;
}

/**
 * One check per status label. A missing one is a warning, never a FAIL: the factory creates it on first
 * use, so it only means setup has not run since status labels were added.
 */
export async function statusLabelChecks(client: GitHubClient, repo: RepoRef, prefix: string): Promise<Check[]> {
  const checks: Check[] = [];
  for (const l of statusLabels(prefix)) {
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

/** Creates each label, printing created / already exists / could not create per label. */
export async function createLabels(
  client: GitHubClient,
  repo: RepoRef,
  labels: readonly { name: string; color: string; description: string }[],
): Promise<void> {
  for (const l of labels) {
    try {
      const r = await ensureLabel(client, repo, l);
      console.log(`   "${l.name}": ${r === "created" ? "created" : "already exists"}`);
    } catch (err) {
      console.log(`   "${l.name}": could not create it: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
    }
  }
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

export async function setup(loaded: Loaded, opts: { rotate: SecretName[] }): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("setup is interactive: run it in a terminal");
    return 1;
  }
  const file = loaded.secretsFile;
  const repo = loaded.config.repo;
  const declared = declaredSecrets(loaded.registry, loaded.plugins);
  const isDeclared = (name: SecretName) => declared.some((d) => d.name === name);
  step(1, "Secret file");
  await ensureSecretFile(file, join(loaded.root, ".env.example"), declared.map((d) => d.name));
  console.log(`   ${file} (dir 700, file 600, outside the repository)`);
  console.log("   Secrets the selected plugins declare:");
  for (const d of declared) console.log(`     ${d.name}${d.oneOf ? ` (${d.oneOf}, one of)` : ""}: ${d.purpose}`);

  step(2, "Model credential");
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("   ! ANTHROPIC_API_KEY is set in this shell. It overrides the subscription token: unset it.");
  }
  // A fresh SecretStore after each write, so it sees the values just saved.
  const plugins = new Plugins(loaded);
  let secrets = await plugins.secrets();
  const hasModel = (await secrets.get(CLAUDE_CODE_OAUTH_TOKEN)) ?? (await secrets.get(ANTHROPIC_API_KEY));
  if (!isDeclared(CLAUDE_CODE_OAUTH_TOKEN)) {
    console.log("   not needed by the selected plugins");
  } else if (hasModel && !opts.rotate.includes(CLAUDE_CODE_OAUTH_TOKEN)) {
    console.log(`   already set (${hasModel.name})`);
  } else {
    console.log(
      [
        "   In a separate, plain terminal run:  claude setup-token",
        "   Sign in with your Claude subscription in the browser, then copy the token it prints (shown once).",
      ].join("\n"),
    );
    await setSecret(file, CLAUDE_CODE_OAUTH_TOKEN, await askSecret("   Paste the token (hidden): "));
  }

  step(3, "GitHub token");
  secrets = await plugins.secrets();
  if (!isDeclared(GITHUB_TOKEN)) {
    console.log("   not needed by the selected plugins");
  } else if ((await secrets.get(GITHUB_TOKEN)) && !opts.rotate.includes(GITHUB_TOKEN)) {
    console.log("   already set");
  } else {
    const url = "https://github.com/settings/personal-access-tokens/new";
    console.log(
      [
        `   Opening ${url}`,
        "   Create a fine-grained token with:",
        `     Expiration:          your choice locally; ≤ ${MAX_TOKEN_DAYS} days if the factory is shared`,
        `     Repository access:   Only select repositories → ${repo.owner}/${repo.name}`,
        "     Contents:            Read and write",
        "     Issues:              Read and write",
        "     Pull requests:       Read and write",
        "     Metadata:            Read-only (added automatically)",
        "     Everything else:     No access",
      ].join("\n"),
    );
    await openBrowser(url);
    await setSecret(file, GITHUB_TOKEN, await askSecret("   Paste the token (hidden): "));
  }

  step(4, "Database");
  if (!(await provisionDatabase(loaded, opts.rotate.includes(MYSQL_PASSWORD)))) return 1;

  step(5, "Other secrets of the selected plugins");
  const other = await secretsToPrompt(declared, await plugins.secrets(), opts.rotate);
  if (other.length === 0) console.log("   nothing to do");
  for (const d of other) {
    console.log(`   ${d.name}: ${d.purpose}`);
    await setSecret(file, d.name, await askSecret(`   Paste ${d.name} (hidden): `));
  }

  step(6, `Labels on ${repo.owner}/${repo.name}: intake "${loaded.config.intake_label}" and the status labels`);
  secrets = await plugins.secrets();
  const credentials = await plugins.githubCredentials(secrets, await plugins.clock());
  if (!(await credentials.token())) {
    console.log("   skipped: no GitHub credentials");
  } else {
    const client = new GitHubClient(credentials);
    await createLabels(client, repo, [
      { name: loaded.config.intake_label, ...LABEL },
      ...statusLabels(loaded.config.status_label_prefix),
    ]);
  }

  step(7, "Checks");
  const code = await doctor(loaded);
  if (code !== 0) {
    console.log("\nFix the FAIL lines, then run `npm run setup` again (it skips what is already done).");
    return code;
  }

  step(8, "Canary (G6)");
  console.log("   A real agent tries to find a planted fake secret. It must fail. Takes a few minutes, uses your plan.");
  if (await confirm("   Run it now? [Y/n] ")) {
    const report = await runCanary(loaded);
    console.log(JSON.stringify(report, null, 2).replace(/^/gm, "   "));
    if (!report.passed) {
      console.log("\n   Canary FAILED: do not run the factory. Revoke the GitHub token and report the output above.");
      return 1;
    }
  }

  console.log(`\nReady. Start the factory with \`npm run factory -- dev\`, then label an issue "${loaded.config.intake_label}".`);
  return 0;
}

/**
 * MySQL only: creates the database and the factory's own user with a generated password, which goes
 * straight to the secret file. The admin login is the mysql client's (~/.my.cnf, else it asks for the
 * root password itself), so the factory never sees an admin credential. SQL goes over stdin, never argv.
 */
async function provisionDatabase(loaded: Loaded, rotate: boolean): Promise<boolean> {
  const db = loaded.store;
  if (db.type !== "mysql") {
    console.log("   SQLite: nothing to do");
    return true;
  }
  if ((await (await new Plugins(loaded).secrets()).get(MYSQL_PASSWORD)) && !rotate) {
    console.log("   already set");
    return true;
  }
  // Upper, lower, digit and symbol: passes MySQL's validate_password MEDIUM policy.
  const password = `Sf-${randomBytes(18).toString("hex")}-Q7`;
  const account = `'${db.user}'@'localhost'`;
  const sql = [
    `CREATE DATABASE IF NOT EXISTS \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;`,
    `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY '${password}';`,
    `ALTER USER ${account} IDENTIFIED BY '${password}';`,
    `GRANT ALL PRIVILEGES ON \`${db.database}\`.* TO ${account};`,
  ].join("\n");
  console.log(`   Creating database ${db.database} and user ${db.user}@localhost (generated password, never shown).`);
  const server = ["--host", db.host, "--port", String(db.port)];
  if (!(await mysqlClient(server, sql, true))) {
    console.log("   ~/.my.cnf did not log in as an admin. The mysql client asks for the MySQL root password:");
    if (!(await mysqlClient(["-u", "root", "-p", ...server], sql, false))) {
      console.log("   could not create it. Fix the MySQL login, then run `npm run setup` again.");
      return false;
    }
  }
  await setSecret(loaded.secretsFile, MYSQL_PASSWORD, password);
  return true;
}

/** Runs the mysql client with `sql` on stdin. A password prompt (-p) reads the terminal, not stdin. */
function mysqlClient(args: string[], sql: string, quiet: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("mysql", args, { stdio: ["pipe", "ignore", quiet ? "ignore" : "inherit"] });
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
    p.stdin.end(sql);
  });
}

function step(n: number, title: string): void {
  console.log(`\n${n}. ${title}`);
}

/**
 * Creates the secret file from the template, then appends, empty, any template key and any `declared`
 * secret name (the selected plugins') the file lacks.
 */
export async function ensureSecretFile(file: string, template: string, declared: readonly SecretName[] = []): Promise<void> {
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
  if (added.length > 0) console.log(`   added empty ${added.join(", ")} (fill in as needed)`);
}

function keysOf(text: string): string[] {
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
  console.log(`   saved ${name}`);
}

/** Reads a line without echoing it. */
function askSecret(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value.trim());
        }
        if (ch === "\u0003") process.exit(130);
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer === "y" || answer === "yes";
}

async function openBrowser(url: string): Promise<void> {
  const cmd = process.platform === "darwin" ? "open" : "xdg-open";
  await runProcess([cmd, url], { cwd: process.cwd(), env: baseEnv() }).catch(() => undefined);
}

// `factory setup` and `factory doctor`. Operator-side commands: they run in the operator's process and are
// the only code that writes the secret file. No secret value is ever printed or passed as an argument.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Loaded, openStore } from "./compose.js";
import { runCanary } from "./canary.js";
import { SystemClock } from "./impl/clock/system-clock.js";
import { GitHubClient, GitHubError } from "./impl/github/github-client.js";
import { baseEnv, runProcess } from "./impl/process/run-process.js";
import { EnvFileSecretStore } from "./impl/secrets/env-file-secret-store.js";
import type { SecretName } from "./interfaces/secret-store.js";

const MAX_TOKEN_DAYS = 30;
const LABEL = { color: "5319e7", description: "Work item for the software factory" };

// doctor

/** `warn`: reported, but does not fail doctor. Used for hardening that local use may skip. */
type Check = { ok: boolean; msg: string; warn?: boolean };

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

  const secrets = new EnvFileSecretStore(loaded.secretsFile);
  const model = (await secrets.get("CLAUDE_CODE_OAUTH_TOKEN")) ?? (await secrets.get("ANTHROPIC_API_KEY"));
  add(model !== null, `model credential present (${model?.name ?? "none"})`);
  add(!process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is not set in this shell");

  const claude = await runProcess(["claude", "--version"], { cwd: loaded.root, env: baseEnv() }).catch(() => null);
  add(claude?.exit_code === 0, `claude CLI: ${claude?.stdout.trim() || "not found"}`);

  const db = loaded.store;
  if (db.type === "mysql") {
    const where = `MySQL ${db.user}@${db.host}:${db.port}/${db.database}`;
    if (!(await secrets.get("MYSQL_PASSWORD"))) add(false, "MYSQL_PASSWORD present (run: npm run setup)");
    else {
      try {
        const store = await openStore(loaded, secrets, new SystemClock());
        try {
          await store.migrate();
        } finally {
          await store.close();
        }
        add(true, `${where} reachable, schema up to date`);
      } catch (err) {
        add(false, `${where}: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
      }
    }
  }

  const gh = await secrets.get("GITHUB_TOKEN");
  add(gh !== null, "GITHUB_TOKEN present");
  if (!gh) return checks;

  const client = new GitHubClient(secrets);
  const repo = { owner: loaded.config.repo.owner, name: loaded.config.repo.name };
  try {
    const r = await client.request<{ permissions?: { push?: boolean } }>("GET", `/repos/${repo.owner}/${repo.name}`);
    add(r.permissions?.push === true, `GitHub token can push to ${repo.owner}/${repo.name}`);
    const exp = await client.tokenExpiration(repo);
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
  return checks;
}

export async function doctor(loaded: Loaded): Promise<number> {
  const checks = await doctorChecks(loaded);
  for (const c of checks) console.log(`${c.ok ? "ok  " : c.warn ? "warn" : "FAIL"}  ${c.msg}`);
  return checks.every((c) => c.ok || c.warn) ? 0 : 1;
}

// setup

export async function setup(loaded: Loaded, opts: { rotate: SecretName[] }): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error("setup is interactive: run it in a terminal");
    return 1;
  }
  const file = loaded.secretsFile;
  const repo = loaded.config.repo;
  step(1, "Secret file");
  await ensureSecretFile(file, join(loaded.root, ".env.example"));
  console.log(`   ${file} (dir 700, file 600, outside the repository)`);

  step(2, "Model credential");
  if (process.env.ANTHROPIC_API_KEY) {
    console.log("   ! ANTHROPIC_API_KEY is set in this shell. It overrides the subscription token: unset it.");
  }
  let secrets = new EnvFileSecretStore(file);
  const hasModel = (await secrets.get("CLAUDE_CODE_OAUTH_TOKEN")) ?? (await secrets.get("ANTHROPIC_API_KEY"));
  if (hasModel && !opts.rotate.includes("CLAUDE_CODE_OAUTH_TOKEN")) {
    console.log(`   already set (${hasModel.name})`);
  } else {
    console.log(
      [
        "   In a separate, plain terminal run:  claude setup-token",
        "   Sign in with your Claude subscription in the browser, then copy the token it prints (shown once).",
      ].join("\n"),
    );
    await setSecret(file, "CLAUDE_CODE_OAUTH_TOKEN", await askSecret("   Paste the token (hidden): "));
  }

  step(3, "GitHub token");
  secrets = new EnvFileSecretStore(file);
  if ((await secrets.get("GITHUB_TOKEN")) && !opts.rotate.includes("GITHUB_TOKEN")) {
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
    await setSecret(file, "GITHUB_TOKEN", await askSecret("   Paste the token (hidden): "));
  }

  step(4, "Database");
  if (!(await provisionDatabase(loaded, opts.rotate.includes("MYSQL_PASSWORD")))) return 1;

  step(5, `Label "${loaded.config.intake_label}" on ${repo.owner}/${repo.name}`);
  secrets = new EnvFileSecretStore(file);
  const client = new GitHubClient(secrets);
  try {
    await client.request("POST", `/repos/${repo.owner}/${repo.name}/labels`, { name: loaded.config.intake_label, ...LABEL });
    console.log("   created");
  } catch (err) {
    if (err instanceof GitHubError && err.status === 422) console.log("   already exists");
    else console.log(`   could not create it: ${err instanceof Error ? err.message.slice(0, 120) : "error"}`);
  }

  step(6, "Checks");
  const code = await doctor(loaded);
  if (code !== 0) {
    console.log("\nFix the FAIL lines, then run `npm run setup` again (it skips what is already done).");
    return code;
  }

  step(7, "Canary (G6)");
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
  if ((await new EnvFileSecretStore(loaded.secretsFile).get("MYSQL_PASSWORD")) && !rotate) {
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
  await setSecret(loaded.secretsFile, "MYSQL_PASSWORD", password);
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

/** Creates the secret file from the template, then appends any template key the file lacks, empty. */
export async function ensureSecretFile(file: string, template: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await chmod(dirname(file), 0o700);
  const text = await readFile(template, "utf8");
  try {
    await stat(file);
  } catch {
    await writeFile(file, text, { mode: 0o600 });
  }
  await chmod(file, 0o600);
  const added = await addMissingKeys(file, keysOf(text));
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

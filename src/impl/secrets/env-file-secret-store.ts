import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Secret, SecretName, SecretStore } from "../../interfaces/secret-store.js";

/** `${XDG_CONFIG_HOME:-~/.config}/software-factory/.env`, or SOFTWARE_FACTORY_SECRETS_FILE. */
export function defaultSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SOFTWARE_FACTORY_SECRETS_FILE) return env.SOFTWARE_FACTORY_SECRETS_FILE;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory", ".env");
}

class OpaqueSecret implements Secret {
  readonly #value: string;
  constructor(
    readonly name: SecretName,
    value: string,
  ) {
    this.#value = value;
  }
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return `[secret ${this.name}]`;
  }
  toJSON(): string {
    return this.toString();
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return this.toString();
  }
}

/**
 * Reads the secret file once, lazily, in the worker/controller process (G1). Never logs values.
 * `names`: the secret names the selected plugins declare (src/plugins.ts). Only those keys are loaded,
 * returned by get and scanned; any other key in the file (a plain setting such as MYSQL_HOST, or a
 * secret no selected plugin declares) is ignored. No names: nothing is loaded.
 * `extraScanValues` adds values that are not secrets of ours but must never leave (the G6 canary).
 */
export class EnvFileSecretStore implements SecretStore {
  private loaded: Promise<Map<SecretName, string>> | null = null;
  private readonly names: ReadonlySet<SecretName>;

  constructor(
    private readonly path: string,
    names: Iterable<SecretName> = [],
    private readonly extraScanValues: readonly string[] = [],
  ) {
    this.names = new Set(names);
  }

  async get(name: SecretName): Promise<Secret | null> {
    const value = (await this.load()).get(name);
    return value ? new OpaqueSecret(name, value) : null;
  }

  async valuesForScan(): Promise<readonly string[]> {
    return [...(await this.load()).values(), ...this.extraScanValues];
  }

  private load(): Promise<Map<SecretName, string>> {
    this.loaded ??= readFile(this.path, "utf8").then((text) => parseEnvFile(text, this.names), (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`secret file not found at ${this.path} (see docs/setup.md)`);
      throw new Error(`cannot read secret file at ${this.path}: ${err.code ?? "unknown error"}`);
    });
    return this.loaded;
  }
}

/** The non-empty values of the declared `names` only; every other key is dropped. */
export function parseEnvFile(text: string, names: Iterable<SecretName>): Map<SecretName, string> {
  const declared = new Set<string>(names);
  const out = new Map<SecretName, string>();
  for (const [key, value] of parseEnvLines(text)) {
    if (declared.has(key)) out.set(key as SecretName, value);
  }
  return out;
}

/**
 * Non-secret settings kept in the same file (e.g. MYSQL_HOST). No plugin declares them as secrets, so
 * the EgressScanner never treats them as secret values. Missing file: no settings.
 */
export async function readEnvSettings(path: string, names: readonly string[]): Promise<Map<string, string>> {
  const text = await readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return "";
    throw new Error(`cannot read secret file at ${path}: ${err.code ?? "unknown error"}`);
  });
  return new Map([...parseEnvLines(text)].filter(([key]) => names.includes(key)));
}

/** Every non-empty `KEY=value` line, comments and blanks skipped, surrounding quotes removed. */
export function parseEnvLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) out.set(key, value);
  }
  return out;
}

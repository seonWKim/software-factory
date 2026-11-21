import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Secret, SecretName, SecretStore } from "../../interfaces/secret-store.js";

/** `${XDG_CONFIG_HOME:-~/.config}/software-factory/.env`, or SOFTWARE_FACTORY_SECRETS_FILE. */
export function defaultSecretsFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SOFTWARE_FACTORY_SECRETS_FILE) return env.SOFTWARE_FACTORY_SECRETS_FILE;
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "software-factory", ".env");
}

export class OpaqueSecret implements Secret {
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

/** The least time between two reads of the secret file after the first (design §5 Restarts, setup state). */
export const RELOAD_MS = 5_000;

/**
 * Reads the secret file lazily, in the worker/controller process (G1). Never logs values. It reads it again, at most
 * once per RELOAD_MS, when a declared name has no value or the last read failed, so a credential added while the
 * factory runs (`npm run setup`) is found with no restart (decision of 2026-11-21; it was read once per process).
 * `names`: the secret names the selected plugins declare (src/plugins.ts). Only those keys are loaded,
 * returned by get and scanned; any other key in the file (a plain setting such as MYSQL_HOST, or a
 * secret no selected plugin declares) is ignored. No names: nothing is loaded.
 * `extraScanValues` adds values that are not secrets of ours but must never leave (the G6 canary).
 */
export class EnvFileSecretStore implements SecretStore {
  private loaded: Promise<Map<SecretName, string>> | null = null;
  private loadedAt = 0;
  private failed = false;
  /** Every value any read loaded: a value scanned once stays scanned, also after it left the file. */
  private readonly seen = new Set<string>();
  private readonly names: ReadonlySet<SecretName>;

  constructor(
    private readonly path: string,
    names: Iterable<SecretName> = [],
    private readonly extraScanValues: readonly string[] = [],
    private readonly now: () => number = Date.now,
  ) {
    this.names = new Set(names);
  }

  async get(name: SecretName): Promise<Secret | null> {
    let value = (await this.load(false)).get(name);
    if (!value && this.names.has(name)) value = (await this.load(true)).get(name);
    return value ? new OpaqueSecret(name, value) : null;
  }

  async valuesForScan(): Promise<readonly string[]> {
    for (const v of (await this.load(false)).values()) this.seen.add(v);
    return [...this.seen, ...this.extraScanValues];
  }

  /** The values of the last read; a new read first, when there is none yet, or when `again` (or a failed read) and RELOAD_MS passed. */
  private load(again: boolean): Promise<Map<SecretName, string>> {
    if (this.loaded !== null && !((again || this.failed) && this.now() - this.loadedAt >= RELOAD_MS)) return this.loaded;
    this.loadedAt = this.now();
    this.failed = false;
    this.loaded = readFile(this.path, "utf8").then((text) => {
      const values = parseEnvFile(text, this.names);
      for (const v of values.values()) this.seen.add(v);
      return values;
    }, (err: NodeJS.ErrnoException) => {
      this.failed = true;
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

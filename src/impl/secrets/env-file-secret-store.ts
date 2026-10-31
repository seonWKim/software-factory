import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Secret, SecretName, SecretStore } from "../../interfaces/secret-store.js";

const NAMES: readonly SecretName[] = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"];

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
 * `extraScanValues` adds values that are not secrets of ours but must never leave (the G6 canary).
 */
export class EnvFileSecretStore implements SecretStore {
  private loaded: Promise<Map<SecretName, string>> | null = null;

  constructor(
    private readonly path: string,
    private readonly extraScanValues: readonly string[] = [],
  ) {}

  async get(name: SecretName): Promise<Secret | null> {
    const value = (await this.load()).get(name);
    return value ? new OpaqueSecret(name, value) : null;
  }

  async valuesForScan(): Promise<readonly string[]> {
    return [...(await this.load()).values(), ...this.extraScanValues];
  }

  private load(): Promise<Map<SecretName, string>> {
    this.loaded ??= readFile(this.path, "utf8").then(parseEnvFile, (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") throw new Error(`secret file not found at ${this.path} (see docs/setup.md)`);
      throw new Error(`cannot read secret file at ${this.path}: ${err.code ?? "unknown error"}`);
    });
    return this.loaded;
  }
}

export function parseEnvFile(text: string): Map<SecretName, string> {
  const out = new Map<SecretName, string>();
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
    if (value && (NAMES as readonly string[]).includes(key)) out.set(key as SecretName, value);
  }
  return out;
}

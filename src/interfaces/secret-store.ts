// G1: only the worker/controller process uses this; agent processes never get a SecretStore.
// First impl: ${XDG_CONFIG_HOME:-~/.config}/software-factory/.env (or SOFTWARE_FACTORY_SECRETS_FILE).

export type SecretName = "CLAUDE_CODE_OAUTH_TOKEN" | "ANTHROPIC_API_KEY" | "GITHUB_TOKEN" | "MYSQL_PASSWORD";

/** Opaque wrapper so a secret can't be logged or stringified by accident. */
export interface Secret {
  readonly name: SecretName;
  /** The raw value. Call only inside a tool implementation, at the point of use. */
  reveal(): string;
  /** Always returns a redacted placeholder. */
  toString(): string;
  toJSON(): string;
}

export interface SecretStore {
  get(name: SecretName): Promise<Secret | null>;
  /** All loaded values, for the EgressScanner (G5) only. */
  valuesForScan(): Promise<readonly string[]>;
}

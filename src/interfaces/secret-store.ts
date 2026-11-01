// G1: only the worker/controller process uses this; agent processes never get a SecretStore.
// First impl: ${XDG_CONFIG_HOME:-~/.config}/software-factory/.env (or SOFTWARE_FACTORY_SECRETS_FILE).
//
// Secret names are not a closed list: each plugin declares the names it reads (src/plugins.ts), and the
// selected plugins' declarations decide which names a SecretStore loads and scans (docs/design.md §8).

declare const SECRET_NAME: unique symbol;

/** A checked secret name: upper-case letters, digits and `_`, starting with a letter. Build with secretName(). */
export type SecretName = string & { readonly [SECRET_NAME]: true };

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

/** Checks `name` and brands it. Throws for lower-case letters, empty strings, spaces, hyphens or a leading digit. */
export function secretName(name: string): SecretName {
  if (!SECRET_NAME_PATTERN.test(name)) {
    throw new Error(`not a secret name: ${JSON.stringify(name)} (upper-case letters, digits and _, starting with a letter)`);
  }
  return name as SecretName;
}

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
  /** Null when the name is not declared by a selected plugin, or has no value. */
  get(name: SecretName): Promise<Secret | null>;
  /** All loaded values, for the EgressScanner (G5) only. */
  valuesForScan(): Promise<readonly string[]>;
}

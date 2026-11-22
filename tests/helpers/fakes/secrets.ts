// SecretStore fake (RFC 0023 R4): values in memory instead of a file. Passes the same contract as EnvFileSecretStore
// (tests/contracts/secret-store.contract.ts).
import type { Secret, SecretName, SecretStore } from "../../../src/interfaces/secret-store.js";

class MemorySecret implements Secret {
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
 * `values` by name, as a secret file would hold them. Like EnvFileSecretStore, only the `names` the selected plugins
 * declare are returned and scanned (default: every name in `values`), and an empty value counts as none.
 */
export class MemorySecretStore implements SecretStore {
  private readonly names: ReadonlySet<string>;
  constructor(
    private readonly values: Readonly<Record<string, string>> = {},
    names: Iterable<SecretName> = Object.keys(values) as SecretName[],
  ) {
    this.names = new Set(names);
  }
  async get(name: SecretName): Promise<Secret | null> {
    const value = this.names.has(name) ? this.values[name] : undefined;
    return value ? new MemorySecret(name, value) : null;
  }
  async valuesForScan(): Promise<readonly string[]> {
    return Object.entries(this.values).filter(([k, v]) => this.names.has(k) && v).map(([, v]) => v);
  }
}

import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { type SecretStore, secretName } from "../../src/interfaces/secret-store.js";

// RFC 0023 R2: the SecretStore contract (src/interfaces/secret-store.ts), run over every implementation by
// secret-store.contract.test.ts. Tools read credentials with get(); the EgressScanner (G5) blocks every value
// valuesForScan() returns. Secret-like values are built from parts, so no literal here looks like a credential.

/** What the store's backing (a file, a map) holds: declared names with their values, and keys no plugin declared. */
export interface SecretSource {
  /** Names the selected plugins declare, with their values ("" = declared but empty). */
  declared: Record<string, string>;
  /** Keys in the backing that no selected plugin declares. */
  undeclared: Record<string, string>;
}

/** Builds a store over `source`; may be async (a temp file is written first). */
export type MakeSecretStore = (source: SecretSource) => Promise<SecretStore>;

const value = (tag: string) => ["v", tag, "7Qx", "9Lm"].join("-");
const TOKEN = secretName("CONTRACT_TOKEN");
const OTHER = secretName("CONTRACT_OTHER");
const EMPTY = secretName("CONTRACT_EMPTY");
const HIDDEN = "CONTRACT_HIDDEN";

const SOURCE: SecretSource = {
  declared: { [TOKEN]: value("token"), [OTHER]: value("other"), [EMPTY]: "" },
  undeclared: { [HIDDEN]: value("hidden") },
};

export function secretStoreContract(make: MakeSecretStore): void {
  describe("get", () => {
    // Bug: get returns another name's value, or the wrong name, so a tool authenticates with the wrong credential.
    it("returns a declared name's value under that name", async () => {
      const store = await make(SOURCE);
      const s = await store.get(TOKEN);
      expect(s?.name).toBe(TOKEN);
      expect(s?.reveal()).toBe(value("token"));
      expect((await store.get(OTHER))?.reveal()).toBe(value("other"));
    });

    // Bug: a key no selected plugin declares is handed out (docs/design.md §8: the plugins' declarations decide).
    it("is null for a name no selected plugin declares, even when the backing holds it", async () => {
      const store = await make(SOURCE);
      expect(await store.get(secretName(HIDDEN))).toBeNull();
    });

    // Bug: an empty value counts as set, so a tool sends an empty credential instead of reporting it missing.
    it("is null for a declared name with an empty value", async () => {
      const store = await make(SOURCE);
      expect(await store.get(EMPTY)).toBeNull();
    });
  });

  describe("Secret", () => {
    // Bug: a secret logged by accident (a template string, JSON, console.log) prints its value.
    it("never shows its value when stringified, serialized or inspected", async () => {
      const store = await make(SOURCE);
      const s = (await store.get(TOKEN))!;
      for (const shown of [String(s), `${s}`, s.toString(), JSON.stringify({ s }), inspect(s), inspect({ s }, { depth: 5 })]) {
        expect(shown).not.toContain(value("token"));
      }
    });
  });

  describe("valuesForScan", () => {
    // Bug: a declared value is left out of the scan, so the EgressScanner lets it leave in a commit or comment.
    it("holds every declared non-empty value", async () => {
      const store = await make(SOURCE);
      const values = await store.valuesForScan();
      expect(values).toContain(value("token"));
      expect(values).toContain(value("other"));
    });

    // Bug: undeclared keys (plain settings such as a host name) or empty values are scanned, so ordinary text,
    // or every string (an empty pattern matches everything), is blocked.
    it("holds no undeclared value and no empty value", async () => {
      const store = await make(SOURCE);
      const values = await store.valuesForScan();
      expect(values).not.toContain(value("hidden"));
      expect(values).not.toContain("");
    });
  });
}

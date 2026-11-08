// Passport keys from a secret provider (G1): Identity never reads a secret file or the environment. The
// caller hands in what the SecretStore gives it; the key material stays inside the SigningKey closure.

import { createHmac } from "node:crypto";
import type { PassportKeyring, SigningKey } from "./token.js";

/** What Identity needs from the SecretStore (src/interfaces/secret-store.ts satisfies it). */
export interface SecretProvider {
  get(name: string): Promise<{ reveal(): string } | null>;
}

const MIN_KEY_LENGTH = 32;

/** A key's version id: derived from the key, so it names one key without revealing it. */
function signingKey(material: string): SigningKey {
  const sign = (data: string): string => createHmac("sha256", material).update(data).digest("hex");
  return { id: `k_${sign("sf-passport-key-id").slice(0, 16)}`, sign };
}

/**
 * A keyring over secrets: `current` signs new passports; `previous` are still accepted (rotation). A missing
 * current key, or one shorter than 32 characters, is an error; a missing previous key is skipped.
 */
export function secretKeyring(secrets: SecretProvider, names: { current: string; previous?: readonly string[] }): PassportKeyring {
  const load = async (name: string): Promise<SigningKey | null> => {
    const s = await secrets.get(name);
    if (!s) return null;
    const material = s.reveal();
    if (material.length < MIN_KEY_LENGTH) throw new Error(`passport key ${name} is shorter than ${MIN_KEY_LENGTH} characters`);
    return signingKey(material);
  };
  return {
    async current() {
      const k = await load(names.current);
      if (!k) throw new Error(`passport key ${names.current} is not set`);
      return k;
    },
    async get(id) {
      for (const name of [names.current, ...(names.previous ?? [])]) {
        const k = await load(name);
        if (k?.id === id) return k;
      }
      return null;
    },
  };
}

// The solo passport key (RFC 0015 §8 "Solo vs enterprise"): one random key in the state folder, made on first use
// with mode 0600 and denied to agents (compose's deny_paths). Every process on this machine (CLI, UI, controller,
// worker) signs and verifies with it. Enterprise replicas take a shared key from the SecretStore instead.

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { SecretProvider } from "../../passport/keys.js";

export const LOCAL_KEY_FILE = "passport.key";

/** A SecretProvider for `name` backed by the key file at `path`, created once (exclusive create, so two processes agree). */
export function localKeyFile(path: string, name: string): SecretProvider {
  const read = async (): Promise<string> => (await readFile(path, "utf8")).trim();
  return {
    async get(asked) {
      if (asked !== name) return null;
      let material: string;
      try {
        material = await read();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "EEXIST") throw e;
        });
        material = await read();
      }
      return { reveal: () => material };
    },
  };
}

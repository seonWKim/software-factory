// The solo passport key (RFC 0015 §8 "Solo vs enterprise"): one random key in the state folder, made on first use
// with mode 0600 and denied to agents (compose's deny_paths). Every process on this machine (CLI, UI, controller,
// worker) signs and verifies with it. Enterprise replicas take a shared key from the SecretStore instead.

import { randomBytes } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import type { SecretProvider } from "../../passport/keys.js";

export const LOCAL_KEY_FILE = "passport.key";

/** A SecretProvider for `name` backed by the key file at `path`, created once (an atomic link into place, so two processes agree). */
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
        // Written whole under a temporary name, then linked into place: a process that loses the race never reads
        // a file the winner has created but not yet written.
        const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
        await writeFile(tmp, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
        try {
          await link(tmp, path).catch((e: NodeJS.ErrnoException) => {
            if (e.code !== "EEXIST") throw e;
          });
        } finally {
          await unlink(tmp);
        }
        material = await read();
      }
      return { reveal: () => material };
    },
  };
}

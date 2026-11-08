// The file walk discovery is built on (RFC 0015 §6.1): the registry uses it for handlers and topics, the
// migration runner for migrations.

import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Every file under `root` whose name matches `pattern`, sorted by path; never a `.d.ts`. */
export function findDescriptorFiles(root: string, pattern: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && pattern.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * `load`, but a failure runs `forget` first: a discovery or build cached in a variable is cleared when it fails, so
 * the next caller tries again instead of getting the same rejection for the life of the process.
 */
export function forgetOnFailure<T>(load: Promise<T>, forget: () => void): Promise<T> {
  return load.catch((err: unknown) => {
    forget();
    throw err;
  });
}

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

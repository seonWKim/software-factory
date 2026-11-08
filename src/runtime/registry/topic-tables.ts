// The sql bus's tables for every discovered topic (RFC 0015 §6.3). `npm run migrate` creates them, so an enterprise
// database user needs no DDL rights at run time; a role creates them again at start (idempotent), so a solo
// factory needs no migrate step.

import { ensureTopicTables } from "../../bus/index.js";
import type { Dialect, SqlExecutor } from "../../state/index.js";
import { CODE_ROOT } from "../../state/index.js";
import { loadRegistry } from "./registry.js";

export async function ensureDiscoveredTopicTables(dialect: Dialect, db: SqlExecutor, root: string = CODE_ROOT): Promise<void> {
  const { topics } = await loadRegistry(root);
  await ensureTopicTables({ dialect, all: (s, p) => db.all(s, p), run: (s, p) => db.run(s, p) }, topics.map((t) => t.descriptor));
}

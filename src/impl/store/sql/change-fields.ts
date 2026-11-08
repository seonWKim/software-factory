// The change columns (SQLite migration 35, MySQL step 0035): `change_ref`, the PR number as text, the field the
// store takes; `change_url`, the PR link; and pr_number, kept in sync from change_ref. Every store write that sets
// a change takes all three from `changeFields`, so the adopted insert, a patch and an unreviewed merge insert never
// differ. Every work item read returns them.

import { prNumber } from "../../../core/change-ref.js";
import { projectLabelCursor } from "../../../core/project.js";
import type { SqlExecutor } from "../../../state/index.js";

export interface ChangeFields {
  pr_number: number | null;
  change_ref: string | null;
  /** The PR link: the given URL, else derived from a GitHub key's stored label; null otherwise. */
  change_url: string | null;
}

/** Only a GitHub project key gets a derived URL; its label (`<host>/<owner>/<name>`) is the cursor `project_label:<key>`. */
const GITHUB_KEY_PREFIX = "github:";

/**
 * The change columns for `change_ref` on `project`: pr_number from the ref, and change_url as `url` when one is
 * given (the forge's open result), else `https://<label>/pull/<n>` (the same string as prUrl in src/main.ts) when
 * the project is a GitHub key whose label is stored. All null for no ref. Reads the label cursor only when a URL
 * must be derived.
 */
export async function changeFields(
  db: SqlExecutor,
  project: string,
  change_ref: string | null,
  url: string | null = null,
): Promise<ChangeFields> {
  if (change_ref === null) return { pr_number: null, change_ref: null, change_url: null };
  const pr_number = prNumber({ change_ref });
  if (url !== null) return { pr_number, change_ref, change_url: url };
  if (pr_number === null || !project.startsWith(GITHUB_KEY_PREFIX)) return { pr_number, change_ref, change_url: null };
  const [row] = await db.all("SELECT value FROM inbound_cursors WHERE name = ?", [projectLabelCursor(project)]);
  return { pr_number, change_ref, change_url: row ? `https://${String(row.value)}/pull/${pr_number}` : null };
}

/**
 * The extra `column = ?` assignments for a patch whose diff sets change_ref: pr_number always, and change_url only
 * where the row has none yet (a change does not move once set, so a stored URL stays). None otherwise.
 */
export async function changeAssignments(
  db: SqlExecutor,
  project: string,
  changes: { change_ref?: { to: string | null } },
  url: string | null,
): Promise<{ sets: string[]; values: (string | number | null)[] }> {
  if (!changes.change_ref) return { sets: [], values: [] };
  const f = await changeFields(db, project, changes.change_ref.to, url);
  return { sets: ["pr_number = ?", "change_url = COALESCE(change_url, ?)"], values: [f.pr_number, f.change_url] };
}

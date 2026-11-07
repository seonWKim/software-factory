// The change columns written beside pr_number (SQLite migration 32, MySQL step 0032): `change_ref`, the PR number
// as text, and `change_url`, the PR link. Every store write that sets pr_number takes both from `changeFields`, so
// the adopted insert, a patch and an unreviewed merge insert never differ. Nothing outside the store reads them yet.

import { projectLabelCursor } from "../../../core/project.js";
import type { SqlExecutor } from "./driver.js";

export interface ChangeFields {
  change_ref: string | null;
  /** The PR link; null unless the project is a GitHub key with a stored label. */
  change_url: string | null;
}

/** Only a GitHub project key gets a URL; its label (`<host>/<owner>/<name>`) is the cursor `project_label:<key>`. */
const GITHUB_KEY_PREFIX = "github:";

/**
 * The change columns for `pr_number` on `project`: the number as text, and `https://<label>/pull/<n>` (the same
 * string as prUrl in src/main.ts) when the project is a GitHub key whose label is stored. Both null for no number.
 * Reads the label cursor only when a URL can follow from it.
 */
export async function changeFields(db: SqlExecutor, project: string, pr_number: number | null): Promise<ChangeFields> {
  if (pr_number === null) return { change_ref: null, change_url: null };
  const change_ref = String(pr_number);
  if (!project.startsWith(GITHUB_KEY_PREFIX)) return { change_ref, change_url: null };
  const [row] = await db.all("SELECT value FROM cursors WHERE name = ?", [projectLabelCursor(project)]);
  return { change_ref, change_url: row ? `https://${String(row.value)}/pull/${pr_number}` : null };
}

/**
 * The extra `column = ?` assignments for a patch whose diff sets pr_number: change_ref always, and change_url only
 * where the row has none yet (a PR number does not change once set, so a stored URL stays). None otherwise.
 */
export async function changeAssignments(
  db: SqlExecutor,
  project: string,
  changes: { pr_number?: { to: number | null } },
): Promise<{ sets: string[]; values: (string | null)[] }> {
  if (!changes.pr_number) return { sets: [], values: [] };
  const f = await changeFields(db, project, changes.pr_number.to);
  return { sets: ["change_ref = ?", "change_url = COALESCE(change_url, ?)"], values: [f.change_ref, f.change_url] };
}

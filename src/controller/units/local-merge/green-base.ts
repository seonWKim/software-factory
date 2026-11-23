// The last green base per project (design 03-risk, red-main revert): `controller_green_bases`, written after each
// red-main check that passes and read before a revert. One upsert per write, so a repeat or another replica leaves
// the later tip; nothing is kept in process.

import type { SqlDriver } from "../../../state/index.js";

export class GreenBaseStore {
  constructor(
    private readonly db: SqlDriver,
    private readonly now: () => string,
  ) {}

  /** The base tip `project`'s last passing red-main check ran on; null when none passed since this table exists. */
  async get(project: string): Promise<string | null> {
    const [row] = await this.db.all("SELECT base_sha FROM controller_green_bases WHERE project_key = ?", [project]);
    return row ? String(row.base_sha) : null;
  }

  async set(project: string, base_sha: string): Promise<void> {
    await this.db.run(
      `INSERT INTO controller_green_bases (project_key, base_sha, checked_at) VALUES (?, ?, ?)
       ON CONFLICT (project_key) DO UPDATE SET base_sha = excluded.base_sha, checked_at = excluded.checked_at`,
      [project, base_sha, this.now()],
    );
  }
}

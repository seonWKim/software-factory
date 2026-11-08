// Display names (identity_profiles): one row per factory user id. The only place a person's name is stored;
// every other table keeps the id, and an edge (CLI, UI) looks the name up here when it shows a person.

import type { SqlExecutor } from "../../state/index.js";
import type { Provider } from "../passport/types.js";

/**
 * Who set the name: `self` (the person, in `factory setup`) or the provider that supplied it at login (`oidc`,
 * `github`). A name the person chose is kept when a provider later supplies another.
 */
export type ProfileSource = "self" | Provider;

export interface Profile {
  readonly user_id: string;
  readonly display_name: string;
  readonly source: ProfileSource;
  readonly updated_at: string;
}

/** The longest display name stored. */
export const DISPLAY_NAME_MAX = 100;

const CONTROL = /[\u0000-\u001f\u007f]/;

/** The name trimmed, or why it is refused: empty, too long, or holding a control character. */
export function checkDisplayName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim();
  if (name === "") return { ok: false, reason: "a display name cannot be empty" };
  if (name.length > DISPLAY_NAME_MAX) return { ok: false, reason: `a display name is at most ${DISPLAY_NAME_MAX} characters` };
  if (CONTROL.test(name)) return { ok: false, reason: "a display name cannot hold control characters" };
  return { ok: true, name };
}

export class ProfileStore {
  constructor(private readonly db: SqlExecutor) {}

  async get(user_id: string): Promise<Profile | null> {
    const [r] = await this.db.all("SELECT user_id, display_name, source, updated_at FROM identity_profiles WHERE user_id = ?", [user_id]);
    if (!r) return null;
    return { user_id: String(r.user_id), display_name: String(r.display_name), source: String(r.source) as ProfileSource, updated_at: String(r.updated_at) };
  }

  /** The names of `user_ids` that have one; ids without a profile are left out. */
  async displayNames(user_ids: readonly string[]): Promise<Map<string, string>> {
    const ids = [...new Set(user_ids)];
    if (ids.length === 0) return new Map();
    const rows = await this.db.all(`SELECT user_id, display_name FROM identity_profiles WHERE user_id IN (${ids.map(() => "?").join(", ")})`, ids);
    return new Map(rows.map((r) => [String(r.user_id), String(r.display_name)]));
  }

  /**
   * Stores `display_name` for `user_id` (added or replaced). A provider's name never replaces one the person set
   * (`self`): false then; true when the row now holds the name. Safe to run twice and from several processes.
   */
  async set(user_id: string, display_name: string, source: ProfileSource, at: string): Promise<boolean> {
    const checked = checkDisplayName(display_name);
    if (!checked.ok) throw new Error(checked.reason);
    const keepSelf = source === "self" ? "" : " AND source <> 'self'";
    const update = () =>
      this.db.run(`UPDATE identity_profiles SET display_name = ?, source = ?, updated_at = ? WHERE user_id = ?${keepSelf}`, [checked.name, source, at, user_id]);
    if ((await update()) > 0) return true;
    if (await this.get(user_id)) return false;
    try {
      await this.db.run("INSERT INTO identity_profiles (user_id, display_name, source, updated_at) VALUES (?, ?, ?, ?)", [user_id, checked.name, source, at]);
      return true;
    } catch (err) {
      // Another process inserted the row first: apply the same rule to it.
      if (!(await this.get(user_id))) throw err;
      return (await update()) > 0;
    }
  }
}

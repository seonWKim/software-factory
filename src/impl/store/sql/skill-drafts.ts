// Skill drafts: the SkillDraftStore methods over `controller_skill_drafts` and `controller_skill_draft_days`, as
// SqlSkillDraftStore, which SqlFactoryStore extends (through SqlAttachmentStore), so these methods add no line to
// sql-factory-store.ts's budget. Times and the UTC day come from the store's injected Clock. A duplicate id is
// "already there": the stored row is returned.

import type { Timestamp } from "../../../core/types.js";
import { SKILL_DRAFT_STATES, type SkillDraft, type SkillDraftState, type SkillDraftStore } from "../../../interfaces/skill-draft-store.js";
import type { Row, SqlDriver } from "../../../state/index.js";
import { SqlSkillEvalStore } from "./skill-evals.js";

const COLUMNS = "id, project_key, skill_ref, state, tokens, detail, created_at, updated_at";

const rowToDraft = (r: Row): SkillDraft => ({
  id: String(r.id), project_key: String(r.project_key), skill_ref: String(r.skill_ref), state: String(r.state) as SkillDraftState,
  tokens: Number(r.tokens), detail: JSON.parse(String(r.detail)), created_at: String(r.created_at) as Timestamp, updated_at: String(r.updated_at) as Timestamp,
});

function knownState(state: string): void {
  if (!(SKILL_DRAFT_STATES as readonly string[]).includes(state)) throw new Error(`skill draft state ${JSON.stringify(state)} is not one of ${SKILL_DRAFT_STATES.join(", ")}`);
}

/** SkillDraftStore over a SqlDriver; `draftStamp` is the store's injected Clock's time (an ISO UTC timestamp). */
export class SqlSkillDraftStore extends SqlSkillEvalStore implements SkillDraftStore {
  constructor(db: SqlDriver, private readonly draftStamp: () => Timestamp) {
    super(db, draftStamp);
  }

  async addSkillDraft(d: Omit<SkillDraft, "created_at" | "updated_at">): Promise<SkillDraft> {
    knownState(d.state);
    const now = this.draftStamp();
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_drafts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [d.id, d.project_key, d.skill_ref, d.state, d.tokens, JSON.stringify(d.detail), now, now]);
      const [row] = await tx.all(`SELECT ${COLUMNS} FROM controller_skill_drafts WHERE id = ?`, [d.id]);
      return rowToDraft(row!);
    });
  }

  async getSkillDraft(id: string): Promise<SkillDraft | null> {
    const [row] = await this.db.all(`SELECT ${COLUMNS} FROM controller_skill_drafts WHERE id = ?`, [id]);
    return row ? rowToDraft(row) : null;
  }

  async listSkillDrafts(project_key: string): Promise<SkillDraft[]> {
    return (await this.db.all(`SELECT ${COLUMNS} FROM controller_skill_drafts WHERE project_key = ? ORDER BY created_at, id`, [project_key])).map(rowToDraft);
  }

  async setSkillDraftState(id: string, from: SkillDraftState, to: SkillDraftState, detail?: unknown): Promise<boolean> {
    knownState(to);
    const changed = detail === undefined
      ? await this.db.run("UPDATE controller_skill_drafts SET state = ?, updated_at = ? WHERE id = ? AND state = ?", [to, this.draftStamp(), id, from])
      : await this.db.run("UPDATE controller_skill_drafts SET state = ?, detail = ?, updated_at = ? WHERE id = ? AND state = ?", [to, JSON.stringify(detail), this.draftStamp(), id, from]);
    return changed > 0;
  }

  async takeSkillDraftSlot(project_key: string, cap: number): Promise<boolean> {
    // One statement: the insert starts the day at 1 only under a cap above 0; the upsert raises it only below the cap.
    const taken = await this.db.run(
      `INSERT INTO controller_skill_draft_days (project_key, day, count) SELECT ?, ?, 1 WHERE ? > 0
       ON CONFLICT (project_key, day) DO UPDATE SET count = count + 1 WHERE controller_skill_draft_days.count < ?`,
      [project_key, this.today(), cap, cap],
    );
    return taken > 0;
  }

  async skillDraftCount(project_key: string): Promise<number> {
    const [row] = await this.db.all("SELECT count FROM controller_skill_draft_days WHERE project_key = ? AND day = ?", [project_key, this.today()]);
    return row ? Number(row.count) : 0;
  }

  /** The store clock's UTC day, YYYY-MM-DD. */
  private today(): string {
    return this.draftStamp().slice(0, 10);
  }
}

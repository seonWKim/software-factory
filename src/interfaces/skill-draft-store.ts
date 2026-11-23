// Skill drafts (design 07-self-improvement, skill improvement): the store's methods over `controller_skill_drafts`
// (one row per drafted skill change, in one of SKILL_DRAFT_STATES) and `controller_skill_draft_days` (the drafts
// taken per project and UTC day). `detail` is JSON stored as text and read back as written; it never holds a
// transcript. Nothing calls them yet: drafting, scoring and the daily run come in later phases.

import type { Timestamp } from "../core/types.js";

/** A draft's states; the store refuses any other. */
export const SKILL_DRAFT_STATES = ["tried", "proposed", "promoted", "rejected", "held"] as const;
export type SkillDraftState = (typeof SKILL_DRAFT_STATES)[number];

export interface SkillDraft {
  id: string;
  project_key: string;
  skill_ref: string;
  state: SkillDraftState;
  /** Model tokens the draft spent. */
  tokens: number;
  detail: unknown;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface SkillDraftStore {
  /** Idempotent on the id: a second call returns the stored draft. Throws on a state not in SKILL_DRAFT_STATES. */
  addSkillDraft(d: Omit<SkillDraft, "created_at" | "updated_at">): Promise<SkillDraft>;
  /** Null for an unknown id. */
  getSkillDraft(id: string): Promise<SkillDraft | null>;
  /** A project's drafts, oldest first (created time, then id). */
  listSkillDrafts(project_key: string): Promise<SkillDraft[]>;
  /**
   * Moves a draft from `from` to `to` (and sets its detail when given), conditional on its state being `from`; false
   * when the draft is unknown or in another state. Throws on a `to` not in SKILL_DRAFT_STATES.
   */
  setSkillDraftState(id: string, from: SkillDraftState, to: SkillDraftState, detail?: unknown): Promise<boolean>;
  /**
   * Takes one of the project's draft slots for today (the store clock's UTC day): raises the day's count by one only
   * while it is below `cap`, in one conditional statement, so replicas cannot pass the cap. True when taken.
   */
  takeSkillDraftSlot(project_key: string, cap: number): Promise<boolean>;
  /** The slots the project has taken today (UTC); 0 when none. */
  skillDraftCount(project_key: string): Promise<number>;
}

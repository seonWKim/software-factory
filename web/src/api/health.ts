// GET /api/v1/health (the Health tab, with its host sleeps) and GET /api/v1/unreviewed-merges.

/** One host sleep a worker saw (a wait that ended over 60 s late): ids, a time and a number only. */
export interface HostSleepRow {
  worker_id: string;
  woke_at: string;
  /** How late the wait ended, in ms. */
  gap_ms: number;
  run_id: string | null;
}

export interface Health {
  checked_at: string;
  /** `msg` in plain words; `detail`, when present, the check's raw text (shown behind Details). */
  checks: { status: string; msg: string; detail?: string }[];
  /** The 10 newest host sleeps, newest first. */
  sleeps?: HostSleepRow[];
}

/** `/api/v1/unreviewed-merges`: PRs that merged with no work item, newest first. */
export interface UnreviewedMerges {
  as_of: string;
  merges: { project: string | null; change_ref: string; change_url: string | null; merge_sha: string | null; merged_by: string | null; recorded_at: string }[];
}

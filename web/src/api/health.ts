// GET /api/v1/health (the Health tab, with its host sleeps) and GET /api/v1/unreviewed-merges.

/** One host sleep a worker saw (a wait that ended over 60 s late): ids, a time and a number only. */
export interface HostSleepRow {
  worker_id: string;
  woke_at: string;
  /** How late the wait ended, in ms. */
  gap_ms: number;
  run_id: string | null;
  /** The work item and current status of the run the sleep held; null for an idle tick or a failed lookup. */
  work_item_id?: string | null;
  run_status?: string | null;
}

export interface Health {
  checked_at: string;
  /**
   * `msg` in plain words; `detail`, when present, the check's raw text (shown behind Details); `since` / `next`, when
   * the check names a time (a probe pause's start and next probe), its ISO instants, shown in local time.
   */
  checks: { status: string; msg: string; detail?: string; since?: string; next?: string }[];
  /** The 10 newest host sleeps, newest first. */
  sleeps?: HostSleepRow[];
}

/** `/api/v1/unreviewed-merges`: PRs that merged with no work item, newest first. */
export interface UnreviewedMerges {
  as_of: string;
  merges: { project: string | null; change_ref: string; change_url: string | null; merge_sha: string | null; merged_by: string | null; recorded_at: string;
    /** The PR's page and its checks page (a GitHub project with a stored label); null: none. */
    review_url?: string | null;
    checks_url?: string | null;
    /** The stored verdict ("failed", "reverted"); null: none stored. */
    check_verdict?: string | null;
  }[];
}

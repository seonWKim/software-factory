// The overview, the session and the app's own revision: GET /api/v1/overview and GET /api/v1/session (design §9).

/** The supervisor's status (the status page's banner); null when the factory is stopped. */
export interface FactoryState {
  state: string;
  rev: string | null;
  /** The revision the child on `rev` replaced; null: none yet. Absent from an older server. */
  previous_rev?: string | null;
  /** The commits of previous_rev..rev: count (null: git could not say) and at most 20 subjects; null: no previous_rev. */
  changes?: { count: number | null; subjects: string[] } | null;
  target_rev: string | null;
  child_pid: number | null;
  since: string;
  /** The effective `workers` setting (file, override or default, capped at max_workers), not the status file's value. */
  workers: number;
  workers_source: "override" | "file" | "default";
  error: string | null;
  pending: string[];
  /** A separate code checkout: commits `rev` is behind its origin/main; null: no fetch yet. Absent: self-hosting. */
  behind?: number | null;
}

/** What the factory needs from the operator besides a work item (design §9), with the command that clears it. */
export interface SystemAction {
  code: "migration_pending" | "token_expiring" | "model_credential" | "claim_pause" | "worker_pause" | "alarm" | "base_push_conflict" | "revision_mismatch";
  text: string;
  command: string;
  /** When it ends by itself, else null. */
  until: string | null;
  /** On an alarm: its alert's id, which the row's Dismiss posts (POST /api/v1/alarms/dismiss). */
  alert_id?: string;
  /** On an alarm: its pattern (`repeated_error`, `red_main`, `auto_stopped`, …) and error code, which pick its row's menu. */
  pattern?: string;
  error_code?: string;
  /** On an alarm whose detail is raw text (a failed chat check): that detail, shown under the row's Details only. */
  detail?: string | null;
  /** On a red_main alarm: the failing tests and output tail the red-main check kept (empty and null: none kept). */
  failing_tests?: string[];
  output_tail?: string | null;
  /** On the alarm of the auto-mode stop still in force: its row's sentence, Turn auto back on and What failed. */
  auto_stop?: AutoStop;
  /** On a claim pause: the pause's name, which the row's Resume now posts (`text` is its plain name). */
  pause?: string;
}

/** The last auto-mode stop while it is in force (design 03-risk): its alarm, when, and its cause code. */
export interface AutoStop {
  alert_id: string;
  at: string;
  /** `red_main`, `budget_checkpoint` or `failure_alert`. */
  cause: string;
  /** A red_main cause: what the red-main check printed (empty and null: none kept). */
  failing_tests?: string[];
  output_tail?: string | null;
}

/** `/api/v1/overview`: the page's numbers. */
export interface Overview {
  as_of: string;
  /** The revision the UI server's build was made from (its dist/ stamp); compared with WEB_REV. Null: unknown. */
  server_rev?: string | null;
  /** Local merges waiting for their base push (all bases); absent on an older server. */
  unpushed_merges?: number;
  stages: Record<string, number>;
  /** The number of Needs-you rows: open items blocked on a person or the budget, plus one per system action (each alarm its own): "Needs you (N)". */
  needs_you: number;
  system_actions?: SystemAction[];
  /** Open items (stage not CLOSED) and running runs, defined once on the server (the items list's `counts`). */
  open: number;
  running: number;
  queued: number;
  last_24h: { succeeded: number; failed: number; tokens: number };
  /** PRs recorded as merged with no work item in the last 7 days. */
  unreviewed_merges_7d?: number;
  /** Which plugins are in use: the tables show the Issue column only for "github". */
  plugins?: { issues: "github" | null };
  /** Absent when the server has no status function. */
  factory?: FactoryState | null;
  /** Days left on the GitHub token from the last health run; "unknown" before one; null: no expiry check. */
  github_token_days?: number | "unknown" | null;
  /** The GitHub budget the controller stored after its last poll; null: none stored (GitHub off, or no poll yet). */
  github_budget?: GitHubBudget | null;
}

/** The stored GitHub call budget (src/ui/github-budget.ts): `waiting` and `low` each show a banner on the Health tab. */
export interface GitHubBudget {
  limit: number;
  remaining: number;
  reset_at: string;
  budget_share: number;
  share_limit: number | null;
  /** The calls this process counted in the window. */
  counted: number;
  state: "ok" | "low" | "waiting";
  as_of: string;
  replica_id: string | null;
  wait_reason: string | null;
}

/** `/api/v1/session`: the token item commands send, whether commands are on, and who they act as. */
export interface Session {
  as_of: string;
  csrf_token: string;
  commands_enabled: boolean;
  /** The factory user commands act as: `ui.user_id`, else on loopback the CLI identity; null when off. */
  actor: string | null;
  actor_source: "config" | "environment" | null;
}

declare const __FACTORY_REV__: string | null | undefined;

/** The git revision built into this app (Vite `define`, web/vite.config.ts); null in a test or a build without git. */
export const WEB_REV: string | null = typeof __FACTORY_REV__ === "string" ? __FACTORY_REV__ : null;

// A throwaway database for the checks a run runs before it pushes (design §4, pre-push checks). The worker
// asks for one per run, lazily, the first time a check command runs, and drops it when the run ends,
// whatever happened. The one plugin is `none` (no database; the MySQL tests skip themselves).

/** One run's database. Its values reach only the check commands' environment, never an agent or the store. */
export interface TestDatabaseLease {
  /**
   * Env for each check command, e.g. { SF_TEST_MYSQL_URL: "mysql://user:pw@host:port/sf_test_<run>" }.
   * Empty for `none`. Never passed to an agent run.
   */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Values that must never leave the worker: the URL and its password, in every spelling the plugin knows.
   * The worker replaces them in check output before that output goes into a prompt, an outcome, a comment
   * or a log line.
   */
  readonly redact: readonly string[];
  /** Null when the database is there; otherwise one line for the PR body, e.g. "MySQL checks skipped: ...". */
  readonly skipped: string | null;
  /** Drops the database. Called once, in a finally block; must not throw for a database already gone. */
  release(): Promise<void>;
}

export interface TestDatabase {
  /** A new database for run `run_id`. A failure here fails the run as an infra failure. */
  create(run_id: string): Promise<TestDatabaseLease>;
}

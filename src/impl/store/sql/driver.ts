// What a SQL database must provide for SqlFactoryStore. All FactoryStore logic lives in SqlFactoryStore;
// a driver only runs statements and transactions, and names the few syntax differences.

export type SqlValue = string | number | null;
export type Row = Record<string, unknown>;

export interface SqlExecutor {
  all(sql: string, params?: readonly SqlValue[]): Promise<Row[]>;
  /** Rows matched by an UPDATE (even if the values didn't change), or inserted by an INSERT. */
  run(sql: string, params?: readonly SqlValue[]): Promise<number>;
}

export interface SqlDialect {
  /** Column that orders rows by insertion, as a tie-break after timestamps. */
  readonly seq: string;
  /** SELECT suffixes. Empty where the driver's transactions already exclude each other. */
  readonly forUpdate: string;
  readonly forUpdateSkipLocked: string;
  readonly forShare: string;
}

export interface SqlDriver extends SqlExecutor {
  readonly dialect: SqlDialect;
  /** Applies the driver's schema migrations. Safe to run from several processes at once. */
  migrate(): Promise<void>;
  /**
   * Runs `fn` as one transaction: commits if it resolves, rolls back if it throws. May run `fn` again
   * after a transient lock failure (deadlock), so `fn` must only touch the database.
   */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
  /** A unique-key violation. Only that statement failed; the transaction stays usable. */
  isDuplicateKey(err: unknown): boolean;
  close(): Promise<void>;
}

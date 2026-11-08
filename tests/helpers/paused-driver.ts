import type { SqlDriver, SqlExecutor } from "../../src/state/index.js";

/**
 * `db` with its first transaction paused right after the statement that matches `at` ran: `reached` resolves
 * there, and the transaction goes on (and commits) only after `release()`. Interleaves two writers' commits.
 */
export function pauseFirstTransaction(db: SqlDriver, at: RegExp) {
  let reached!: () => void;
  let release!: () => void;
  const reachedP = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  let armed = true;
  const paused = (tx: SqlExecutor): SqlExecutor => ({
    all: (sql, params) => tx.all(sql, params),
    run: async (sql, params) => {
      const n = await tx.run(sql, params);
      if (armed && at.test(sql)) {
        armed = false;
        reached();
        await gate;
      }
      return n;
    },
  });
  const driver: SqlDriver = {
    dialect: db.dialect,
    all: (sql, params) => db.all(sql, params),
    run: (sql, params) => db.run(sql, params),
    migrate: () => db.migrate(),
    schemaVersion: () => db.schemaVersion(),
    transaction: (fn) => db.transaction((tx) => fn(paused(tx))),
    isDuplicateKey: (err) => db.isDuplicateKey(err),
    close: () => db.close(),
  };
  return { driver, reached: reachedP, release };
}

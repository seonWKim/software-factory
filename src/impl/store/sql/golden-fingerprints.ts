// The golden gate's per-entity fingerprints (design 06-measurement, eval on change): the store methods of
// GoldenFingerprintStore and the SQLite migration that creates their table. SQLite only: no MySQL store exists.
// SqlProjectStore extends SqlGoldenStore, so these methods add no line to sql-factory-store.ts's budget.

import type { Timestamp } from "../../../core/types.js";
import type { GoldenFingerprint, GoldenFingerprintStore } from "../../../interfaces/factory-store.js";
import type { Row, SqlDriver } from "../../../state/index.js";

/**
 * SQLite migration 44. One row per entity id: the fingerprint (a hash of the entity's content) and verdict of its last
 * gate run, that run's pass rate and failing case ids (JSON), and its base: the fingerprint and pass rate of its last
 * passing run, which the next run is compared with. No backfill. IF NOT EXISTS: safe to run again.
 */
export const GOLDEN_FINGERPRINTS_SQLITE = `
  CREATE TABLE IF NOT EXISTS controller_golden_fingerprints (
    entity_id         TEXT PRIMARY KEY,
    fingerprint       TEXT NOT NULL,
    verdict           TEXT NOT NULL,
    pass_rate         REAL NOT NULL,
    failing_cases     TEXT NOT NULL,
    base_fingerprint  TEXT,
    base_rate         REAL,
    at                TEXT NOT NULL
  );
  `;

function rowToFingerprint(r: Row): GoldenFingerprint {
  return {
    entity_id: String(r.entity_id), fingerprint: String(r.fingerprint), verdict: String(r.verdict) as GoldenFingerprint["verdict"],
    pass_rate: Number(r.pass_rate), failing_cases: JSON.parse(String(r.failing_cases)) as string[],
    base_fingerprint: r.base_fingerprint == null ? null : String(r.base_fingerprint),
    base_rate: r.base_rate == null ? null : Number(r.base_rate), at: String(r.at) as Timestamp,
  };
}

/** GoldenFingerprintStore over a SqlDriver; `goldenStamp` is the store's injected Clock's time. */
export class SqlGoldenStore implements GoldenFingerprintStore {
  constructor(
    readonly db: SqlDriver,
    private readonly goldenStamp: () => Timestamp,
  ) {}

  async getGoldenFingerprint(entity_id: string): Promise<GoldenFingerprint | null> {
    const [row] = await this.db.all("SELECT * FROM controller_golden_fingerprints WHERE entity_id = ?", [entity_id]);
    return row ? rowToFingerprint(row) : null;
  }

  /** One upsert: a run of the same entity twice (another replica) leaves the later verdict, and a `pass` its base. */
  async recordGoldenVerdict(v: Parameters<GoldenFingerprintStore["recordGoldenVerdict"]>[0]): Promise<GoldenFingerprint> {
    const base = v.verdict === "pass" ? [v.fingerprint, v.pass_rate] : [null, null];
    await this.db.run(
      `INSERT INTO controller_golden_fingerprints (entity_id, fingerprint, verdict, pass_rate, failing_cases, base_fingerprint, base_rate, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (entity_id) DO UPDATE SET fingerprint = excluded.fingerprint, verdict = excluded.verdict,
         pass_rate = excluded.pass_rate, failing_cases = excluded.failing_cases, at = excluded.at,
         base_fingerprint = COALESCE(excluded.base_fingerprint, controller_golden_fingerprints.base_fingerprint),
         base_rate = COALESCE(excluded.base_rate, controller_golden_fingerprints.base_rate)`,
      [v.entity_id, v.fingerprint, v.verdict, v.pass_rate, JSON.stringify(v.failing_cases), ...base, this.goldenStamp()],
    );
    return (await this.getGoldenFingerprint(v.entity_id))!;
  }
}

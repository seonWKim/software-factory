// Skill evals: the SkillEvalStore methods over `controller_skill_eval_*`, `ext_skill_versions` and
// `controller_skill_version_gates`, as SqlSkillEvalStore, which SqlFactoryStore
// extends. Each method is one transaction; times come from the store's injected Clock. A duplicate key is "already
// there": the stored row is returned.

import type {
  SkillEvalCase, SkillEvalLabel, SkillEvalLabelVerdict, SkillEvalSplit, SkillEvalReplay, SkillEvalRun, SkillEvalRunFigures, SkillEvalRunStart, SkillEvalRunStatus, SkillEvalStore, SkillEvalSuite, SkillVersion,
  SkillVersionGate, SkillVersionGateFinish, SkillVersionGateState, SkillVersionGateTake,
} from "../../../interfaces/skill-eval-store.js";
import type { Timestamp, UserId } from "../../../core/types.js";
import type { Row, SqlDriver, SqlExecutor } from "../../../state/index.js";
import { SqlScheduleStore } from "./schedules.js";

const SUITE_COLUMNS = "id, skill_ref, title, created_by, created_at";
const CASE_COLUMNS = "id, suite_id, input, expected, created_at, seed, mcp, split";
const RUN_COLUMNS = "id, suite_id, status, started_at, finished_at, created_by, skill_version, suite_version, judge_version, factory_version";
/** A run as read back: its columns and its figures (null until recorded). */
const RUN_READ = `${RUN_COLUMNS}, model_class, judge_model_class, replays, pass_rate, errored`;
const REPLAY_COLUMNS = "run_id, case_id, verdict, detail, recorded_at, transcript, answer, input_tokens, output_tokens, cost_usd, wall_ms, replay";
const LABEL_COLUMNS = "run_id, case_id, replay, check_text, verdict, owner_id, created_at";
const VERSION_COLUMNS = "ref_id, version, folder_hash, text, source, created_at";
const GATE_COLUMNS = "ref_id, version, state, lease_token, lease_until, run_id, detail, created_at, updated_at";

const ts = (v: unknown) => String(v) as Timestamp;
const textOrNull = (v: unknown) => (v == null ? null : String(v));
const numberOrNull = (v: unknown) => (v == null ? null : Number(v));

const rowToSuite = (r: Row): SkillEvalSuite => ({ id: String(r.id), skill_ref: String(r.skill_ref), title: String(r.title), created_by: String(r.created_by) as UserId, created_at: ts(r.created_at) });
/** A case as read back; its seed and MCP servers only when set, so a case without them reads as before. */
const rowToCase = (r: Row): SkillEvalCase => ({
  id: String(r.id), suite_id: String(r.suite_id), input: JSON.parse(String(r.input)), expected: JSON.parse(String(r.expected)), split: String(r.split) as SkillEvalSplit, created_at: ts(r.created_at),
  ...(r.seed != null ? { seed: String(r.seed) } : {}), ...(r.mcp != null ? { mcp: JSON.parse(String(r.mcp)) as string[] } : {}),
});
const rowToRun = (r: Row): SkillEvalRun => ({
  id: String(r.id), suite_id: String(r.suite_id), status: String(r.status) as SkillEvalRunStatus, started_at: ts(r.started_at),
  finished_at: r.finished_at == null ? null : ts(r.finished_at), created_by: String(r.created_by) as UserId,
  skill_version: textOrNull(r.skill_version), suite_version: numberOrNull(r.suite_version), judge_version: textOrNull(r.judge_version),
  factory_version: textOrNull(r.factory_version), model_class: textOrNull(r.model_class), judge_model_class: textOrNull(r.judge_model_class),
  replays: numberOrNull(r.replays), pass_rate: numberOrNull(r.pass_rate), errored: numberOrNull(r.errored),
});
const rowToVersion = (r: Row): SkillVersion => ({
  ref_id: String(r.ref_id), version: Number(r.version), folder_hash: String(r.folder_hash), text: String(r.text), source: String(r.source), created_at: ts(r.created_at),
});
const rowToGate = (r: Row): SkillVersionGate => ({
  ref_id: String(r.ref_id), version: Number(r.version), state: String(r.state) as SkillVersionGateState, lease_token: textOrNull(r.lease_token),
  lease_until: r.lease_until == null ? null : ts(r.lease_until), run_id: textOrNull(r.run_id), detail: JSON.parse(String(r.detail)),
  created_at: ts(r.created_at), updated_at: ts(r.updated_at),
});
/** Gives a suite its next version, inside the transaction of the case change that calls for it. */
const bumpSuiteVersion = (tx: SqlExecutor, suite_id: string) => tx.run("UPDATE controller_skill_eval_suites SET version = version + 1 WHERE id = ?", [suite_id]);

const rowToReplay = (r: Row): SkillEvalReplay => ({
  run_id: String(r.run_id), case_id: String(r.case_id), verdict: String(r.verdict), detail: JSON.parse(String(r.detail)), recorded_at: ts(r.recorded_at),
  transcript: textOrNull(r.transcript), answer: textOrNull(r.answer), input_tokens: numberOrNull(r.input_tokens), output_tokens: numberOrNull(r.output_tokens),
  cost_usd: numberOrNull(r.cost_usd), wall_ms: numberOrNull(r.wall_ms), replay: numberOrNull(r.replay),
});

const rowToLabel = (r: Row): SkillEvalLabel => ({
  run_id: String(r.run_id), case_id: String(r.case_id), replay: Number(r.replay), check: String(r.check_text),
  verdict: String(r.verdict) as SkillEvalLabelVerdict, owner_id: String(r.owner_id) as UserId, created_at: ts(r.created_at),
});

/** SkillEvalStore over a SqlDriver; `evalStamp` is the store's injected Clock's time. */
export class SqlSkillEvalStore extends SqlScheduleStore implements SkillEvalStore {
  constructor(db: SqlDriver, private readonly evalStamp: () => Timestamp) {
    super(db, evalStamp);
  }

  createSkillEvalSuite(s: Omit<SkillEvalSuite, "created_at">): Promise<SkillEvalSuite> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_suites (${SUITE_COLUMNS}) VALUES (?, ?, ?, ?, ?)`, [s.id, s.skill_ref, s.title, s.created_by, this.evalStamp()]);
      const [row] = await tx.all(`SELECT ${SUITE_COLUMNS} FROM controller_skill_eval_suites WHERE id = ?`, [s.id]);
      return rowToSuite(row!);
    });
  }

  async listSkillEvalSuites(): Promise<SkillEvalSuite[]> {
    return (await this.db.all(`SELECT ${SUITE_COLUMNS} FROM controller_skill_eval_suites ORDER BY created_at, id`)).map(rowToSuite);
  }

  addSkillEvalCase(c: Omit<SkillEvalCase, "created_at" | "split"> & { split?: SkillEvalSplit }): Promise<SkillEvalCase> {
    return this.db.transaction(async (tx) => {
      const added = await tx.run(
        `INSERT OR IGNORE INTO controller_skill_eval_cases (${CASE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.suite_id, JSON.stringify(c.input), JSON.stringify(c.expected), this.evalStamp(), c.seed ?? null, c.mcp ? JSON.stringify(c.mcp) : null, c.split ?? "dev"],
      );
      if (added === 1) await bumpSuiteVersion(tx, c.suite_id);
      const [row] = await tx.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE id = ?`, [c.id]);
      return rowToCase(row!);
    });
  }

  async listSkillEvalCases(suite_id: string): Promise<SkillEvalCase[]> {
    return (await this.db.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE suite_id = ? ORDER BY created_at, id`, [suite_id])).map(rowToCase);
  }

  updateSkillEvalSuiteTitle(id: string, title: string): Promise<SkillEvalSuite | null> {
    return this.db.transaction(async (tx) => {
      await tx.run("UPDATE controller_skill_eval_suites SET title = ? WHERE id = ?", [title, id]);
      const [row] = await tx.all(`SELECT ${SUITE_COLUMNS} FROM controller_skill_eval_suites WHERE id = ?`, [id]);
      return row ? rowToSuite(row) : null;
    });
  }

  deleteSkillEvalSuite(id: string): Promise<"deleted" | "running" | "unknown"> {
    return this.db.transaction(async (tx) => {
      const [suite] = await tx.all("SELECT id FROM controller_skill_eval_suites WHERE id = ?", [id]);
      if (!suite) return "unknown";
      const [running] = await tx.all("SELECT id FROM controller_skill_eval_runs WHERE suite_id = ? AND status = 'running'", [id]);
      if (running) return "running";
      await tx.run("DELETE FROM controller_skill_eval_cases WHERE suite_id = ?", [id]);
      await tx.run("DELETE FROM controller_skill_eval_suites WHERE id = ?", [id]);
      return "deleted";
    });
  }

  async getSkillEvalCase(id: string): Promise<SkillEvalCase | null> {
    const [row] = await this.db.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE id = ?`, [id]);
    return row ? rowToCase(row) : null;
  }

  updateSkillEvalCase(id: string, c: Pick<SkillEvalCase, "input" | "expected">): Promise<SkillEvalCase | null> {
    return this.db.transaction(async (tx) => {
      await tx.run("UPDATE controller_skill_eval_cases SET input = ?, expected = ? WHERE id = ?", [JSON.stringify(c.input), JSON.stringify(c.expected), id]);
      const [row] = await tx.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE id = ?`, [id]);
      if (!row) return null;
      await bumpSuiteVersion(tx, String(row.suite_id));
      return rowToCase(row);
    });
  }

  setSkillEvalCaseSplit(id: string, split: SkillEvalSplit): Promise<SkillEvalCase | null> {
    return this.db.transaction(async (tx) => {
      await tx.run("UPDATE controller_skill_eval_cases SET split = ? WHERE id = ?", [split, id]);
      const [row] = await tx.all(`SELECT ${CASE_COLUMNS} FROM controller_skill_eval_cases WHERE id = ?`, [id]);
      return row ? rowToCase(row) : null;
    });
  }

  deleteSkillEvalCase(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all("SELECT suite_id FROM controller_skill_eval_cases WHERE id = ?", [id]);
      if (!row || (await tx.run("DELETE FROM controller_skill_eval_cases WHERE id = ?", [id])) !== 1) return false;
      await bumpSuiteVersion(tx, String(row.suite_id));
      return true;
    });
  }

  startSkillEvalRun(r: SkillEvalRunStart): Promise<SkillEvalRun> {
    return this.db.transaction(async (tx) => {
      // The suite's version as it is in this transaction; an unknown suite gives null.
      await tx.run(
        `INSERT OR IGNORE INTO controller_skill_eval_runs (${RUN_COLUMNS}) VALUES (?, ?, 'running', ?, NULL, ?, ?, (SELECT version FROM controller_skill_eval_suites WHERE id = ?), ?, ?)`,
        [r.id, r.suite_id, this.evalStamp(), r.created_by, r.skill_version ?? null, r.suite_id, r.judge_version ?? null, r.factory_version ?? null],
      );
      const [row] = await tx.all(`SELECT ${RUN_READ} FROM controller_skill_eval_runs WHERE id = ?`, [r.id]);
      return rowToRun(row!);
    });
  }

  finishSkillEvalRun(id: string, status: Exclude<SkillEvalRunStatus, "running">): Promise<boolean> {
    return this.db.transaction(async (tx) => (await tx.run("UPDATE controller_skill_eval_runs SET status = ?, finished_at = ? WHERE id = ? AND finished_at IS NULL", [status, this.evalStamp(), id])) === 1);
  }

  recordSkillEvalReplay(r: Omit<SkillEvalReplay, "recorded_at">): Promise<SkillEvalReplay> {
    return this.db.transaction(async (tx) => {
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_replays (${REPLAY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        r.run_id, r.case_id, r.verdict, JSON.stringify(r.detail), this.evalStamp(),
        r.transcript ?? null, r.answer ?? null, r.input_tokens ?? null, r.output_tokens ?? null, r.cost_usd ?? null, r.wall_ms ?? null, r.replay ?? null,
      ]);
      // The unique key is run, case and COALESCE(replay, 0): a clash keeps the stored row, read back here.
      const [row] = await tx.all(
        `SELECT ${REPLAY_COLUMNS} FROM controller_skill_eval_replays WHERE run_id = ? AND case_id = ? AND COALESCE(replay, 0) = ?`, [r.run_id, r.case_id, r.replay ?? 0],
      );
      return rowToReplay(row!);
    });
  }

  async listSkillEvalReplays(run_id: string): Promise<SkillEvalReplay[]> {
    return (await this.db.all(`SELECT ${REPLAY_COLUMNS} FROM controller_skill_eval_replays WHERE run_id = ? ORDER BY recorded_at, case_id, replay`, [run_id])).map(rowToReplay);
  }

  recordSkillEvalLabel(l: Omit<SkillEvalLabel, "created_at">): Promise<SkillEvalLabel> {
    return this.db.transaction(async (tx) => {
      const key = [l.run_id, l.case_id, l.replay, l.check];
      // The key is run, case, replay and check: a clash keeps the first label, read back here.
      await tx.run(`INSERT OR IGNORE INTO controller_skill_eval_labels (${LABEL_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`, [...key, l.verdict, l.owner_id, this.evalStamp()]);
      const [row] = await tx.all(`SELECT ${LABEL_COLUMNS} FROM controller_skill_eval_labels WHERE run_id = ? AND case_id = ? AND replay = ? AND check_text = ?`, key);
      return rowToLabel(row!);
    });
  }

  async listSkillEvalLabels(skill_ref: string): Promise<SkillEvalLabel[]> {
    const cols = LABEL_COLUMNS.split(", ").map((c) => `l.${c}`).join(", ");
    const rows = await this.db.all(
      `SELECT ${cols} FROM controller_skill_eval_labels l JOIN controller_skill_eval_runs r ON r.id = l.run_id JOIN controller_skill_eval_suites s ON s.id = r.suite_id
       WHERE s.skill_ref = ? ORDER BY l.created_at, l.run_id, l.case_id, l.replay, l.check_text`,
      [skill_ref],
    );
    return rows.map(rowToLabel);
  }

  async listSkillEvalRuns(skill_ref: string): Promise<SkillEvalRun[]> {
    const cols = RUN_READ.split(", ").map((c) => `r.${c}`).join(", ");
    const rows = await this.db.all(
      `SELECT ${cols} FROM controller_skill_eval_runs r JOIN controller_skill_eval_suites s ON s.id = r.suite_id WHERE s.skill_ref = ? ORDER BY r.started_at DESC, r.id DESC`,
      [skill_ref],
    );
    return rows.map(rowToRun);
  }

  async getSkillEvalRun(id: string): Promise<SkillEvalRun | null> {
    const [row] = await this.db.all(`SELECT ${RUN_READ} FROM controller_skill_eval_runs WHERE id = ?`, [id]);
    return row ? rowToRun(row) : null;
  }

  recordSkillEvalRunFigures(id: string, f: SkillEvalRunFigures): Promise<boolean> {
    return this.db.transaction(async (tx) => (await tx.run(
      "UPDATE controller_skill_eval_runs SET model_class = ?, judge_model_class = ?, replays = ?, pass_rate = ?, errored = ? WHERE id = ? AND finished_at IS NOT NULL AND replays IS NULL",
      [f.model_class, f.judge_model_class, f.replays, f.pass_rate, f.errored, id],
    )) === 1);
  }

  recordSkillVersion(v: Omit<SkillVersion, "version" | "created_at">): Promise<SkillVersion | null> {
    return this.db.transaction(async (tx) => {
      const [latest] = await tx.all(`SELECT ${VERSION_COLUMNS} FROM ext_skill_versions WHERE ref_id = ? ORDER BY version DESC LIMIT 1`, [v.ref_id]);
      if (latest && String(latest.folder_hash) === v.folder_hash) return null;
      const next = latest ? Number(latest.version) + 1 : 1;
      const row = { ...v, version: next, created_at: this.evalStamp() };
      // A clash on (ref_id, version) means another worker wrote this version first: nothing more to write.
      const wrote = await tx.run(`INSERT OR IGNORE INTO ext_skill_versions (${VERSION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)`, [row.ref_id, row.version, row.folder_hash, row.text, row.source, row.created_at]);
      if (wrote !== 1) return null;
      // The version's gate, in this transaction: it is not current until a gate pass passes it.
      await tx.run(`INSERT INTO controller_skill_version_gates (${GATE_COLUMNS}) VALUES (?, ?, 'pending', NULL, NULL, NULL, '{}', ?, ?)`, [row.ref_id, row.version, row.created_at, row.created_at]);
      return row;
    });
  }

  async listSkillVersions(ref_id: string): Promise<SkillVersion[]> {
    return (await this.db.all(`SELECT ${VERSION_COLUMNS} FROM ext_skill_versions WHERE ref_id = ? ORDER BY version`, [ref_id])).map(rowToVersion);
  }

  async currentSkillVersion(ref_id: string, before?: number): Promise<SkillVersion | null> {
    const cols = VERSION_COLUMNS.split(", ").map((c) => `v.${c}`).join(", ");
    const [row] = await this.db.all(
      `SELECT ${cols} FROM ext_skill_versions v LEFT JOIN controller_skill_version_gates g ON g.ref_id = v.ref_id AND g.version = v.version
       WHERE v.ref_id = ? AND v.version < ? AND (g.state IS NULL OR g.state = 'passed') ORDER BY v.version DESC LIMIT 1`,
      [ref_id, before ?? Number.MAX_SAFE_INTEGER],
    );
    return row ? rowToVersion(row) : null;
  }

  async listDueSkillVersionGates(now: Timestamp): Promise<SkillVersionGate[]> {
    return (await this.db.all(
      `SELECT ${GATE_COLUMNS} FROM controller_skill_version_gates WHERE state = 'pending' OR (state = 'running' AND lease_until <= ?) ORDER BY ref_id, version`, [now],
    )).map(rowToGate);
  }

  takeSkillVersionGate(t: SkillVersionGateTake): Promise<boolean> {
    return this.db.transaction(async (tx) => (await tx.run(
      `UPDATE controller_skill_version_gates SET state = 'running', lease_token = ?, lease_until = ?, updated_at = ?
       WHERE ref_id = ? AND version = ? AND (state = 'pending' OR (state = 'running' AND lease_until <= ?))`,
      [t.lease_token, t.lease_until, this.evalStamp(), t.ref_id, t.version, t.now],
    )) === 1);
  }

  finishSkillVersionGate(f: SkillVersionGateFinish): Promise<boolean> {
    return this.db.transaction(async (tx) => (await tx.run(
      `UPDATE controller_skill_version_gates SET state = ?, lease_token = NULL, lease_until = NULL, run_id = ?, detail = ?, updated_at = ?
       WHERE ref_id = ? AND version = ? AND state = 'running' AND lease_token = ?`,
      [f.state, f.run_id, JSON.stringify(f.detail), this.evalStamp(), f.ref_id, f.version, f.lease_token],
    )) === 1);
  }

  async getSkillVersionGate(ref_id: string, version: number): Promise<SkillVersionGate | null> {
    const [row] = await this.db.all(`SELECT ${GATE_COLUMNS} FROM controller_skill_version_gates WHERE ref_id = ? AND version = ?`, [ref_id, version]);
    return row ? rowToGate(row) : null;
  }

  async listHeldSkillVersionGates(limit: number): Promise<SkillVersionGate[]> {
    return (await this.db.all(
      `SELECT ${GATE_COLUMNS} FROM controller_skill_version_gates WHERE state = 'held' ORDER BY created_at DESC, version DESC, ref_id LIMIT ?`, [limit],
    )).map(rowToGate);
  }

  settleSkillVersionGate(ref_id: string, version: number, state: "passed" | "rejected", by: UserId): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.all(`SELECT detail FROM controller_skill_version_gates WHERE ref_id = ? AND version = ? AND state = 'held'`, [ref_id, version]);
      if (!row) return false;
      const detail = { ...(JSON.parse(String(row.detail)) as Record<string, unknown>), settled_by: by };
      return (await tx.run(
        `UPDATE controller_skill_version_gates SET state = ?, detail = ?, updated_at = ? WHERE ref_id = ? AND version = ? AND state = 'held'`,
        [state, JSON.stringify(detail), this.evalStamp(), ref_id, version],
      )) === 1;
    });
  }
}

// The golden gate (design 06-measurement, eval on change, issue #493). A change to an entity (an id and its content:
// `role:<name>`, `prompt:<file>`, `skill:<name>`, ...) replays the entity's own cases and its dependents' cases (each
// case whose case.json `uses` names it), `golden.replays` times each, and compares each entity's pass rate with its base
// (the pass rate of its last passing run) against `golden.regression_margin`. A regression blocks the item on a human
// (`eval_regression`), and the comment names the failing cases. Each entity's fingerprint (a hash of its content) and
// last verdict are stored (FactoryStore.recordGoldenVerdict), never kept in memory, so an entity whose content matches its
// last passing run is not re-run, on any worker. With no `golden` block in factory.config.json the gate is off.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenCasesByRole } from "../../runtime/index.js";
import { type FactoryStore, type GoldenFingerprint, type WorkItem, SYSTEM, footerAfter } from "../units/support.js";

/** blocked_reason (with `blocked_on: human`) of a change whose golden cases regressed. */
export const EVAL_REGRESSION = "eval_regression";

/** An entity a change touches: its id (`role:<name>` for a role's own cases) and its content, whose hash is its fingerprint. */
export interface GoldenEntity { id: string; content: string }

export interface GoldenGateDeps {
  /** `goldenConfig` of factory.config.json: null (no `golden` block) turns the gate off. */
  golden: { replays: number; regression_margin: number } | null;
  /** `<repo>/src/worker/roles`: each role's cases are under `<name>/golden/`. */
  rolesDir: string;
  store: Pick<FactoryStore, "transition" | "getGoldenFingerprint" | "recordGoldenVerdict">;
  /** Replays `ids` of `role`'s cases `replays` times each, one result per replay: `runCases(deps, { role, ids, replays })` in src/golden.ts. */
  replay(role: string, ids: readonly string[], replays: number): Promise<{ cases: readonly ReplayResult[] }>;
  /** Posts on the item (the outbox unit's `comment`); the key makes a repeat post once. */
  comment(it: WorkItem, key: string, body: string): Promise<unknown>;
}

export interface GoldenGateResult {
  outcome: "off" | "pass" | "regression";
  /** The cases replayed, as `<role>/<case id>`: each once per change, however many changed entities list it. */
  ran: string[];
  /** The entities not re-run: their content matches their last passing run. */
  skipped: string[];
  verdicts: GoldenFingerprint[];
}

interface CaseRef { role: string; id: string; uses: string[] }

/** One replay of a case (golden's CaseResult): it passed when its verdict is what it expects; an errored replay fails. */
export interface ReplayResult { id: string; expect: "should_flag" | "should_pass"; verdict: "bug" | "pass" | "errored" }
const passed = (r: ReplayResult) => r.verdict === (r.expect === "should_flag" ? "bug" : "pass");

export const fingerprint = (content: string): string => createHash("sha256").update(content).digest("hex");

/** Every case of every role with its `uses` list ([] when absent). A malformed `uses` throws before any replay. */
export function listCases(rolesDir: string): CaseRef[] {
  return [...goldenCasesByRole(rolesDir)].flatMap(([role, ids]) => ids.map((id) => {
    const uses = (JSON.parse(readFileSync(join(rolesDir, role, "golden", id, "case.json"), "utf8")) as { uses?: unknown }).uses ?? [];
    if (!Array.isArray(uses) || !uses.every((u) => typeof u === "string" && u !== "")) throw new Error(`case ${role}/${id}: uses must be a list of entity ids`);
    return { role, id, uses: uses as string[] };
  }));
}

const key = (c: CaseRef) => `${c.role}/${c.id}`;

/** An entity's cases: its role's own (`role:<name>`), and every case whose `uses` names it. */
const casesOf = (entity: string, cases: readonly CaseRef[]) => cases.filter((c) => entity === `role:${c.role}` || c.uses.includes(entity));

/**
 * The gate for one change of `it` that touches `entities`. An entity with no case, or whose fingerprint is its base's,
 * runs nothing. Each due case is replayed once per change; an entity's pass rate is its cases' passing replays over all
 * its replays (an errored replay fails). With no base yet the run becomes the base. A drop of more than the margin from
 * the base is a regression: recorded, then the item blocks on a human. Safe to run twice: an item already blocked on
 * `eval_regression` is left as it is, and the comment's key posts it once.
 */
export async function checkChange(deps: GoldenGateDeps, it: WorkItem, entities: readonly GoldenEntity[]): Promise<GoldenGateResult> {
  const golden = deps.golden;
  if (!golden) return { outcome: "off", ran: [], skipped: [], verdicts: [] };
  const all = listCases(deps.rolesDir);
  const due: { id: string; fingerprint: string; base: number | null; cases: CaseRef[] }[] = [];
  const skipped: string[] = [];
  for (const e of entities) {
    const fp = fingerprint(e.content);
    const stored = await deps.store.getGoldenFingerprint(e.id);
    const cases = casesOf(e.id, all);
    if (stored?.base_fingerprint === fp) skipped.push(e.id);
    else if (cases.length > 0) due.push({ id: e.id, fingerprint: fp, base: stored?.base_rate ?? null, cases });
  }

  const run = [...new Map(due.flatMap((d) => d.cases).map((c) => [key(c), c])).values()];
  const replays = new Map<string, boolean[]>();
  for (const role of new Set(run.map((c) => c.role))) {
    const ids = run.filter((c) => c.role === role).map((c) => c.id);
    for (const r of (await deps.replay(role, ids, golden.replays)).cases) replays.set(`${role}/${r.id}`, [...(replays.get(`${role}/${r.id}`) ?? []), passed(r)]);
  }

  const verdicts: GoldenFingerprint[] = [];
  for (const d of due) {
    // A case with no replay result counts as one failed replay.
    const results = d.cases.map((c) => ({ key: key(c), passed: replays.get(key(c)) ?? [false] }));
    const runs = results.flatMap((r) => r.passed);
    const pass_rate = runs.filter(Boolean).length / runs.length;
    const failing_cases = results.filter((r) => r.passed.includes(false)).map((r) => r.key);
    // A tiny epsilon so a change of exactly the margin passes despite floating point (as golden compare does).
    const regression = d.base !== null && d.base - pass_rate > golden.regression_margin + 1e-9;
    verdicts.push(await deps.store.recordGoldenVerdict({ entity_id: d.id, fingerprint: d.fingerprint, verdict: regression ? "regression" : "pass", pass_rate, failing_cases }));
  }

  const regressed = verdicts.filter((v) => v.verdict === "regression");
  if (regressed.length > 0) await block(deps, it, regressed, golden.regression_margin);
  return { outcome: regressed.length > 0 ? "regression" : "pass", ran: run.map(key), skipped, verdicts };
}

const rate = (r: number | null) => (r === null ? "n/a" : r.toFixed(3));

/** Comments with each regressed entity and its failing cases, then blocks the item on a human (`eval_regression`). */
async function block(deps: GoldenGateDeps, it: WorkItem, regressed: readonly GoldenFingerprint[], margin: number): Promise<void> {
  if (it.blocked_on === "human" && it.blocked_reason === EVAL_REGRESSION) return;
  const patch = { blocked_on: "human" as const, blocked_reason: EVAL_REGRESSION };
  const failing = [...new Set(regressed.flatMap((v) => v.failing_cases))];
  const body = [
    "This change regressed its golden cases (eval on change), so it waits for a human verdict: fix the entity, or revise the case into a new version.",
    "",
    ...regressed.map((v) => `- \`${v.entity_id}\`: pass rate ${rate(v.pass_rate)}, down from ${rate(v.base_rate)} (margin ${margin}); failing: ${v.failing_cases.map((c) => `\`${c}\``).join(", ")}`),
    "",
    footerAfter(it, patch),
  ].join("\n");
  await deps.comment(it, `eval-regression:${fingerprint(regressed.map((v) => `${v.entity_id}@${v.fingerprint}`).join("\n")).slice(0, 16)}`, body);
  await deps.store.transition({ id: it.id, expected_version: it.version, patch, actor: SYSTEM, reason: EVAL_REGRESSION, detail: { failing_cases: JSON.stringify(failing) } });
}

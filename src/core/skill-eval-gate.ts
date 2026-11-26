// The new-version gate of an imported skill (design 07-self-improvement). Each version recorded from now on has a
// gate row, pending, written with its version row (SkillEvalStore.recordSkillVersion). A gate pass takes each due gate
// (pending, or running with its lease ended) by a conditional update under a new lease token and a lease end
// GATE_LEASE_MS after the take, runs the skill's suite on the version with GATE_REPLAYS replays per case, and compares
// it with the latest run of the current version (the newest earlier version whose gate is passed or that has none) on
// the same model class, paired case by case (compareSkillEvalRuns: the baseline as a, the gate run as b). Only the
// paired verdict worse (sign-test p < 0.05 and a paired 95% interval below zero) holds the version, names the cases
// whose pass rate fell and raises one owner question (alert pattern skill_version_gate, one per skill ref and version);
// within noise or better passes it, and runs that are not comparable (suite or judge versions differ, or one has none
// recorded) pass with reason not_comparable. A skill with no suite passes with no run (reason no_suite); a run that gives no pass rate puts the gate back
// to pending. Every end is written only while the pass still holds its token: a late holder writes nothing and asks
// nothing. A version recorded before the gate has no row: it stays current and is never gated (no backfill). The Clock
// is injected; nothing is kept in process.

import { MODEL_CLASSES, type ModelClass } from "./model-choice.js";
import { compareSkillEvalRuns } from "./skill-eval-compare.js";
import { caseRates } from "./skill-eval-stats.js";
import type { Timestamp, UserId } from "./types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { SkillEvalRun, SkillEvalStore, SkillVersionGate, SkillVersionGateFinish } from "../interfaces/skill-eval-store.js";

/** Replays per case of a gate run. */
export const GATE_REPLAYS = 3;
/** How long a take holds a gate: a gate still running after it is taken again by the next pass. */
export const GATE_LEASE_MS = 30 * 60_000;
/** Who starts the gate runs. */
export const SKILL_GATE = "system:skill-gate" as UserId;
/** The class a gate runs on when the current version has no run to name one. */
const DEFAULT_CLASS: ModelClass = "standard";
const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString() as Timestamp;

/** What the composition root builds (src/skill-evals.ts skillGateWiring). */
export interface SkillGateWiring {
  /** The skill_ref of the suite whose folder is the imported skill's (ext_skill_refs `ref_id`) folder; null: none. */
  suiteOf(ref_id: string): Promise<string | null>;
  /** `skill_ref`'s suite run on the stored version `folder_hash`, stored with its figures; null when nothing ran. */
  run(r: { skill_ref: string; folder_hash: string; replays: number; model_class: ModelClass; created_by: UserId }, signal: AbortSignal): Promise<SkillEvalRun | null>;
  /** A new lease token. */
  newToken(): string;
}

type Store = Pick<FactoryStore,
  "listDueSkillVersionGates" | "takeSkillVersionGate" | "finishSkillVersionGate" | "currentSkillVersion" | "listSkillVersions" | "listSkillEvalRuns" | "listSkillEvalReplays" | "recordAlert">;

export interface SkillGateDeps {
  store: Store;
  /** The owner question's text is scanned as UI text first. */
  scanner: EgressScanner;
  /** The injected Clock (only its now): the take's time and lease end. */
  clock: { now(): Date };
  wiring: SkillGateWiring;
  signal: AbortSignal;
}

/** Why a gate ended as it did. */
export type GateReason = "no_suite" | "no_version" | "no_pass_rate" | "no_baseline" | "not_comparable" | "within_noise" | "better" | "dropped";

/** One gate a pass took: the state it wrote, or `lost` when its lease token was no longer the gate's (nothing written). */
export interface SkillGateResult {
  ref_id: string;
  version: number;
  state: SkillVersionGateFinish["state"] | "lost";
  reason: GateReason;
}

/** One gate pass: every due gate it can take, oldest first. A gate another holder takes first is left out. */
export async function runSkillVersionGates(d: SkillGateDeps): Promise<SkillGateResult[]> {
  const out: SkillGateResult[] = [];
  for (const g of await d.store.listDueSkillVersionGates(iso(d.clock.now().getTime()))) {
    const r = await gateVersion(d, g.ref_id, g.version);
    if (r) out.push(r);
  }
  return out;
}

async function gateVersion(d: SkillGateDeps, ref_id: string, version: number): Promise<SkillGateResult | null> {
  const now = d.clock.now().getTime();
  const held = { ref_id, version, lease_token: d.wiring.newToken() };
  if (!(await d.store.takeSkillVersionGate({ ...held, now: iso(now), lease_until: iso(now + GATE_LEASE_MS) }))) return null;
  const finish = async (state: SkillVersionGateFinish["state"], run_id: string | null, detail: { reason: GateReason } & Record<string, unknown>): Promise<SkillGateResult> => {
    const wrote = await d.store.finishSkillVersionGate({ ...held, state, run_id, detail });
    return { ref_id, version, state: wrote ? state : "lost", reason: detail.reason };
  };

  const skill_ref = await d.wiring.suiteOf(ref_id);
  if (skill_ref === null) return finish("passed", null, { reason: "no_suite" });
  const self = (await d.store.listSkillVersions(ref_id)).find((v) => v.version === version);
  if (!self) return finish("pending", null, { reason: "no_version" });
  const current = await d.store.currentSkillVersion(ref_id, version);
  const baseline = current
    ? (await d.store.listSkillEvalRuns(skill_ref)).find((r) => r.skill_version === current.folder_hash && r.finished_at !== null && r.pass_rate !== null)
    : undefined;
  const model_class = MODEL_CLASSES.find((c) => c === baseline?.model_class) ?? DEFAULT_CLASS;

  const run = await d.wiring.run({ skill_ref, folder_hash: self.folder_hash, replays: GATE_REPLAYS, model_class, created_by: SKILL_GATE }, d.signal)
    .catch((err: unknown) => { if (d.signal.aborted) throw err; return null; });
  if (!run || run.pass_rate === null) return finish("pending", null, { reason: "no_pass_rate", ...(run ? { failed_run: run.id } : {}) });
  if (!current || !baseline) return finish("passed", run.id, { reason: "no_baseline", pass_rate: run.pass_rate, model_class, current_version: current?.version ?? null });

  const scores = { pass_rate: run.pass_rate, model_class, current: { version: current.version, run_id: baseline.id, pass_rate: baseline.pass_rate } };
  const [before, after] = await Promise.all([d.store.listSkillEvalReplays(baseline.id), d.store.listSkillEvalReplays(run.id)]);
  const cmp = compareSkillEvalRuns(baseline, run, { a: before, b: after });
  if (!cmp.comparable) return finish("passed", run.id, { reason: "not_comparable", ...scores, not_comparable: cmp.reason });
  const paired = { verdict: cmp.verdict, p_value: cmp.p_value, mean_difference: cmp.mean_difference, interval: cmp.interval, wins: cmp.wins, losses: cmp.losses, ties: cmp.ties };
  if (cmp.verdict !== "worse") return finish("passed", run.id, { reason: cmp.verdict === "better" ? "better" : "within_noise", ...scores, ...paired });
  const fell = casesThatFell(before, after);
  const result = await finish("held", run.id, { reason: "dropped", ...scores, ...paired, fell });
  if (result.state === "held") {
    await heldQuestion(d, { ref_id, version, skill_ref, pass_rate: run.pass_rate, before: baseline.pass_rate!, current: current.version, model_class, fell, p_value: cmp.p_value! });
  }
  return result;
}

/** The cases in both runs whose pass rate in the gate run is below the current version's run, in order. */
function casesThatFell(before_replays: Parameters<typeof caseRates>[0], gate_replays: Parameters<typeof caseRates>[0]): string[] {
  const before = caseRates(before_replays), after = caseRates(gate_replays);
  return [...after].filter(([id, rate]) => before.has(id) && rate < before.get(id)!).map(([id]) => id).sort();
}

/** One owner question per skill ref and version (alert pattern skill_version_gate), its text scanned as UI text first. */
async function heldQuestion(
  d: SkillGateDeps, q: { ref_id: string; version: number; skill_ref: string; pass_rate: number; before: number; current: number; model_class: ModelClass; fell: readonly string[]; p_value: number },
): Promise<void> {
  const cases = q.fell.length > 0 ? q.fell.join(", ") : "none by itself";
  const text = `${q.skill_ref} version ${q.version} is held: its pass rate ${q.pass_rate} on ${q.model_class} fell from ${q.before} (version ${q.current}), and the paired verdict is worse (sign-test p ${q.p_value.toFixed(3)}). Cases that fell: ${cases}.`;
  const detail = (await d.scanner.scan("ui", text)).clean ? text : null;
  await d.store.recordAlert({ pattern: "skill_version_gate", pattern_key: heldAlertKey(q.ref_id, q.version), error_code: "pass_rate_drop", count: q.version, detail }, DAY_MS);
}

/** The pattern key of a held version's owner question: one per skill ref and version. */
export const heldAlertKey = (ref_id: string, version: number): string => `skill_version_gate:${ref_id}:${version}`;

/** What a bare `/approve` or `/reject` (no item) did to the newest held skill version (design 07-self-improvement); a shared command, re-exported by commands.ts. */
export type SkillVersionSettle = { gate: SkillVersionGate; settled: boolean };

/**
 * A bare `/approve` or `/reject`, with no work item: the newest held skill version of any skill (created, then
 * version) is settled by the store's conditional update. `/approve` passes it, so it is current unless a newer version
 * passed; `/reject` rejects it, so the version current before it stays current. Null when no version is held: the
 * caller keeps its item-ID refusal. `settled` is false when another process settled it first.
 */
export async function settleHeldSkillVersion(
  store: Pick<SkillEvalStore, "listHeldSkillVersionGates" | "settleSkillVersionGate">, command: "approve" | "reject", by: UserId,
): Promise<SkillVersionSettle | null> {
  const [gate] = await store.listHeldSkillVersionGates(1);
  if (!gate) return null;
  return { gate, settled: await store.settleSkillVersionGate(gate.ref_id, gate.version, command === "approve" ? "passed" : "rejected", by) };
}

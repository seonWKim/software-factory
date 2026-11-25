// The new-version gate of an imported skill (design 07-self-improvement). Each version recorded from now on has a
// gate row, pending, written with its version row (SkillEvalStore.recordSkillVersion). A gate pass takes each due gate
// (pending, or running with its lease ended) by a conditional update under a new lease token and a lease end
// GATE_LEASE_MS after the take, runs the skill's suite on the version with GATE_REPLAYS replays per case, and compares
// its pass rate with the latest run of the current version (the newest earlier version whose gate is passed or that
// has none) on the same model class. A drop past skill_improve_noise holds the version, names the cases whose pass
// rate fell and raises one owner question (alert pattern skill_version_gate, one per skill ref and version); else it
// passes. A skill with no suite passes with no run (reason no_suite); a run that gives no pass rate puts the gate back
// to pending. Every end is written only while the pass still holds its token: a late holder writes nothing and asks
// nothing. A version recorded before the gate has no row: it stays current and is never gated (no backfill). The Clock
// is injected; nothing is kept in process.

import { MODEL_CLASSES, type ModelClass } from "./model-choice.js";
import type { SkillImproveConfig } from "./skill-improve-config.js";
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
/** Pass rates are fractions: a change of exactly the noise is within it (as the improve run reads it). */
const past = (change: number, margin: number) => change > margin + 1e-9;
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
  config: Pick<SkillImproveConfig, "skill_improve_noise">;
  wiring: SkillGateWiring;
  signal: AbortSignal;
}

/** Why a gate ended as it did. */
export type GateReason = "no_suite" | "no_version" | "no_pass_rate" | "no_baseline" | "within_noise" | "dropped";

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
  const drop = baseline.pass_rate! - run.pass_rate;
  if (!past(drop, d.config.skill_improve_noise)) return finish("passed", run.id, { reason: "within_noise", ...scores });
  const fell = await casesThatFell(d, baseline.id, run.id);
  const result = await finish("held", run.id, { reason: "dropped", ...scores, fell });
  if (result.state === "held") {
    await heldQuestion(d, { ref_id, version, skill_ref, pass_rate: run.pass_rate, before: baseline.pass_rate!, current: current.version, model_class, fell });
  }
  return result;
}

/** Each case's pass rate in `run_id`: pass verdicts ÷ its replays. */
async function caseRates(store: Store, run_id: string): Promise<Map<string, number>> {
  const tally = new Map<string, { pass: number; all: number }>();
  for (const r of await store.listSkillEvalReplays(run_id)) {
    const t = tally.get(r.case_id) ?? { pass: 0, all: 0 };
    tally.set(r.case_id, { pass: t.pass + (r.verdict === "pass" ? 1 : 0), all: t.all + 1 });
  }
  return new Map([...tally].map(([id, t]) => [id, t.pass / t.all]));
}

/** The case IDs whose pass rate in the gate run is more than skill_improve_noise below the current version's run, in order. */
async function casesThatFell(d: SkillGateDeps, before_run: string, gate_run: string): Promise<string[]> {
  const [before, after] = await Promise.all([caseRates(d.store, before_run), caseRates(d.store, gate_run)]);
  return [...after].filter(([id, rate]) => before.has(id) && past(before.get(id)! - rate, d.config.skill_improve_noise)).map(([id]) => id).sort();
}

/** One owner question per skill ref and version (alert pattern skill_version_gate), its text scanned as UI text first. */
async function heldQuestion(
  d: SkillGateDeps, q: { ref_id: string; version: number; skill_ref: string; pass_rate: number; before: number; current: number; model_class: ModelClass; fell: readonly string[] },
): Promise<void> {
  const cases = q.fell.length > 0 ? q.fell.join(", ") : "none by itself";
  const text = `${q.skill_ref} version ${q.version} is held: its pass rate ${q.pass_rate} on ${q.model_class} fell from ${q.before} (version ${q.current}). Cases that fell: ${cases}.`;
  const detail = (await d.scanner.scan("ui", text)).clean ? text : null;
  await d.store.recordAlert({ pattern: "skill_version_gate", pattern_key: `skill_version_gate:${q.ref_id}:${q.version}`, error_code: "pass_rate_drop", count: q.version, detail }, DAY_MS);
}

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

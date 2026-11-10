// Signal sources as an extension point (design 11-signal-ledger, issue #491): each source is one
// `src/controller/signals/<name>.signal.ts`, found by discovery, naming the kinds it writes and reading its records
// through the controller's read-only store accessors. The `signals` unit writes one ledger row per record; a new
// source needs no change to the unit. Pure: the kernel discovers the files through the runtime registry.

import type { ControllerReader } from "../units/kernel.js";

/** The store reads a source may use: each one across items, oldest first, from `since` (null: every record). */
export type SignalReader = Pick<ControllerReader, "listStateChangesSince" | "listVerdictsSince" | "listRunsFinishedSince">;

type WorkItemId = Awaited<ReturnType<SignalReader["listVerdictsSince"]>>[number]["work_item_id"];
/** An ISO-8601 UTC time, as the store keeps it. */
export type SignalTime = NonNullable<Parameters<SignalReader["listVerdictsSince"]>[0]>;

/** One record a source read, as its ledger row needs it: IDs, enum codes and a time, never text. */
export interface SignalRecord {
  /** The source record's key, unique within the source: a state change, verdict or run ID, or `<run>:<finding>`. */
  readonly source_ref: string;
  /** One of the source's `kinds`. */
  readonly kind: string;
  readonly work_item_id: WorkItemId;
  /** The run kind's role (`roleOfRun`) for a run-related signal; null otherwise. */
  readonly role: Role | null;
  /** The source record's own time. */
  readonly at: SignalTime;
}

export interface SignalDescriptor {
  readonly kind: "signal";
  /** The ledger's `source` column; snake_case, unique among sources. */
  readonly name: string;
  /** Every kind code the source writes (a fixed list): a record of another kind is not written. */
  readonly kinds: readonly string[];
  read(r: SignalReader, since: SignalTime | null): Promise<readonly SignalRecord[]>;
}

/** The roles a signal names: the run kinds that have a role (src/worker/roles/). A fixed list. */
export const ROLES = ["triage", "implement", "review", "resolve"] as const;
export type Role = (typeof ROLES)[number];

/** The role of a run of `kind`, or null for a run kind with none (update, manual, interactive, ...). */
export function roleOfRun(kind: string): Role | null {
  return (ROLES as readonly string[]).includes(kind) ? (kind as Role) : null;
}

/** The state change reason of a standing rule's approval (core/standing STANDING_APPROVED); its detail names the rule. */
export const STANDING_APPROVED = "standing_approved";

const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

/** Why the source breaks its shape, or []. */
export function signalProblems(s: Omit<SignalDescriptor, "kind">): string[] {
  const out: string[] = [];
  if (!CODE.test(s.name)) out.push(`signal source "${s.name}" must be snake_case`);
  if (s.kinds.length === 0) out.push(`${s.name}: names no kind`);
  for (const k of s.kinds) if (!CODE.test(k)) out.push(`${s.name}: kind "${k}" must be snake_case`);
  if (new Set(s.kinds).size !== s.kinds.length) out.push(`${s.name}: lists a kind twice`);
  return out;
}

export function defineSignal(s: Omit<SignalDescriptor, "kind">): SignalDescriptor {
  const problems = signalProblems(s);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return { kind: "signal", ...s };
}

/** The discovered sources, in path order; two sources of one name fail (the ledger's `source` column keys them). */
export function uniqueSignals(found: readonly SignalDescriptor[]): SignalDescriptor[] {
  const seen = new Set<string>();
  for (const s of found) {
    if (seen.has(s.name)) throw new Error(`signal source "${s.name}" is defined twice`);
    seen.add(s.name);
  }
  return [...found];
}

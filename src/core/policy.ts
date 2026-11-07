import type { FactoryConfig } from "./config.js";
import type { Floor } from "./settings.js";
import type { Run, RunKind, RunOutcome, Tier, WorkItem } from "./types.js";

// Deterministic gate rules (control plane). Same input, same output.

/** Highest floor tier among the floors the allowed paths touch (either path contains the other). */
export function floorTier(paths: readonly string[], floors: readonly Floor[]): Tier | null {
  let tier: Tier | null = null;
  for (const f of floors) {
    const hit = paths.some((p) => p.startsWith(f.prefix) || f.prefix.startsWith(p.replace(/\*+$/, "")));
    if (hit && (tier === null || f.tier > tier)) tier = f.tier;
  }
  return tier;
}

/** Tier = max(agent judgment, floor, previous). Never lowered (design §3). */
export function effectiveTier(...tiers: (Tier | null | undefined)[]): Tier {
  return tiers.reduce<Tier>((max, t) => (t != null && t > max ? t : max), 1);
}

export function needsSpecApproval(tier: Tier, dials: FactoryConfig["dials"]): boolean {
  return tier >= dials.spec_gate_min_tier;
}

/** Never for an incomplete PR, one whose implementer reports missing work (issue #229), whatever its tier. */
export function canAutoMerge(tier: Tier, dials: FactoryConfig["dials"], incomplete = false): boolean {
  return !incomplete && tier <= dials.auto_merge_max_tier;
}

/** One run per (item, kind, loop, restart): re-enqueueing the same step is a no-op. */
export function runKey(item: Pick<WorkItem, "id" | "loop_count" | "restart_count">, kind: RunKind): string {
  return `${item.id}:${kind}:l${item.loop_count}:r${item.restart_count}`;
}

/**
 * The key of the automatic retry of the run with key `key`: the step's first key plus `:a<n>`, n counting
 * the retries of that step. Derived from the failed run alone, so applying it twice asks for the same key.
 */
export function retryKey(key: string): string {
  const m = key.match(/^(.*):a(\d+)$/);
  return m ? `${m[1]}:a${Number(m[2]) + 1}` : `${key}:a1`;
}

/** Whether two run keys belong to the same step (the same first run and its automatic retries). */
export function sameStep(a: string, b: string): boolean {
  return stepKey(a) === stepKey(b);
}

function stepKey(key: string): string {
  return key.replace(/:a\d+$/, "");
}

/** Wait before retry number `attempt` (1 = first retry): base × 2^(attempt−1), never more than max. */
export function retryDelayMs(attempt: number, base_ms: number, max_ms: number): number {
  return Math.min(max_ms, base_ms * 2 ** Math.max(0, attempt - 1));
}

/**
 * Why a run failed, for the retry budget (design §5 Restarts): a usage or rate limit is not an attempt, and
 * neither is a stall (the model printed nothing for `stall_ms`); a pre-push check whose failing test files
 * also fail on the base branch (`checks_env`) spends neither budget and has its own cap, CHECKS_ENV_LIMIT per
 * item; infra failures (lease loss, timeout, exception) count toward `max_restart`; anything else is the
 * task's own failure and counts toward `max_attempts`. A run with no outcome (cancelled) is a task failure.
 */
export type FailureClass = "rate_limited" | "stalled" | "checks_env" | "infra" | "task";

export function failureClass(outcome: RunOutcome | null): FailureClass {
  if (outcome?.status !== "failed") return "task";
  if (outcome.error_code === RATE_LIMITED) return "rate_limited";
  if (outcome.error_code === AGENT_STALLED) return "stalled";
  if (outcome.error_code === CHECKS_ENV) return "checks_env";
  return outcome.infra ? "infra" : "task";
}

/**
 * The error code of a run whose agent printed nothing for `stall_ms` while no tool call was open (design §5
 * Restarts). Not an attempt; it pauses every claim (`model_stall`) until a probe on the cheap model answers.
 */
export const AGENT_STALLED = "agent_stalled";

/**
 * The claim pause of a stall (design §5 Restarts): its row holds the next probe time, and claims stay paused
 * past it until a probe answers (`MODEL_ANSWERED`). `MODEL_STALL_SINCE` reads when the pause began.
 */
export const MODEL_STALL = "model_stall" as const;
export const MODEL_STALL_SINCE = "model_stall_since" as const;
/** The time of the last probe that got an answer: it ends a stall pause whose probe time it is not before. */
export const MODEL_ANSWERED = "model_answered" as const;

/**
 * The error code of an implement run whose pre-push check failed twice and whose failing test files fail the
 * same way on a clean checkout of the base commit (design §5 Restarts, decided 2026-11-07): the environment's
 * fault (a timeout under load, a broken base), not the branch's. Its own failure class; nothing is pushed.
 */
export const CHECKS_ENV = "checks_env";

/** The `checks_env` runs an item is requeued for, counted over its whole run history; the next one blocks it. */
export const CHECKS_ENV_LIMIT = 2;

/** The error code of a run stopped by a usage or rate limit. */
export const RATE_LIMITED = "rate_limited";

/**
 * The error code of a forge 401 or 403 (preflight, push or PR). A task failure; it also pauses implement-type
 * claims for every worker (the `forge_auth` claim pause, design §5 Restarts), and its retry waits for the pause.
 */
export const FORGE_AUTH = "forge_auth";

/** The error code of a failed implement preflight check; the detail starts with the check's name. */
export const PREFLIGHT_FAILED = "preflight_failed";

/**
 * The error code of a failed push_access or pr_api preflight check that is not a 401/403 (decided 2026-11-07,
 * issue #216): a revoked permission or a forge that does not answer fails every implement run the same way. A
 * task failure; like `forge_auth` it pauses implement-type claims for every worker, in its own claim pause row
 * (`preflight_access`), and its retry waits for the pause. The detail starts with the check's name.
 */
export const PREFLIGHT_ACCESS = "preflight_access";

/**
 * The error code of a run whose git call, push, forge preflight or model request could not reach its host: a DNS
 * or connect error (design §5 Restarts, network pause). Not a failure of the run at all: the worker puts the run
 * back in the queue with its attempt unchanged and starts the `network` claim pause, so it never counts toward
 * max_restart or max_attempts and never reaches the repeated-failure rule. The detail names the host only.
 */
export const NETWORK_UNAVAILABLE = "network_unavailable";

/**
 * The claim pause of a dead network (design §5 Restarts), a probe pause like `model_stall`: its row holds the next
 * probe time, claims of every kind stay paused past it until a probe passes. `NETWORK_SINCE` reads when it began.
 */
export const NETWORK = "network" as const;
export const NETWORK_SINCE = "network_since" as const;
/** When the last network probe passed (or the pause was ended by hand): ends a network pause not after it. */
export const NETWORK_ANSWERED = "network_answered" as const;

/**
 * The claim pauses that end when a probe passes, not at a time, with their two helper rows: when the pause began
 * and when it was last answered. One store code path and one controller probe step serve both.
 */
export const PROBE_PAUSES = {
  [MODEL_STALL]: { since: MODEL_STALL_SINCE, answered: MODEL_ANSWERED },
  [NETWORK]: { since: NETWORK_SINCE, answered: NETWORK_ANSWERED },
} as const;
export type ProbePause = keyof typeof PROBE_PAUSES;

/** The probe pause `name` is, or helps (its since or answered row); null for any other claim pause. */
export function probePauseOf(name: string): ProbePause | null {
  for (const [pause, rows] of Object.entries(PROBE_PAUSES)) {
    if (name === pause || name === rows.since || name === rows.answered) return pause as ProbePause;
  }
  return null;
}

/** The network probe's first wait and its longest one (design §5 Restarts): 30 s, backing off to 5 min. */
export const NETWORK_PROBE_MS = { first: 30_000, max: 300_000 } as const;

/**
 * The wait before the next network probe after a failed one, `elapsed_ms` into the pause: retryDelayMs with the
 * probes made so far as the attempt, so the waits run 30 s, 30 s, 1 min, 2 min, 4 min, then 5 min each.
 */
export function networkProbeDelayMs(elapsed_ms: number): number {
  const probes = Math.floor(Math.log2(Math.max(1, elapsed_ms / NETWORK_PROBE_MS.first))) + 1;
  return retryDelayMs(probes, NETWORK_PROBE_MS.first, NETWORK_PROBE_MS.max);
}

/** The error codes a DNS or connect error turns into NETWORK_UNAVAILABLE; any other code keeps its own. */
const NETWORK_PRONE_CODES: readonly string[] = ["git_failed", "push_failed", PREFLIGHT_FAILED, PREFLIGHT_ACCESS, "exception"];

/** git's, curl's, ssh's and Node's words for a host that cannot be found or connected to; group 1 the host, if named. */
const UNREACHABLE: readonly RegExp[] = [
  /Could not resolve hostname\s+([\w.-]+)/i,
  /Could not resolve host:?\s*'?([\w.-]+)/i,
  /getaddrinfo\s+(?:ENOTFOUND|EAI_AGAIN)\s+([\w.-]+)/,
  /Failed to connect to\s+([\w.-]+)/i,
  /connect\s+(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT)\s+([\w.:[\]-]+)/,
  /unable to access '[a-z]+:\/\/(?:[^@/'\s]*@)?([\w.-]+)[^']*':\s*(?:Could not resolve|Failed to connect|Connection refused|Connection timed out|Network is unreachable|No route to host)/i,
  /Temporary failure in name resolution|Name or service not known|nodename nor servname provided|Network is unreachable|No route to host/i,
];

/**
 * The host a DNS or connect error names, or `unknown host` when it names none; null when `text` is not such an
 * error. Only the host is returned, never the rest of the text (it may hold a URL with a credential).
 */
export function unreachableHost(text: string): string | null {
  for (const re of UNREACHABLE) {
    const m = re.exec(text);
    if (m) return m[1] ?? "unknown host";
  }
  return null;
}

/** The detail of a NETWORK_UNAVAILABLE failure: the host only. */
export function networkDetail(host: string): string {
  return `could not reach ${host}`;
}

/**
 * A failure's code and detail with a DNS or connect error from git (fetch, push), the sandbox or the forge
 * preflight turned into NETWORK_UNAVAILABLE with the host as its detail. Every other failure, and every other
 * code (a rejected push, a git error that is not the network), comes back as it was.
 */
export function classifyNetwork(code: string, detail: string): { code: string; detail: string } {
  if (code === NETWORK_UNAVAILABLE) return { code, detail };
  const host = NETWORK_PRONE_CODES.includes(code) ? unreachableHost(detail) : null;
  return host === null ? { code, detail } : { code: NETWORK_UNAVAILABLE, detail: networkDetail(host) };
}

/** The error codes whose failure pauses implement-type claims, each in the claim pause row of the same name. */
export const IMPLEMENT_PAUSE_CODES = [FORGE_AUTH, PREFLIGHT_ACCESS] as const;

/** The implement preflight's checks, in order. Each failure's detail starts with `<check>: `. */
export const PREFLIGHT_CHECKS = ["push_access", "pr_api", "base_fetch"] as const;

/** The preflight check a failure's detail names (its `<check>: ` prefix); null when it names none. */
export function preflightCheck(detail: string): (typeof PREFLIGHT_CHECKS)[number] | null {
  const name = detail.split(":")[0]?.trim() ?? "";
  return (PREFLIGHT_CHECKS as readonly string[]).includes(name) ? (name as (typeof PREFLIGHT_CHECKS)[number]) : null;
}

/**
 * Implement failure codes never retried automatically (design §5 Restarts, decided 2026-11-02): the same spec
 * fails the same way. The item blocks on a human with `run_failed:implement:<code>`; `/retry` or `/revise` go on.
 */
export const NO_AUTO_RETRY: readonly string[] = ["no_commits", "scope_violation", "egress_blocked", "diff_too_large"];

/**
 * The block of an item whose implement, review or resolve run returned needs_human (decided 2026-11-07): the
 * agent hit something it cannot fix and asked the owner. Blocked on a human; no automatic retry.
 */
export const AGENT_NEEDS_HUMAN = "agent_needs_human";

/**
 * The block after two task failures in a row in one step with the same error code and the same detail line
 * (decided 2026-11-07): a third run would fail the same way. `/retry` starts the step with a fresh budget. Also
 * the block after two fast identical infra failures in a row (`repeatsFastInfraFailure`, issue #216).
 */
export const REPEATED_FAILURE = "repeated_failure";

/**
 * How long a run may take and still count as failing "at once" for the repeated infra failure rule (decided
 * 2026-11-07, issue #216): an infra failure that repeats within this of starting is not a passing hiccup.
 */
export const FAST_FAILURE_MS = 60_000;

/** The longest detail line the repeated-failure rule compares. */
export const FAILURE_LINE_CHARS = 200;

/** The part of a failure's detail the repeated-failure rule compares: its first line, up to 200 characters. */
export function failureLine(detail: string): string {
  return (detail.split(/\r?\n/)[0] ?? "").trim().slice(0, FAILURE_LINE_CHARS);
}

/**
 * Whether `run`, a task failure, repeats the step's previous task failure: same error code, same detail line.
 * `step`: the step's runs in order (the first run and its automatic retries), `run` among them. Rate limits,
 * stalls and infra failures are not attempts, so they are skipped, neither counted nor breaking the row.
 */
export function repeatsLastFailure(step: readonly Pick<Run, "id" | "outcome">[], run: Pick<Run, "id" | "outcome">): boolean {
  const o = run.outcome;
  // A preflight_access failure pauses implement claims instead (issue #216): its retry waits, it never blocks.
  if (o?.status !== "failed" || failureClass(o) !== "task" || o.error_code === PREFLIGHT_ACCESS) return false;
  const before = step.slice(0, Math.max(0, step.findIndex((r) => r.id === run.id)));
  const prev = before.filter((r) => failureClass(r.outcome) === "task" && r.outcome !== null).at(-1)?.outcome;
  return prev?.status === "failed" && prev.error_code === o.error_code && failureLine(prev.detail) === failureLine(o.detail);
}

/**
 * Whether `run`, an infra failure, repeats the step's previous run at once (decided 2026-11-07, issue #216): the
 * run just before it in the step also failed as infra with the same error code and the same detail, and both
 * finished within FAST_FAILURE_MS of their start. Task failures, rate limits, stalls and `preflight_access` never
 * match; a run with no start or finish time, or with an empty detail, is not compared. `step`: the step's runs in order, `run` among them.
 */
export function repeatsFastInfraFailure(
  step: readonly Pick<Run, "id" | "outcome" | "started_at" | "finished_at">[],
  run: Pick<Run, "id" | "outcome" | "started_at" | "finished_at">,
): boolean {
  const infra = (r: Pick<Run, "outcome">) =>
    r.outcome?.status === "failed" && failureClass(r.outcome) === "infra" && r.outcome.error_code !== PREFLIGHT_ACCESS ? r.outcome : null;
  const fast = (r: Pick<Run, "started_at" | "finished_at">) => {
    const took = Date.parse(r.finished_at ?? "") - Date.parse(r.started_at ?? "");
    return Number.isFinite(took) && took < FAST_FAILURE_MS;
  };
  const o = infra(run);
  const i = step.findIndex((r) => r.id === run.id);
  const prevRun = i > 0 ? step[i - 1]! : undefined;
  const prev = prevRun ? infra(prevRun) : null;
  // An empty detail says nothing about the cause, so two of them are not "the same failure".
  const same = o !== null && prev !== null && prev.error_code === o.error_code && o.detail.trim() !== "" && prev.detail.trim() === o.detail.trim();
  return same && fast(prevRun!) && fast(run);
}

/**
 * The kind of run behind an `agent_needs_human` or `repeated_failure` block, from the item's runs (oldest
 * first): the latest run that asked for a human, or the latest failed run. The item's fields cannot tell a
 * resolve block from an implement block. Undefined for any other block, or when no such run is found.
 */
export function blockingRunKind(blockedReason: string | null, runs: readonly Pick<Run, "kind" | "outcome">[]): RunKind | undefined {
  const asked = (r: Pick<Run, "outcome">) => r.outcome?.status === "succeeded" && r.outcome.data.needs_human != null;
  if (blockedReason === AGENT_NEEDS_HUMAN) return runs.filter(asked).at(-1)?.kind;
  if (blockedReason === REPEATED_FAILURE) return runs.filter((r) => r.outcome?.status === "failed").at(-1)?.kind;
  return undefined;
}

/** The forge branch that keeps a failed implement run's commits: under the branch prefix, one per run. */
export function wipBranchFor(item: Pick<WorkItem, "id">, prefix: string, runId: string): string {
  return `${prefix}wip/${item.id}/${runId}`;
}

/** The item's PR branch: an adopted PR's own head branch, else the factory branch `${prefix}${id}`. */
export function branchFor(item: Pick<WorkItem, "id"> & Partial<Pick<WorkItem, "head_branch">>, prefix: string): string {
  return item.head_branch ?? `${prefix}${item.id}`;
}

/**
 * The label that keeps a pull request a person opened out of the factory (design 2026-11-01). It counts only
 * when the person who added it has write permission (`approve_spec`), and only before adoption.
 */
export const SKIP_LABEL = "factory: skip";

export function workItemIdFromBranch(branch: string, prefix: string): string | null {
  return branch.startsWith(prefix) ? branch.slice(prefix.length) : null;
}

/**
 * A path is covered when it equals an allowed path, or sits under an allowed path that ends in `/`.
 * Shared by triage validation (`files_to_change`) and the pre-push scope gate, so both use one rule.
 */
export function isCovered(path: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => path === a || (a.endsWith("/") && path.startsWith(a)));
}

/**
 * Run kinds that change an item's branch: implement (a first build and every review fix) and update.
 * An item never has two of these running at once (they push to the same branch); triage and review are never held back.
 */
export const IMPLEMENT_KINDS: readonly RunKind[] = ["implement", "update"];

/** A person's session (design §5, 2026-11-01): writes the item's branch like IMPLEMENT_KINDS, never claimed by a worker. */
export const INTERACTIVE: RunKind = "interactive";
/** Session error codes: `session abandon`, and the reaper's on an expired session lease (never requeued). */
export const SESSION_ABANDONED = "abandoned";
export const SESSION_LOST = "session_lost";
/** The blocked reason of an item whose session ended without a PR: RUNNING, blocked on a human, nothing queued. */
export const SESSION_RELEASED = "session_released";

/** The paths two lists share by the scope gate's coverage rule (as the coordination cost's shared paths). */
export function pathsOverlap(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  for (const x of a) for (const y of b) if (x === y || isCovered(y, [x])) out.add(y); else if (isCovered(x, [y])) out.add(x);
  return [...out].sort();
}

/**
 * Scope gate (design §4): given the NUL-separated output of
 * `git diff --name-only -z --no-renames <base>...HEAD` and the item's allowed_paths, returns every changed
 * path that no allowed path covers, sorted and without duplicates. Empty means the branch may be pushed.
 * `conflicts`: the files the base merge conflicted in (both sides changed them). They pass whatever
 * allowed_paths says (decision changed 2026-11-02): the base's side of a conflict is not the item's doing.
 * With `--no-renames` a rename shows as a delete of the old path plus an add of the new one, so both are checked.
 */
export function scopeViolations(nameOnlyZ: string, allowed: readonly string[], conflicts: readonly string[] = []): string[] {
  const changed = new Set(nameOnlyZ.split("\0").filter((p) => p.length > 0));
  const conflicting = new Set(conflicts);
  return [...changed].filter((p) => !conflicting.has(p) && !isCovered(p, allowed)).sort();
}

/**
 * Automatic resolve runs per base commit (design §5 Merge conflict, decided 2026-11-02). A constant, not a
 * config key. A human `/resolve` does not count toward it.
 */
export const AUTO_RESOLVE_LIMIT = 2;

const AUTO_RESOLVE_KEY = /^(.+):resolve:auto:([^:]+):(\d+)$/;

/** The run key of automatic resolve number `attempt` (1-based) of item `id` for base commit `baseSha`. */
export function autoResolveKey(id: string, baseSha: string, attempt: number): string {
  return `${id}:resolve:auto:${baseSha}:${attempt}`;
}

/** The parts of an automatic resolve key; null for any other key (a human `/resolve`, another kind). */
export function parseAutoResolveKey(key: string): { work_item_id: string; base_sha: string; attempt: number } | null {
  const m = AUTO_RESOLVE_KEY.exec(key);
  if (!m) return null;
  const attempt = Number(m[3]);
  return attempt >= 1 ? { work_item_id: m[1]!, base_sha: m[2]!, attempt } : null;
}

/** How many automatic resolve runs of item `id` for base commit `baseSha` the keys hold (distinct keys). */
export function autoResolveAttempts(keys: readonly string[], id: string, baseSha: string): number {
  return new Set(keys.filter((k) => {
    const p = parseAutoResolveKey(k);
    return p !== null && p.work_item_id === id && p.base_sha === baseSha;
  })).size;
}

/** The number of the next automatic resolve after `done` of them for one base commit; null at the limit. */
export function nextAutoResolveAttempt(done: number): number | null {
  return done < AUTO_RESOLVE_LIMIT ? done + 1 : null;
}

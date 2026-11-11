// The improve run (design §7, issues #306, #307, #308, #571): a daily look back at failed runs and the owner's pushbacks,
// no agent. The project's failed runs in a window are grouped by error code and normalized detail, its pushbacks by their
// normalized words (code `pushback`); each group of 2+ gets one plain model call (no tools) for a draft; one report is stored for the learner (learnFromReport); the controller files its groups (fileReport).
export { learnFromReport } from "./learned-settings.js";
export { NO_SCORER, type Grade, type GradeSubject, type Scorer, improvePrompts, scoreRun, scorerFor } from "./scorer.js";

import { cyrb53 } from "./hash.js";
import { parseJson } from "./scorer.js";
import { PROTECTED_PATHS } from "./standing.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../interfaces/llm-provider.js";
import type { IssueInput } from "../interfaces/source-adapter.js";
import { type SharedStorage, readRange } from "../interfaces/shared-storage.js";
import type {
  Actor, FailureGroup, FiledPattern, ImproveDraft, ImproveFiling, ImproveReport, ImproveTail, ImproveWindow, Run, RunId, SourceRef,
  Timestamp, UserId, WorkItem, WorkItemId,
} from "./types.js";

/** Who queues improve runs and owns the system work items. */
export const IMPROVER: Actor = { kind: "system", id: "system:improver" };
/**
 * The system work item's hold (design §7): `NEW`, `blocked_on: upstream` with this reason, for good. It only
 * carries its project's improve runs, so nothing triages, implements or releases it.
 */
export const SYSTEM_ITEM = "system_item";
/** Characters of a normalized detail kept as a group's key. */
const DETAIL_CHARS = 200;
const DAY_MS = 86_400_000;

type ImproveStore = Pick<FactoryStore, "createWorkItem" | "enqueueRun">;

/** The one system work item of `project`: a local source, unique per project, so intake never makes a second. */
export function systemSource(project: string): SourceRef {
  return { type: "local", id: `system:improve:${project}`, link: "" };
}

/** The UTC calendar day of `at`, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** The daily run's key: one per project and UTC day, so a second tick that day queues nothing. */
export function dailyImproveKey(project: string, day: string): string {
  return `improve:${project}:daily:${day}`;
}

/** A manual run's key (`factory improve`): its own time, never a day's slot. */
export function manualImproveKey(project: string, at: Date): string {
  return `improve:${project}:manual:${at.toISOString()}`;
}

/** The daily run of `day` reports the day before it, the last full UTC day: [day - 1 00:00, day 00:00). */
export function dailyWindow(day: string): ImproveWindow {
  const end = Date.parse(`${day}T00:00:00.000Z`);
  return { window_start: new Date(end - DAY_MS).toISOString() as Timestamp, window_end: new Date(end).toISOString() as Timestamp };
}

/** A manual run reports the 24 hours before it was queued. */
export function manualWindow(at: Date): ImproveWindow {
  return { window_start: new Date(at.getTime() - DAY_MS).toISOString() as Timestamp, window_end: at.toISOString() as Timestamp };
}

/**
 * A trigger run's key (design §7): one per last improve run of the project (`none` before the first), so every
 * replica that sees the same failures in the same state writes the same key and the store keeps one run.
 */
export function triggerImproveKey(project: string, after: RunId | null): string {
  return `improve:${project}:trigger:${after ?? "none"}`;
}

/** A trigger run: queued after the improve run `after` (null: none yet), reporting from `since` to now. */
export interface ImproveTriggerInput {
  after: RunId | null;
  since: Timestamp;
}

/**
 * Queues one improve run on the project's system work item (made on first use). `daily`: the current UTC day's
 * slot, a no-op when it is already queued. `manual`: a run of its own. A trigger (`ImproveTriggerInput`): the
 * slot after the last improve run, reporting the failures since it. The window goes into the run's input.
 */
export async function enqueueImprove(
  d: { store: ImproveStore; clock: Clock },
  project: string,
  trigger: "daily" | "manual" | ImproveTriggerInput,
): Promise<{ run: Run; created: boolean }> {
  const now = d.clock.now();
  const { item } = await d.store.createWorkItem(
    {
      source: systemSource(project),
      title: "Factory improve runs",
      requester_id: IMPROVER.id as UserId,
      project,
      problem: "The system work item that carries this project's improve runs (design §7). Nothing implements it.",
      resources: [],
      hold: { blocked_on: "upstream", blocked_reason: SYSTEM_ITEM },
    },
    IMPROVER,
  );
  const [idempotency_key, improve] =
    trigger === "daily" ? [dailyImproveKey(project, utcDay(now)), dailyWindow(utcDay(now))]
    : trigger === "manual" ? [manualImproveKey(project, now), manualWindow(now)]
    : [triggerImproveKey(project, trigger.after), { window_start: trigger.since, window_end: now.toISOString() as Timestamp }];
  return d.store.enqueueRun({ work_item_id: item.id, kind: "improve", idempotency_key, input: { improve } });
}

/** Unreviewed failed runs in the last TRIGGER_WINDOW_MS that queue an improve run (design §7): a burst worth a report now. */
export const TRIGGER_FAILURES = 10;
/** The window the failure count looks back over (design §7, issue #514). */
export const TRIGGER_WINDOW_MS = DAY_MS;
/** An unreviewed failure this old queues an improve run (design §7): a lone failure is not left unseen for long. */
export const TRIGGER_AGE_MS = 3 * DAY_MS;

/** Why the trigger fires: TRIGGER_FAILURES failures in the last TRIGGER_WINDOW_MS, or a failure older than TRIGGER_AGE_MS. */
export type TriggerReason = { reason: "count"; failures: number } | { reason: "age"; oldest: Timestamp };

/** A failed run an improve report counts: the same runs groupFailures groups. */
function reviewable(r: Run): boolean {
  return r.kind !== "improve" && r.status === "failed" && r.outcome?.status === "failed";
}

/**
 * The trigger rule (design §7), pure: given the project's unreviewed runs (finished since its last improve run
 * was queued), whether an improve run is due. Counts the failed runs of any kind that finished in the last
 * TRIGGER_WINDOW_MS against TRIGGER_FAILURES, then the oldest failure's age against TRIGGER_AGE_MS. Null: not due.
 */
export function improveTriggerDue(runs: readonly Run[], now: Date): TriggerReason | null {
  const finished = runs.filter(reviewable).map((r) => r.finished_at).filter((t): t is Timestamp => t !== null).sort();
  const failures = finished.filter((t) => now.getTime() - Date.parse(t) <= TRIGGER_WINDOW_MS).length;
  if (failures >= TRIGGER_FAILURES) return { reason: "count", failures };
  const oldest = finished[0];
  return oldest !== undefined && now.getTime() - Date.parse(oldest) > TRIGGER_AGE_MS ? { reason: "age", oldest } : null;
}

type TriggerStore = ImproveStore & Pick<FactoryStore, "getWorkItemBySource" | "listRuns" | "listRunsFinishedBetween" | "getWorkItem">;

/** The improve runs of `project` (its system work item's), oldest first. */
export async function listImproveRuns(store: Pick<FactoryStore, "getWorkItemBySource" | "listRuns">, project: string): Promise<Run[]> {
  const src = systemSource(project);
  const item = await store.getWorkItemBySource(src.type, src.id);
  return item ? (await store.listRuns(item.id)).filter((r) => r.kind === "improve") : [];
}

const isPending = (r: Run) => r.status === "queued" || r.status === "running";

/** An improve run of `project` that is queued or running, or null: while one is, no other is started. */
export async function pendingImprove(store: Pick<FactoryStore, "getWorkItemBySource" | "listRuns">, project: string): Promise<Run | null> {
  return (await listImproveRuns(store, project)).find(isPending) ?? null;
}

/**
 * The trigger step (design §7): reads the project's failed runs finished since its last improve run was queued (all
 * before the first), applies improveTriggerDue, and queues one run with triggerImproveKey when due; none while one is
 * queued or running. Its dedupe is store state: two replicas read the same last run and write the same key, and
 * enqueueRun's conditional insert on that unique key keeps one run. `factory improve` queues through enqueueImprove too.
 */
export async function triggerImprove(
  d: { store: TriggerStore; clock: Clock },
  project: string,
): Promise<{ run: Run; created: boolean; why: TriggerReason } | null> {
  const improves = await listImproveRuns(d.store, project);
  if (improves.some(isPending)) return null;
  const last = improves.at(-1) ?? null;
  const now = d.clock.now();
  const finished = await d.store.listRunsFinishedBetween(last?.created_at ?? (new Date(0).toISOString() as Timestamp), now.toISOString() as Timestamp);
  const mine = await ofProject(d.store, finished.filter(reviewable), project);
  const why = improveTriggerDue(mine, now);
  if (!why) return null;
  const since = last?.created_at ?? mine.map((r) => r.finished_at!).sort()[0]!;
  return { ...(await enqueueImprove(d, project, { after: last?.id ?? null, since })), why };
}

/** The runs of `project`'s work items, in order: one item read per work item (design §7, reports are per project). */
async function ofProject(store: Pick<FactoryStore, "getWorkItem">, runs: readonly Run[], project: string): Promise<Run[]> {
  const projects = new Map<WorkItemId, string | null>();
  for (const r of runs) if (!projects.has(r.work_item_id)) projects.set(r.work_item_id, (await store.getWorkItem(r.work_item_id))?.project ?? null);
  return runs.filter((r) => projects.get(r.work_item_id) === project);
}

/**
 * A failure detail as a group key: lower case, every run of digits as `#` (counts, line numbers, ports, times,
 * shas' digit runs), hex ids of 7 or more characters as `<id>`, whitespace collapsed, cut to 200 characters.
 */
export function normalizeDetail(detail: string): string {
  return detail
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,}\b/g, "<id>")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DETAIL_CHARS);
}

/** A pushback group's error code: the owner pushed back on a run's output with these words (issue #571). */
export const PUSHBACK = "pushback";
/** The state changes whose `spec_feedback` is a pushback: a `/reject` and a `/revise`. */
const PUSHBACK_REASONS: readonly string[] = ["spec_rejected", "spec_revision_requested"];

/** One pushback as the improver counts it: the owner's words on the run whose output they answered. */
export interface Pushback {
  run_id: RunId;
  work_item_id: WorkItemId;
  text: string;
  at: Timestamp;
}

/**
 * Groups failed runs by error code and normalized detail, and pushbacks by their normalized words under the code
 * `pushback` (each pushback counts its run once). Pure and deterministic: runs are taken in (finished_at, id) order,
 * then pushbacks in (at, run id) order; groups of two or more come first by size (largest first), then by key; one-run
 * patterns by key. Runs that did not fail, and improve runs themselves, are left out.
 */
export function groupFailures(runs: readonly Run[], pushbacks: readonly Pushback[] = []): { groups: FailureGroup[]; patterns: FailureGroup[] } {
  const failed = runs
    .filter(reviewable)
    .sort((a, b) => cmp(a.finished_at ?? "", b.finished_at ?? "") || cmp(a.id, b.id));
  const byKey = new Map<string, FailureGroup>();
  const add = (error_code: string, raw: string, run_id: RunId, work_item_id: WorkItemId) => {
    const detail = normalizeDetail(raw);
    const key = `${error_code}\n${detail}`;
    const g = byKey.get(key) ?? { error_code, detail, run_ids: [] as RunId[], work_item_ids: [] as WorkItemId[] };
    g.run_ids.push(run_id);
    if (!g.work_item_ids.includes(work_item_id)) g.work_item_ids.push(work_item_id);
    byKey.set(key, g);
  };
  for (const r of failed) {
    const outcome = r.outcome as Extract<Run["outcome"], { status: "failed" }>;
    add(outcome.error_code, outcome.detail ?? "", r.id, r.work_item_id);
  }
  for (const p of [...pushbacks].sort((a, b) => cmp(a.at, b.at) || cmp(a.run_id, b.run_id))) add(PUSHBACK, p.text, p.run_id, p.work_item_id);
  const all = [...byKey.values()].sort((a, b) => b.run_ids.length - a.run_ids.length || cmp(a.error_code, b.error_code) || cmp(a.detail, b.detail));
  return { groups: all.filter((g) => g.run_ids.length > 1), patterns: all.filter((g) => g.run_ids.length === 1) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The owner-only paths (design §7 and 03-risk): a change to any of them needs a human merge, and auto mode never
 * approves or merges one. One list, the merge check's and auto mode's: these paths, widened with every standing-rule
 * protected path (`PROTECTED_PATHS`, which holds `src/impl/grant/` and `src/core/tools/`). A path ending in `/`
 * covers everything under it; any other names one file.
 */
export const GATE_PATHS: readonly string[] = [...new Set([
  "prompts/", "src/impl/broker/", "src/impl/egress/", "src/impl/secrets/", "src/impl/sandbox/", "src/impl/auth/",
  "src/impl/github/github-auth-provider.ts", "src/impl/github/github.plugin.ts",
  "src/core/checks.ts", "src/core/policy.ts", ".claude/", "factory.config.json",
  ...Object.values(PROTECTED_PATHS).flat(),
])];

/** Repo-relative, with a leading `./` or `/` dropped. */
const repoPath = (path: string) => path.trim().replace(/^(?:\.\/|\/)+/, "");

/** Whether a repo-relative path (a leading `./` or `/` ignored) is on the gate list or under one of its folders. */
export function isGatePath(path: string): boolean {
  const p = repoPath(path);
  return GATE_PATHS.some((g) => (g.endsWith("/") ? p === g.slice(0, -1) || p.startsWith(g) : p === g));
}

/**
 * The first allowed path or changed file that touches the gate list, or null: one on it or under it, or a folder
 * (ending in `/`) that holds a gate path (`src/` holds `src/core/policy.ts`). What auto mode refuses (design 03-risk).
 */
export function gatePathTouched(paths: readonly string[]): string | null {
  for (const raw of paths) {
    const p = repoPath(raw).replace(/\*+$/, "");
    if (isGatePath(p) || ((p === "" || p.endsWith("/")) && GATE_PATHS.some((g) => g.startsWith(p)))) return raw;
  }
  return null;
}

/** At most this many model calls per improve run: the largest groups first; the rest are marked skipped. */
export const MAX_DRAFT_CALLS = 5;
/** Transcript tails per group: its latest runs. */
const MAX_TAILS = 3;
/** Bytes read from the end of each transcript. */
const TAIL_BYTES = 4_000;
/** One draft call's bound, on top of the run's signal. */
const DRAFT_TIMEOUT_MS = 120_000;
const DRAFT_MAX_TOKENS = 2_000;

/** The draft's output schema: what the model answers, nothing more. */
export const IMPROVE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["cause", "fix", "touches", "needs_person"],
  properties: {
    cause: { type: "string", minLength: 1, maxLength: 2000 },
    fix: { type: "string", minLength: 1, maxLength: 4000 },
    touches: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 300 } },
    needs_person: { type: "boolean" },
  },
};

/** The model's answer, checked against IMPROVE_SCHEMA; null when it does not fit. */
export function parseDraft(v: unknown): { cause: string; fix: string; touches: string[]; needs_person: boolean } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["cause", "fix", "touches", "needs_person"].includes(k))) return null;
  if (typeof o.needs_person !== "boolean") return null;
  const str = (x: unknown, max: number): x is string => typeof x === "string" && x.trim() !== "" && x.length <= max;
  if (!str(o.cause, 2000) || !str(o.fix, 4000)) return null;
  if (!Array.isArray(o.touches) || o.touches.length > 30 || !o.touches.every((t) => str(t, 300))) return null;
  return { cause: o.cause, fix: o.fix, touches: o.touches as string[], needs_person: o.needs_person };
}

/** What the draft step needs; without `llm` or `prompt` no model is asked and groups carry no draft. */
export interface ImproveDeps {
  store: Pick<
    FactoryStore,
    "listRunsFinishedBetween" | "recordImproveReport" | "getImproveReport" | "getWorkItem" | "listStateChangesSince" | "listVerdictsSince" | "listRuns"
  >;
  storage: SharedStorage;
  scanner: EgressScanner;
  llm?: LLMProvider;
  /** prompts/improve.md. */
  prompt?: string;
  signal?: AbortSignal;
}

/**
 * The improve run's work: the failed runs of the item's project finished inside its window and the owner's pushbacks
 * made inside it, grouped, each group drafted, stored as its one report. A run with no window in its input reports the 24 hours before it was queued.
 * Safe to run twice: a run whose report exists returns it with no model call; the report is keyed by the run.
 */
export async function runImprove(d: ImproveDeps, run: Run, item: Pick<WorkItem, "project">): Promise<ImproveReport> {
  const existing = await d.store.getImproveReport(run.id);
  if (existing) return existing;
  const window = run.input?.improve ?? manualWindow(new Date(run.created_at));
  const runs = await ofProject(d.store, await d.store.listRunsFinishedBetween(window.window_start, window.window_end), item.project);
  const pushbacks = await pushbacksIn(d, window, item.project);
  const { groups, patterns } = groupFailures(runs, pushbacks);
  const itemOf = new Map([...runs.map((r) => [r.id, r.work_item_id] as const), ...pushbacks.map((p) => [p.run_id, p.work_item_id] as const)]);
  const llm = d.llm;
  const prompt = d.prompt;
  if (llm && prompt) {
    // Groups come largest first, so the cap keeps the largest.
    for (const [i, g] of groups.entries()) {
      if (i >= MAX_DRAFT_CALLS) {
        g.draft = { status: "skipped", reason: "call_cap" };
        continue;
      }
      g.tails = [];
      const texts: { run_id: RunId; text: string }[] = [];
      for (const run_id of g.run_ids.slice(-MAX_TAILS)) {
        const t = await readTail(d, run_id, itemOf.get(run_id));
        g.tails.push(t.tail);
        if (t.text !== null) texts.push({ run_id, text: t.text });
      }
      g.draft = await draft(d, llm, prompt, g, texts);
    }
  }
  const { report } = await d.store.recordImproveReport({ run_id: run.id, project: item.project, ...window, groups, patterns });
  return report;
}

/**
 * The project's pushbacks made inside `window` (issue #571): each `/reject` and `/revise` with words (their state
 * change's `spec_feedback`) and each explicit `changes` verdict with a reason, on the item's latest run that succeeded
 * before it (the output pushed back on; none: not counted). Each text passes the G5 scan (`log`) first: a flagged one
 * is not counted. Two reads across items, then one run list per item with a pushback.
 */
async function pushbacksIn(d: ImproveDeps, window: ImproveWindow, project: string): Promise<Pushback[]> {
  const inWindow = (at: Timestamp) => at >= window.window_start && at < window.window_end;
  const said: { work_item_id: WorkItemId; text: string; at: Timestamp }[] = [];
  for (const c of await d.store.listStateChangesSince({ reasons: PUSHBACK_REASONS, since: window.window_start })) {
    const text = c.changes.spec_feedback?.to;
    if (inWindow(c.at) && typeof text === "string" && text.trim() !== "") said.push({ work_item_id: c.work_item_id, text, at: c.at });
  }
  for (const v of await d.store.listVerdictsSince(window.window_start)) {
    if (inWindow(v.at) && v.verdict === "changes" && !v.implicit && v.reason?.trim()) said.push({ work_item_id: v.work_item_id, text: v.reason, at: v.at });
  }
  const runsOf = new Map<WorkItemId, Run[] | null>();
  const out: Pushback[] = [];
  for (const s of said) {
    if (!runsOf.has(s.work_item_id)) {
      const it = await d.store.getWorkItem(s.work_item_id);
      runsOf.set(s.work_item_id, it?.project === project ? await d.store.listRuns(s.work_item_id) : null);
    }
    const run = runsOf.get(s.work_item_id)?.filter((r) => r.status === "succeeded" && r.finished_at !== null && r.finished_at <= s.at).at(-1);
    if (!run || !(await d.scanner.scan("log", s.text)).clean) continue;
    out.push({ run_id: run.id, work_item_id: s.work_item_id, text: s.text, at: s.at });
  }
  return out;
}

/** A run's stored transcript tail, scanned (G5) before anything reads it; a flagged tail keeps only its rules. */
async function readTail(d: ImproveDeps, run_id: RunId, item: WorkItemId | undefined): Promise<{ tail: ImproveTail; text: string | null }> {
  const key = `transcripts/${item}/${run_id}.json`;
  const tailOf = async () => {
    const size = item ? (await readRange(d.storage, key, 0, 0))?.size ?? 0 : 0;
    return size === 0 ? null : (await readRange(d.storage, key, Math.max(0, size - TAIL_BYTES), size))?.bytes ?? null;
  };
  // An unreadable transcript counts as missing: a storage fault fails no draft.
  const bytes = await tailOf().catch(() => null);
  if (!bytes || bytes.length === 0) return { tail: { run_id, status: "missing" }, text: null };
  const text = new TextDecoder().decode(bytes);
  const scan = await d.scanner.scan("log", text);
  if (!scan.clean) return { tail: { run_id, status: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))] }, text: null };
  return { tail: { run_id, status: "included" }, text };
}

/** One plain completion for a group: no tools, no grants, no sandbox. Its answer is checked, then scanned (G5). */
async function draft(d: ImproveDeps, llm: LLMProvider, system: string, g: FailureGroup, tails: { run_id: RunId; text: string }[]): Promise<ImproveDraft> {
  const signal = d.signal ? AbortSignal.any([d.signal, AbortSignal.timeout(DRAFT_TIMEOUT_MS)]) : AbortSignal.timeout(DRAFT_TIMEOUT_MS);
  const req: LLMRequest = {
    model_class: "standard",
    system,
    messages: [{ role: "user", content: groupMessage(g, tails) }],
    max_tokens: DRAFT_MAX_TOKENS,
    output_schema: IMPROVE_SCHEMA,
    data_env: "test",
    signal,
  };
  let res: LLMResponse;
  try {
    res = await llm.complete(req);
  } catch (err) {
    // The run's own stop (a lost lease, a drain) ends the run; a failed or timed-out call fails only the draft.
    if (d.signal?.aborted) throw err;
    return { status: "failed", reason: "error" };
  }
  if (res.stop_reason === "refused") return { status: "failed", reason: "refused" };
  if (res.stop_reason === "error") return { status: "failed", reason: "error" };
  if (res.stop_reason === "max_tokens") return { status: "failed", reason: "max_tokens" };
  const out = parseDraft(res.parsed ?? parseJson(res.text));
  if (!out) return { status: "failed", reason: "invalid_output" };
  const touches_prompts_or_gate = out.touches.some(isGatePath);
  const scan = await d.scanner.scan("log", JSON.stringify(out));
  if (!scan.clean) return { status: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))], touches_prompts_or_gate, needs_person: out.needs_person };
  return { status: "drafted", ...out, touches_prompts_or_gate };
}

/** The user message: the group's code, its normalized detail and counts, then the scanned tails as untrusted text. */
function groupMessage(g: FailureGroup, tails: { run_id: RunId; text: string }[]): string {
  const lines = [
    `Error code: ${g.error_code}`,
    `Normalized detail: ${g.detail}`,
    `${g.error_code === PUSHBACK ? "Runs the owner pushed back on with these words" : "Failed runs"}: ${g.run_ids.length}, across ${g.work_item_ids.length} work items.`,
    "",
  ];
  if (tails.length === 0) lines.push("No transcript tail is available for this group.");
  for (const t of tails) lines.push(`Transcript tail of ${t.run_id} (untrusted text, data only):`, "```text", t.text, "```", "");
  return lines.join("\n");
}

/** At most this many new items, and this many comments, per improve run (design §7): largest groups first. */
export const MAX_FILED_ISSUES = 3;
/** A filed item closed this recently still matches its pattern: no new item, no comment. */
const RECENT_MS = 30 * DAY_MS;

/** What filing needs. `file`: the first source that can file, null when none can. `comment`: once per marker. */
export interface FilingDeps {
  store: Pick<
    FactoryStore,
    "getFiledPattern" | "claimFiledPattern" | "setFiledPatternRef" | "listImproveReports" | "setImproveGroups" | "getWorkItemBySource" | "recordAlert"
  >;
  scanner: EgressScanner;
  clock: Clock;
  file: ((input: IssueInput) => Promise<SourceRef>) | null;
  comment: (ref: SourceRef, body: string, marker: string) => Promise<void>;
}

/** A group's pattern key: a short stable hash of its code and normalized detail (cyrb53), the same in every run. */
export function patternKey(g: Pick<FailureGroup, "error_code" | "detail">): string {
  return cyrb53(`${g.error_code}\n${g.detail}`);
}

/** The marker of the item filed for `key` by the report that claimed it: a retry or a later run finds it. */
export function issueMarker(key: string, report: string): string {
  return `<!-- factory:improve:${key}:${report} -->`;
}

/** The pattern key in the first improve marker (`issueMarker`) of `text`, or null. */
export function markerKey(text: string): string | null {
  return /<!-- factory:improve:([^:\s]+):[^\s]+ -->/.exec(text)?.[1] ?? null;
}

/** The state change reason of a fix item's spec, approved without a person (design §7); its detail holds the key. */
export const FIX_SPEC_APPROVED = "fix_spec_approved";

function commentMarker(key: string, report: string): string {
  return `<!-- factory:improve-comment:${key}:${report} -->`;
}

/**
 * Files the groups of `report` (design §7) and stores each group's filing on the report. A group whose pattern
 * has an open filed item gets one comment naming its runs not linked there yet (none: `linked`); one whose item
 * closed in the last 30 days is skipped; one whose draft needs a person or touches the gate list is not filed but
 * goes to Needs you as an alert with the cause (`needs_person`); any other is filed as a fix item, which runs
 * without a person, its runs listed and its marker in the body. At most MAX_FILED_ISSUES new items and as many comments; the rest are skipped with the cap as reason.
 * Every body passes the egress scan first: a flagged one is not sent and is recorded `withheld` with its rules.
 * Safe to run twice: a filing is claimed in filed_patterns before the call and its marker looked up by the source,
 * and a comment is posted once per marker.
 */
export async function fileReport(d: FilingDeps, report: ImproveReport): Promise<ImproveReport> {
  const caps = { issues: 0, comments: 0 };
  const groups: FailureGroup[] = [];
  for (const g of report.groups) {
    let filing: ImproveFiling;
    try {
      filing = await fileGroup(d, report, g, caps);
    } catch {
      // A source or store fault fails this group only; the next improve run finds the claim and tries again.
      filing = { status: "failed", reason: "error" };
    }
    groups.push({ ...g, filing });
  }
  await d.store.setImproveGroups(report.id, groups);
  return { ...report, groups };
}

async function fileGroup(d: FilingDeps, report: ImproveReport, g: FailureGroup, caps: { issues: number; comments: number }): Promise<ImproveFiling> {
  const file = d.file;
  const person = needsPerson(g.draft);
  if (!file && !person) return { status: "skipped", reason: "no_source" };
  const key = patternKey(g);
  const row = await d.store.getFiledPattern(report.project, key);
  if (row?.filed_ref && row.report_id !== report.id) {
    const item = await d.store.getWorkItemBySource(row.filed_ref.type, row.filed_ref.id);
    // An item the store does not hold (filed, not started yet) counts as open.
    if (item?.stage !== "CLOSED") return commentGroup(d, report, g, { ...row, filed_ref: row.filed_ref }, key, caps);
    if (d.clock.now().getTime() - Date.parse(item.updated_at) <= RECENT_MS) return { status: "skipped", reason: "recently_closed" };
  }
  if (row?.filed_ref && row.report_id === report.id) {
    caps.issues++;
    return { status: "filed", ref: row.filed_ref };
  }
  if (person) return toPerson(d, g, key);
  if (!file) return { status: "skipped", reason: "no_source" };
  if (caps.issues >= MAX_FILED_ISSUES) return { status: "skipped", reason: "issue_cap" };
  const title = `Recurring failure: ${g.error_code} in ${g.run_ids.length} runs`;
  const body = issueBody(g);
  const scan = await d.scanner.scan("comment", `${title}\n\n${body}`);
  if (!scan.clean) return { status: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))] };
  // A half-done claim (no item yet) is finished under its own report's marker; an item closed long ago is replaced.
  const claim = row && !row.filed_ref
    ? row
    : await d.store.claimFiledPattern({ project: report.project, pattern_key: key, error_code: g.error_code, detail: g.detail, report_id: report.id }, row?.report_id);
  if (claim.filed_ref) return { status: "linked", ref: claim.filed_ref };
  caps.issues++;
  const ref = await file({ project: report.project, requester_id: IMPROVER.id as UserId, title, body, marker: issueMarker(key, claim.report_id) });
  await d.store.setFiledPatternRef(claim.id, claim.report_id, ref);
  return { status: "filed", ref };
}

/** Whether no automatic fix may take the group: its draft says a person must decide, or its fix touches the gate list. */
function needsPerson(draft: ImproveDraft | undefined): boolean {
  return draft !== undefined && "touches_prompts_or_gate" in draft && (draft.touches_prompts_or_gate || draft.needs_person === true);
}

/**
 * A group no automatic fix may take goes to Needs you: one alert (pattern `repeated_error`, key `needs_person:<key>`)
 * whose detail names why and the draft's cause, scanned as UI text first (dropped if flagged). No item is filed,
 * so no fix run is queued. Once a day per pattern: a retry of the same report stores no second alert.
 */
async function toPerson(d: FilingDeps, g: FailureGroup, key: string): Promise<ImproveFiling> {
  const draft = g.draft as Extract<ImproveDraft, { touches_prompts_or_gate: boolean }>;
  const why = draft.needs_person ? "the draft says a person must decide" : "the fix touches the factory's prompts or gates";
  const cause = draft.status === "drafted" ? ` Draft cause (model, unverified): ${draft.cause}` : "";
  const text = `Needs a person: ${why}, so no fix item was filed.${cause}`;
  const scan = await d.scanner.scan("ui", text);
  await d.store.recordAlert(
    { pattern: "repeated_error", pattern_key: `needs_person:${key}`, error_code: g.error_code, count: g.run_ids.length, detail: scan.clean ? text : null },
    DAY_MS,
  );
  return { status: "skipped", reason: "needs_person" };
}

async function commentGroup(
  d: FilingDeps, report: ImproveReport, g: FailureGroup, row: FiledPattern & { filed_ref: SourceRef }, key: string,
  caps: { issues: number; comments: number },
): Promise<ImproveFiling> {
  const ref = row.filed_ref;
  // A run is linked once a report filed or commented it on this item. Every run of this report finished inside its
  // window, and a report that named one was made after that run finished, so the reports since window_start cover it.
  const linked = new Set<RunId>();
  for (const r of await d.store.listImproveReports(report.project, report.window_start)) {
    if (r.id === report.id) continue;
    for (const o of r.groups) {
      const f = o.filing;
      if (!f || !("ref" in f) || f.ref.type !== ref.type || f.ref.id !== ref.id) continue;
      for (const id of f.status === "commented" ? f.run_ids : f.status === "filed" ? o.run_ids : []) linked.add(id);
    }
  }
  const fresh = g.run_ids.filter((id) => !linked.has(id));
  if (fresh.length === 0) return { status: "linked", ref };
  if (caps.comments >= MAX_FILED_ISSUES) return { status: "skipped", reason: "comment_cap" };
  const body = [`This failure came back in ${fresh.length} more failed runs:`, "", ...fresh.map((id) => `- \`${id}\``)].join("\n");
  const scan = await d.scanner.scan("comment", body);
  if (!scan.clean) return { status: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))] };
  caps.comments++;
  await d.comment(ref, body, commentMarker(key, report.id));
  return { status: "commented", ref, run_ids: fresh };
}

/** The filed item's text: the pattern, its runs and items, and the draft when there is one. Never raw detail. */
function issueBody(g: FailureGroup): string {
  const pushback = g.error_code === PUSHBACK;
  const lines = [
    pushback
      ? `The factory's improve run found ${g.run_ids.length} pushbacks from the owner with the same words, across ${g.work_item_ids.length} work items.`
      : `The factory's improve run found ${g.run_ids.length} failed runs with the same error, across ${g.work_item_ids.length} work items.`,
    "",
    `- Error code: \`${g.error_code}\``,
    `- Normalized detail: ${g.detail === "" ? "(none)" : `\`${g.detail}\``}`,
    "",
    pushback ? "Runs pushed back on:" : "Failed runs:",
    ...g.run_ids.map((id) => `- \`${id}\``),
    "",
    "Work items:",
    ...g.work_item_ids.map((id) => `- \`${id}\``),
  ];
  if (g.draft?.status === "drafted") {
    lines.push("", "Draft cause (model, unverified):", "", g.draft.cause, "", "Draft fix:", "", g.draft.fix);
    if (g.draft.touches.length > 0) lines.push("", "Touches:", ...g.draft.touches.map((t) => `- \`${t}\``));
  }
  lines.push(
    "",
    "Filed as a fix: the factory triages, implements and reviews it without a person. A change that touches the factory's prompts or gates still waits for a person's merge.",
  );
  return lines.join("\n");
}

export const OUTCOME_WAIT_MS = 7 * DAY_MS; // a filed pattern's fix is judged this long after its item closed (design §7)

type OutcomeStore = Pick<FactoryStore, "listFiledPatternsWithoutOutcome" | "getWorkItemBySource" | "listStateChanges" | "listRunsFinishedBetween" | "setFiledPatternOutcome">;

/**
 * Sets the outcome of each filed pattern of `project` whose item closed as completed OUTCOME_WAIT_MS ago (design §7): `regressed`
 * when a failed run of its pattern finished in the OUTCOME_WAIT_MS after the close (the change that set CLOSED, else the item's
 * last update), else `holds`; an item open, not stored or closed otherwise gets none. Written once (no outcome yet); returns those set.
 */
export async function settleOutcomes(d: { store: OutcomeStore; clock: Clock }, project: string): Promise<FiledPattern[]> {
  const at = d.clock.now().toISOString() as Timestamp, set: FiledPattern[] = [];
  for (const p of await d.store.listFiledPatternsWithoutOutcome(project)) {
    const fix = p.filed_ref ? await d.store.getWorkItemBySource(p.filed_ref.type, p.filed_ref.id) : null;
    if (fix?.stage !== "CLOSED" || fix.close_reason !== "completed") continue;
    const closed = Date.parse((await d.store.listStateChanges(fix.id)).filter((c) => c.changes.stage?.to === "CLOSED").at(-1)?.at ?? fix.updated_at);
    if (Date.parse(at) - closed < OUTCOME_WAIT_MS) continue;
    const runs = await d.store.listRunsFinishedBetween(new Date(closed).toISOString() as Timestamp, new Date(closed + OUTCOME_WAIT_MS).toISOString() as Timestamp);
    const outcome = Object.values(groupFailures(runs)).flat().some((g) => patternKey(g) === p.pattern_key) ? "regressed" : "holds";
    if (await d.store.setFiledPatternOutcome(p.id, outcome, at)) set.push({ ...p, outcome, outcome_at: at });
  }
  return set;
}

// The improve run (design §7, issues #306, #307): a daily look back at failed runs. No agent: the failed runs of
// a window are grouped by error code and normalized detail; each group of two or more runs gets one plain model
// call (no tools) for a draft cause and fix; one report is stored. Nothing is filed or posted.

import type { FactoryStore } from "../interfaces/factory-store.js";
import type { Clock } from "../interfaces/clock.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../interfaces/llm-provider.js";
import { type SharedStorage, readRange } from "../interfaces/shared-storage.js";
import type {
  Actor, FailureGroup, ImproveDraft, ImproveReport, ImproveTail, ImproveWindow, Run, RunId, SourceRef, Timestamp, UserId, WorkItem, WorkItemId,
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
 * Queues one improve run on the project's system work item (made on first use). `daily`: the current UTC day's
 * slot, a no-op when it is already queued. `manual`: a run of its own. The window goes into the run's input.
 */
export async function enqueueImprove(
  d: { store: ImproveStore; clock: Clock },
  project: string,
  trigger: "daily" | "manual",
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
  const daily = trigger === "daily";
  return d.store.enqueueRun({
    work_item_id: item.id,
    kind: "improve",
    idempotency_key: daily ? dailyImproveKey(project, utcDay(now)) : manualImproveKey(project, now),
    input: { improve: daily ? dailyWindow(utcDay(now)) : manualWindow(now) },
  });
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

/**
 * Groups failed runs by error code and normalized detail. Pure and deterministic: runs are taken in
 * (finished_at, id) order; groups of two or more runs come first by size (largest first), then by key; one-run
 * patterns by key. Runs that did not fail, and improve runs themselves, are left out.
 */
export function groupFailures(runs: readonly Run[]): { groups: FailureGroup[]; patterns: FailureGroup[] } {
  const failed = runs
    .filter((r) => r.kind !== "improve" && r.status === "failed" && r.outcome?.status === "failed")
    .sort((a, b) => cmp(a.finished_at ?? "", b.finished_at ?? "") || cmp(a.id, b.id));
  const byKey = new Map<string, FailureGroup>();
  for (const r of failed) {
    const outcome = r.outcome as Extract<Run["outcome"], { status: "failed" }>;
    const detail = normalizeDetail(outcome.detail ?? "");
    const key = `${outcome.error_code}\n${detail}`;
    const g = byKey.get(key) ?? { error_code: outcome.error_code, detail, run_ids: [] as RunId[], work_item_ids: [] as WorkItemId[] };
    g.run_ids.push(r.id);
    if (!g.work_item_ids.includes(r.work_item_id)) g.work_item_ids.push(r.work_item_id);
    byKey.set(key, g);
  }
  const all = [...byKey.values()].sort((a, b) => b.run_ids.length - a.run_ids.length || cmp(a.error_code, b.error_code) || cmp(a.detail, b.detail));
  return { groups: all.filter((g) => g.run_ids.length > 1), patterns: all.filter((g) => g.run_ids.length === 1) };
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The owner-only paths (design §7): a change to any of them needs a human merge. One list, so the merge check can
 * reuse it. A path ending in `/` covers everything under it; any other names one file.
 */
export const GATE_PATHS: readonly string[] = [
  "prompts/", "src/impl/broker/", "src/impl/egress/", "src/impl/secrets/", "src/impl/sandbox/", "src/impl/auth/",
  "src/core/checks.ts", "src/core/policy.ts", ".claude/", "factory.config.json",
];

/** Whether a repo-relative path (a leading `./` or `/` ignored) is on the gate list or under one of its folders. */
export function isGatePath(path: string): boolean {
  const p = path.trim().replace(/^(?:\.\/|\/)+/, "");
  return GATE_PATHS.some((g) => (g.endsWith("/") ? p === g.slice(0, -1) || p.startsWith(g) : p === g));
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
  required: ["cause", "fix", "touches"],
  properties: {
    cause: { type: "string", minLength: 1, maxLength: 2000 },
    fix: { type: "string", minLength: 1, maxLength: 4000 },
    touches: { type: "array", maxItems: 30, items: { type: "string", minLength: 1, maxLength: 300 } },
  },
};

/** The model's answer, checked against IMPROVE_SCHEMA; null when it does not fit. */
export function parseDraft(v: unknown): { cause: string; fix: string; touches: string[] } | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => !["cause", "fix", "touches"].includes(k))) return null;
  const str = (x: unknown, max: number): x is string => typeof x === "string" && x.trim() !== "" && x.length <= max;
  if (!str(o.cause, 2000) || !str(o.fix, 4000)) return null;
  if (!Array.isArray(o.touches) || o.touches.length > 30 || !o.touches.every((t) => str(t, 300))) return null;
  return { cause: o.cause, fix: o.fix, touches: o.touches as string[] };
}

/** What the draft step needs; without `llm` or `prompt` no model is asked and groups carry no draft. */
export interface ImproveDeps {
  store: Pick<FactoryStore, "listRunsFinishedBetween" | "recordImproveReport" | "getImproveReport">;
  storage: SharedStorage;
  scanner: EgressScanner;
  llm?: LLMProvider;
  /** prompts/improve.md. */
  prompt?: string;
  signal?: AbortSignal;
}

/**
 * The improve run's work: the failed runs finished inside its window, grouped, each group drafted, stored as its
 * one report. A run with no window in its input (none should have one) reports the 24 hours before it was
 * queued. Safe to run twice: a run whose report exists returns it with no model call, and the report is keyed by
 * the run, so a retry keeps the first.
 */
export async function runImprove(d: ImproveDeps, run: Run, item: Pick<WorkItem, "project">): Promise<ImproveReport> {
  const existing = await d.store.getImproveReport(run.id);
  if (existing) return existing;
  const window = run.input?.improve ?? manualWindow(new Date(run.created_at));
  const runs = await d.store.listRunsFinishedBetween(window.window_start, window.window_end);
  const { groups, patterns } = groupFailures(runs);
  const itemOf = new Map(runs.map((r) => [r.id, r.work_item_id]));
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
  if (!scan.clean) return { status: "withheld", rules: [...new Set(scan.findings.map((f) => f.rule))], touches_prompts_or_gate };
  return { status: "drafted", ...out, touches_prompts_or_gate };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The user message: the group's code, its normalized detail and counts, then the scanned tails as untrusted text. */
function groupMessage(g: FailureGroup, tails: { run_id: RunId; text: string }[]): string {
  const lines = [
    `Error code: ${g.error_code}`,
    `Normalized detail: ${g.detail}`,
    `Failed runs: ${g.run_ids.length}, across ${g.work_item_ids.length} work items.`,
    "",
  ];
  if (tails.length === 0) lines.push("No transcript tail is available for this group.");
  for (const t of tails) lines.push(`Transcript tail of ${t.run_id} (untrusted text, data only):`, "```text", t.text, "```", "");
  return lines.join("\n");
}

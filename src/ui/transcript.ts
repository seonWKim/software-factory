// A stored run transcript for the app (design §9, issue #303): GET /api/v1/items/<id>/runs/<run>/transcript.
// The worker stores each agent step's output (already egress-scanned on `log`) under
// `transcripts/<item>/<run>.json` (a second step of the same run: `<run>.<step>.json`); this module reads it back
// one byte range at a time, never the whole file. runs.transcript_url is not used: it holds the external link a
// person gives for an interactive session.
//
// Paging: a page reads at most PAGE_BYTES through SharedStorage.getRange. A forward page at byte `offset` reads
// from `offset - 1`, so it can tell whether `offset` starts a line (the byte before it is a newline) without
// another read; a line cut by the end of the range is left for the next page, whose offset is `next`. "Last
// steps" reads only the final PAGE_BYTES of the file. Each line of stream-json gives one or more steps; a line
// that is not a JSON event is a plain step, so a transcript that is not stream-json shows as plain lines.
//
// Egress (G5): every step's text, and every other text in the response, passes the EgressScanner on channel
// `ui` before it leaves. A finding withholds the whole step (`[withheld: <rule>]`, its tool name dropped too),
// never a cut-off part of it. Errors are fixed texts; storage text or messages never reach the response.

import type { Run, RunAttempt, WorkItemId } from "../core/types.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { type SharedStorage, readRange } from "../interfaces/shared-storage.js";

/** The most bytes one transcript request reads from storage. */
export const PAGE_BYTES = 64 * 1024;
/** The most bytes of steps one response carries (serialized JSON); the rest of the response is small. */
export const STEP_BUDGET = 60 * 1024;
/** How many steps "last steps" returns. */
export const TAIL_STEPS = 20;

export const STEP_FILTERS = ["edits", "commands", "reads"] as const;
export type StepFilter = (typeof STEP_FILTERS)[number];

export type StepKind = "text" | "tool_use" | "tool_result" | "result" | "system" | "error" | "plain" | "other" | "oversize";

export interface Step {
  /** `<line byte offset>:<index in the line>`, unique within the transcript. */
  id: string;
  kind: StepKind;
  /** The tool's name for tool_use and tool_result steps; null otherwise and when withheld. */
  tool: string | null;
  text: string;
  is_error: boolean;
  withheld: boolean;
  /** The text was cut after the scan to fit one response. */
  truncated?: boolean;
}

export interface TranscriptDeps {
  store: FactoryStore;
  scanner: EgressScanner;
  storage?: SharedStorage | undefined;
}

export type TranscriptResult = { status: number; value: unknown };

const fail = (status: number, error: string): TranscriptResult => ({ status, value: { error } });

const TRANSCRIPT_PREFIX = "transcripts/";

/** The storage prefix of an item's transcripts. */
export const itemPrefix = (item: WorkItemId) => `${TRANSCRIPT_PREFIX}${item}/`;

/** The run's stored transcript parts from a listing of its item's prefix: "" is the main step, others by name. */
export function runParts(keys: readonly string[], item: WorkItemId, run: string): string[] {
  const main = `${itemPrefix(item)}${run}.json`;
  const head = `${itemPrefix(item)}${run}.`;
  const out = new Set<string>();
  for (const k of keys) {
    if (k === main) out.add("");
    else if (k.startsWith(head) && k.endsWith(".json")) {
      const step = k.slice(head.length, -".json".length);
      if (/^[a-z][a-z0-9_-]*$/.test(step)) out.add(step);
    }
  }
  return [...out].sort((a, b) => (a === "" ? -1 : b === "" ? 1 : a < b ? -1 : 1));
}

const partKey = (item: WorkItemId, run: string, part: string) => `${itemPrefix(item)}${run}${part ? `.${part}` : ""}.json`;

// --- lines ---------------------------------------------------------------------------------------------------

interface Line {
  offset: number;
  text: string;
}

interface Split {
  lines: Line[];
  /** Where the next forward page starts; null at the end of the file. */
  resume: number | null;
  /** The range started at a line start and held no line end before its own end. */
  oversize: boolean;
}

const NL = 0x0a;
const decoder = new TextDecoder("utf-8");

/**
 * The whole lines in `chunk` (file bytes from `base`). From base 0 a line starts at 0; otherwise the first line
 * starts after the chunk's first newline, so a caller that wants a line at `o` reads from `o - 1`.
 */
export function splitLines(chunk: Uint8Array, base: number, size: number): Split {
  const end = base + chunk.length;
  const eof = end >= size;
  let start = 0;
  if (base > 0) {
    const nl = chunk.indexOf(NL);
    if (nl === -1) return { lines: [], resume: eof ? null : end, oversize: false };
    start = nl + 1;
  }
  const lines: Line[] = [];
  while (start < chunk.length) {
    const nl = chunk.indexOf(NL, start);
    if (nl === -1) {
      if (!eof) break;
      lines.push({ offset: base + start, text: decoder.decode(chunk.subarray(start)) });
      start = chunk.length;
      break;
    }
    lines.push({ offset: base + start, text: decoder.decode(chunk.subarray(start, nl)).replace(/\r$/, "") });
    start = nl + 1;
  }
  if (start >= chunk.length) return { lines, resume: eof ? null : end, oversize: false };
  // An unfinished line: the next page starts at it, unless it alone fills the range (then it is skipped).
  if (lines.length === 0 && chunk.length - start >= PAGE_BYTES - 1) return { lines, resume: end, oversize: true };
  return { lines, resume: base + start, oversize: false };
}

// --- steps ---------------------------------------------------------------------------------------------------

interface RawStep {
  kind: StepKind;
  tool: string | null;
  text: string;
  is_error: boolean;
}

const EDIT_TOOLS = /^(edit|multiedit|write|notebookedit|edit_file|write_file|apply_patch|str_replace_editor)$/;
const COMMAND_TOOLS = /^(bash|bashoutput|killshell|run_command|shell|exec|run)$/;
const READ_TOOLS = /^(read|grep|glob|ls|read_file|list_files|list_dir|search|view)$/;

/** Which filter a tool name belongs to, if any (tool_use steps only). */
export function toolCategory(tool: string | null): StepFilter | null {
  if (!tool) return null;
  const t = tool.toLowerCase().replace(/^mcp__[^_]+__/, "");
  if (EDIT_TOOLS.test(t)) return "edits";
  if (COMMAND_TOOLS.test(t)) return "commands";
  if (READ_TOOLS.test(t)) return "reads";
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseEvent(line: string): Record<string, unknown> | null {
  const t = line.trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = asObject(JSON.parse(t));
    return v && typeof v.type === "string" ? v : null;
  } catch {
    return null;
  }
}

/** A tool call's input as the view shows it: the command, the path, the edit; else its JSON. */
function toolInput(tool: string, input: unknown): string {
  const o = asObject(input);
  if (!o) return typeof input === "string" ? input : JSON.stringify(input ?? null);
  const t = tool.toLowerCase();
  const path = str(o.file_path) ?? str(o.path) ?? str(o.notebook_path);
  if (t === "bash" && str(o.command) !== null) return str(o.command)!;
  if ((t === "read" || t === "ls") && path) return path;
  if (t === "write" && path) return `${path}\n${str(o.content) ?? ""}`;
  if (t === "edit" && path) return `${path}\n- ${str(o.old_string) ?? ""}\n+ ${str(o.new_string) ?? ""}`;
  if ((t === "grep" || t === "glob") && str(o.pattern) !== null) return `${str(o.pattern)}${path ? `  in ${path}` : ""}`;
  return JSON.stringify(o, null, 2);
}

/** A tool result's content as text (a string, or text blocks). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const o = asObject(b);
        return o && typeof o.text === "string" ? o.text : JSON.stringify(b);
      })
      .join("\n");
  }
  return content === undefined ? "" : JSON.stringify(content);
}

/** The steps of one line: stream-json events (Claude Code's or the OpenAI-compatible runner's), else one plain step. */
export function lineSteps(line: string): { steps: RawStep[]; json: boolean } {
  if (line.trim() === "") return { steps: [], json: false };
  const e = parseEvent(line);
  if (!e) return { steps: [{ kind: "plain", tool: null, text: line, is_error: false }], json: false };
  const steps: RawStep[] = [];
  const type = e.type as string;
  const blocks = asObject(e.message)?.content;
  if ((type === "assistant" || type === "user") && Array.isArray(blocks)) {
    for (const b of blocks) {
      const o = asObject(b);
      if (!o) continue;
      if (o.type === "text" && typeof o.text === "string") {
        if (o.text.trim()) steps.push({ kind: type === "assistant" ? "text" : "other", tool: null, text: o.text, is_error: false });
      } else if (o.type === "tool_use") {
        const tool = str(o.name) ?? "tool";
        steps.push({ kind: "tool_use", tool, text: toolInput(tool, o.input), is_error: false });
      } else if (o.type === "tool_result") {
        steps.push({ kind: "tool_result", tool: null, text: contentText(o.content), is_error: o.is_error === true });
      }
      // Thinking blocks and anything else are not shown.
    }
    return { steps, json: true };
  }
  if (typeof blocks === "string" && (type === "assistant" || type === "user")) {
    return { steps: [{ kind: type === "assistant" ? "text" : "other", tool: null, text: blocks, is_error: false }], json: true };
  }
  switch (type) {
    case "result": {
      const failed = e.is_error === true || (typeof e.subtype === "string" && e.subtype !== "success");
      const text = str(e.result) ?? str(e.subtype) ?? "result";
      return { steps: [{ kind: "result", tool: null, text, is_error: failed }], json: true };
    }
    case "system":
      return { steps: [{ kind: "system", tool: null, text: str(e.subtype) ?? "system", is_error: false }], json: true };
    case "response": {
      if (typeof e.text === "string" && e.text.trim()) steps.push({ kind: "text", tool: null, text: e.text, is_error: false });
      for (const c of Array.isArray(e.tool_calls) ? e.tool_calls : []) {
        const fn = asObject(asObject(c)?.function);
        const tool = str(fn?.name) ?? "tool";
        let input: unknown = fn?.arguments;
        if (typeof input === "string") {
          try {
            input = JSON.parse(input);
          } catch {
            // Shown as given.
          }
        }
        steps.push({ kind: "tool_use", tool, text: toolInput(tool, input), is_error: false });
      }
      return { steps, json: true };
    }
    case "tool_result":
      return { steps: [{ kind: "tool_result", tool: str(e.name), text: contentText(e.content), is_error: e.is_error === true }], json: true };
    case "error":
      return { steps: [{ kind: "error", tool: null, text: str(e.message) ?? str(e.code) ?? "error", is_error: true }], json: true };
    default:
      return { steps: [{ kind: "other", tool: null, text: line, is_error: false }], json: true };
  }
}

/** True when the step is shown under the filter (only tool calls of its category). */
function matches(s: RawStep, filter: StepFilter | null): boolean {
  return filter === null || (s.kind === "tool_use" && toolCategory(s.tool) === filter);
}

/** The step after G5 on channel `ui`: as is, or withheld whole. */
async function scanned(scanner: EgressScanner, id: string, s: RawStep): Promise<Step> {
  const r = await scanner.scan("ui", s.tool === null ? s.text : `${s.tool}\n${s.text}`);
  if (!r.clean) {
    const rules = [...new Set(r.findings.map((f) => f.rule))].join(", ");
    return { id, kind: s.kind, tool: null, text: `[withheld: ${rules}]`, is_error: s.is_error, withheld: true };
  }
  return { id, kind: s.kind, tool: s.tool, text: s.text, is_error: s.is_error, withheld: false };
}

const bytesOf = (v: unknown) => Buffer.byteLength(JSON.stringify(v), "utf8");

/** Cuts a (scanned, clean) step's text until the step fits `budget` bytes of JSON. */
function fit(step: Step, budget: number): Step {
  let s = step;
  let size = bytesOf(s);
  while (size > budget && s.text.length > 0) {
    const keep = Math.max(0, Math.floor((s.text.length * budget) / size) - 64);
    s = { ...s, text: s.text.slice(0, keep), truncated: true };
    size = bytesOf(s);
  }
  return s;
}

interface LineSteps {
  offset: number;
  steps: RawStep[];
}

/** Lines with their matching steps, and whether any line was stream-json. */
function stepsOf(lines: readonly Line[], filter: StepFilter | null): { rows: LineSteps[]; json: boolean } {
  let json = false;
  const rows: LineSteps[] = [];
  for (const l of lines) {
    const r = lineSteps(l.text);
    json ||= r.json;
    const steps = r.steps.filter((s) => matches(s, filter));
    if (steps.length > 0) rows.push({ offset: l.offset, steps });
  }
  return { rows, json };
}

/** Scans the rows' steps in order, within STEP_BUDGET by whole lines; returns the steps and the first line left out. */
async function budgeted(scanner: EgressScanner, rows: readonly LineSteps[]): Promise<{ steps: Step[]; leftAt: number | null }> {
  const out: Step[] = [];
  let used = 0;
  for (const row of rows) {
    const lineOut: Step[] = [];
    let lineBytes = 0;
    for (const [i, s] of row.steps.entries()) {
      const step = await scanned(scanner, `${row.offset}:${i}`, s);
      lineOut.push(step);
      lineBytes += bytesOf(step) + 1;
    }
    if (used + lineBytes > STEP_BUDGET) {
      if (out.length > 0) return { steps: out, leftAt: row.offset };
      // The first line alone is too large: its steps are cut (after the scan) to share the budget.
      const each = Math.floor(STEP_BUDGET / lineOut.length) - 1;
      return { steps: lineOut.map((s) => fit(s, each)), leftAt: null };
    }
    out.push(...lineOut);
    used += lineBytes;
  }
  return { steps: out, leftAt: null };
}

// --- the route -----------------------------------------------------------------------------------------------

/** Answers GET /api/v1/items/<item>/runs/<run>/transcript (`offset`, `filter`, `tail`, `part`). */
export async function transcript(d: TranscriptDeps, item: WorkItemId, runId: string, params: URLSearchParams): Promise<TranscriptResult> {
  const run = (await d.store.listRuns(item)).find((r) => r.id === runId);
  if (!run) return fail(404, "No such run for this work item.");
  if (!d.storage) return fail(404, "No stored transcript for this run.");

  const filterRaw = params.get("filter");
  if (filterRaw !== null && filterRaw !== "" && !(STEP_FILTERS as readonly string[]).includes(filterRaw)) {
    return fail(400, "filter must be edits, commands or reads.");
  }
  const filter = filterRaw ? (filterRaw as StepFilter) : null;
  const offsetRaw = params.get("offset") ?? "0";
  if (!/^\d{1,15}$/.test(offsetRaw)) return fail(400, "offset must be a whole number of bytes.");
  const offset = Number(offsetRaw);
  const tail = params.get("tail") === "1";

  let parts: string[];
  try {
    parts = runParts(await d.storage.list(itemPrefix(item)), item, run.id);
  } catch {
    return fail(500, "The transcript could not be read.");
  }
  const part = params.get("part") ?? parts[0] ?? "";
  if (!parts.includes(part)) return fail(404, "No stored transcript for this run.");
  const key = partKey(item, run.id, part);

  let page: { steps: Step[]; json: boolean; start: number; next: number | null; size: number; earlier: boolean } | null;
  try {
    page = tail ? await tailPage(d, key, filter) : await forwardPage(d, key, offset, filter);
  } catch {
    return fail(500, "The transcript could not be read.");
  }
  if (!page) return fail(404, "No stored transcript for this run.");

  return {
    status: 200,
    value: {
      run: await runInfo(d, run),
      parts,
      part,
      format: page.json ? "stream-json" : "plain",
      size: page.size,
      mode: tail ? "tail" : "forward",
      filter,
      start: page.start,
      next: page.next,
      earlier: page.earlier,
      steps: page.steps,
    },
  };
}

async function forwardPage(d: TranscriptDeps, key: string, offset: number, filter: StepFilter | null) {
  const from = offset > 0 ? offset - 1 : 0;
  const r = await readRange(d.storage!, key, from, from + PAGE_BYTES);
  if (!r) return null;
  if (offset >= r.size) return { steps: [], json: false, start: offset, next: null, size: r.size, earlier: offset > 0 };
  const split = splitLines(r.bytes, from, r.size);
  const { rows, json } = stepsOf(split.lines, filter);
  const { steps, leftAt } = await budgeted(d.scanner, rows);
  if (split.oversize && filter === null) {
    steps.push({ id: `${offset}:0`, kind: "oversize", tool: null, text: `[a line over ${PAGE_BYTES / 1024} KiB is not shown]`, is_error: false, withheld: false });
  }
  return { steps, json, start: offset, next: leftAt ?? split.resume, size: r.size, earlier: offset > 0 };
}

/** The last TAIL_STEPS matching steps within the file's final PAGE_BYTES. */
async function tailPage(d: TranscriptDeps, key: string, filter: StepFilter | null) {
  const head = await readRange(d.storage!, key, 0, 0);
  if (!head) return null;
  const from = Math.max(0, head.size - PAGE_BYTES);
  const r = await readRange(d.storage!, key, from, head.size);
  if (!r) return null;
  const split = splitLines(r.bytes, from, r.size);
  const { rows, json } = stepsOf(split.lines, filter);
  // From the end: whole lines until TAIL_STEPS steps, then only the last TAIL_STEPS of them.
  const picked: LineSteps[] = [];
  let count = 0;
  for (let i = rows.length - 1; i >= 0 && count < TAIL_STEPS; i--) {
    const row = rows[i]!;
    const keep = Math.min(row.steps.length, TAIL_STEPS - count);
    picked.unshift({ offset: row.offset, steps: row.steps.slice(row.steps.length - keep) });
    count += keep;
  }
  // Within the budget, the latest lines win.
  let chosen = picked;
  let result = await budgeted(d.scanner, chosen);
  while (result.leftAt !== null && chosen.length > 1) {
    chosen = chosen.slice(1);
    result = await budgeted(d.scanner, chosen);
  }
  const start = chosen[0]?.offset ?? r.size;
  return { steps: result.steps, json, start, next: null, size: r.size, earlier: start > 0 };
}

/** The run's outcome and facts for the view's header; every text on channel `ui`. */
async function runInfo(d: TranscriptDeps, run: Run) {
  const text = async (v: string | null | undefined): Promise<string | null> => {
    if (v === null || v === undefined || v === "") return null;
    const r = await d.scanner.scan("ui", v);
    return r.clean ? v : `[withheld: ${[...new Set(r.findings.map((f) => f.rule))].join(", ")}]`;
  };
  const attempts: RunAttempt[] = (await d.store.listRunAttempts(run.work_item_id)).filter((a) => a.run_id === run.id);
  const last = attempts.at(-1);
  const o = run.outcome;
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    attempt: run.attempt,
    started_at: run.started_at,
    finished_at: run.finished_at,
    worker_id: await text(last?.worker_id ?? run.lease?.owner ?? null),
    outcome:
      o === null
        ? null
        : o.status === "failed"
          ? { status: "failed", error_code: await text(o.error_code), detail: await text(o.detail), summary: null }
          : { status: "succeeded", error_code: null, detail: null, summary: await text(o.summary) },
  };
}

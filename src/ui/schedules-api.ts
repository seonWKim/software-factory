// Schedules over HTTP (design 08-schedules): what `factory schedule …` does, through the same core functions
// (src/core/schedule.ts). GET /api/v1/schedules lists them, Check a page ones too (with their trigger, paused flag, page
// URL, instruction and USD caps, as stored); GET /api/v1/schedules/runs?schedule=<id> lists one's runs and /api/v1/schedules/suggestions?schedule=<id> its
// suggestions, a Check a page one's too (400 without the parameter, 404 for an unknown ID). POST /api/v1/schedules/add,
// /edit, /pause, /resume, /run and /delete take a JSON body with `id` and, for add and edit, the CLI's fields (`title`,
// `cadence`, `spec`, `zone`, `action`, `body`, `skip_when_busy`, `token_cap`, and a check-page action's `instruction`,
// `url`, `run_cap_usd` and `daily_cap_usd`, null clearing a cap; `skip_when_busy` true stores `missed_rule` skip, false
// catch_up; add alone also takes `run_now`, true storing the schedule due now). After the request guards (write-routes.ts,
// the pauses CSRF token) a body that
// is not an object or has an unknown, missing or wrongly typed field is a 400 before any store call; then the owner
// check (rules-api.ts ownerOf, passed in, 403); a delete of an unknown ID is a 404; any other refusal of the core is a
// 409 with its reason; else 200 with the schedule (a delete's as it was before it went). POST /api/v1/schedules/draft
// ({ words }) and /improve ({ id }) pass the same guards, a 400 for a bad body, then the owner check (403) before any
// model call; the model is the Data page's Ask model (settings.ask.llm, compose.ts buildUiParts), and none is a 503, a refusal of the core (src/core/schedule-draft.ts) a 409 with its reason; else 200 with
// the proposal (a draft's ID and add fields, or improve's old and new text). Neither stores anything.

import type { Schedule, ScheduleFields, ScheduleWrite, writeSchedule } from "../core/schedule.js";
import type { draftSchedule, improveSchedule } from "../core/schedule-draft.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import type { UserId } from "../core/types.js";
import type { Logger } from "../core/log.js";
import { type ApiResult, apiError } from "./api.js";
import type { UiDeps } from "./deps.js";

/** A schedule as the routes return it: as stored, with `skip_when_busy` (true when `missed_rule` is skip), which the Schedules page reads. */
const withSkip = (s: Schedule) => ({ ...s, skip_when_busy: s.missed_rule === "skip" });

/** GET /api/v1/schedules: every schedule, Check a page ones too, as stored, with `skip_when_busy`. */
export async function readSchedules(d: Pick<UiDeps, "store">): Promise<ApiResult> {
  return { status: 200, value: { schedules: (await d.store.listSchedules({ check_pages: true })).map(withSkip) } };
}

/** Whether a schedule, a Check a page one too, has the ID (a store read, so this file imports no core code). */
const isStored = async (d: Pick<UiDeps, "store">, id: string): Promise<boolean> => (await d.store.listSchedules({ check_pages: true })).some((s) => s.id === id);

/** The 400 or 404 of a read of one schedule's rows, or null for a known ID. */
async function oneSchedule(d: Pick<UiDeps, "store">, id: string | null): Promise<ApiResult | null> {
  if (id === null || id.trim() === "") return apiError(400, "Give the schedule's ID as ?schedule=<id>.");
  return !(await isStored(d, id)) ? apiError(404, `No schedule ${id}.`) : null;
}

/**
 * GET /api/v1/schedules/runs?schedule=<id>: its run rows, oldest first, each with `transcript`: the dashboard href of the
 * run's transcript, or null. A run's claim wrote its `schedule_run` Activity row in the same transaction, so the row
 * with the schedule's ID as subject and the run's `recorded_at` as time is the run's claim; its stored ref gives the link.
 */
export async function readScheduleRuns(d: Pick<UiDeps, "store">, id: string | null): Promise<ApiResult> {
  const refused = await oneSchedule(d, id);
  if (refused !== null) return refused;
  // Loaded inside the read, as readActivity loads its modules: a top-level import would add a feature→feature edge to the layering ratchet.
  const { linkOf } = await import("./activity-api.js");
  const claims = new Map((await d.store.listActivity({ kind: "schedule_run" })).filter((a) => a.subject === id).map((a) => [String(a.at), a.ref]));
  const runs = (await d.store.listScheduleRuns(id!)).map((r) => {
    const link = linkOf(claims.get(String(r.recorded_at)) ?? null);
    return { ...r, transcript: link?.kind === "transcript" ? link.href : null };
  });
  return { status: 200, value: { runs } };
}

/** GET /api/v1/schedules/suggestions?schedule=<id>: its suggestions, oldest first, each state as of now. */
export async function readScheduleSuggestions(d: Pick<UiDeps, "store">, id: string | null): Promise<ApiResult> {
  return (await oneSchedule(d, id)) ?? { status: 200, value: { suggestions: await d.store.listRoutineSuggestions(id!) } };
}

const TEXT_FIELDS = ["title", "cadence", "spec", "zone", "action", "body", "instruction", "url"] as const;
const CAP_FIELDS = ["run_cap_usd", "daily_cap_usd"] as const;

/** The write's ID and fields, or why the body is bad (no store call). */
function bodyOf(w: ScheduleWrite, body: unknown): { id: string; fields: ScheduleFields } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "The body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const takes = w === "add" || w === "edit";
  const known: readonly string[] = takes ? ["id", ...TEXT_FIELDS, ...CAP_FIELDS, "skip_when_busy", "token_cap", ...(w === "add" ? ["run_now"] : [])] : ["id"];
  const unknown = Object.keys(b).find((k) => !known.includes(k));
  if (unknown !== undefined) return `Unknown field "${unknown}".`;
  if (typeof b.id !== "string" || b.id.trim() === "") return "id must be the schedule's ID.";
  const fields: ScheduleFields = {};
  for (const k of TEXT_FIELDS) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "string") return `${k} must be a string.`;
    fields[k] = b[k];
  }
  if (b.skip_when_busy !== undefined) {
    if (typeof b.skip_when_busy !== "boolean") return "skip_when_busy must be true or false.";
    fields.missed = b.skip_when_busy ? "skip" : "catch_up";
  }
  if (b.run_now !== undefined) {
    if (typeof b.run_now !== "boolean") return "run_now must be true or false.";
    fields.run_now = b.run_now;
  }
  if (b.token_cap !== undefined) {
    if (typeof b.token_cap !== "number") return "token_cap must be a number.";
    fields.token_cap = b.token_cap;
  }
  for (const k of CAP_FIELDS) {
    if (b[k] === undefined) continue;
    if (b[k] !== null && typeof b[k] !== "number") return `${k} must be a number or null.`;
    fields[k] = b[k];
  }
  return { id: b.id.trim(), fields };
}

/** What a write runs, passed in by the route table (write-routes.ts): the core's write, the owner check (rules-api.ts ownerOf) and the log. */
export interface ScheduleWriteDeps {
  write: typeof writeSchedule;
  owner: (does: string) => Promise<{ user: UserId } | { error: string }>;
  log: Logger;
}

/** One POST: the body, then the owner, then the core's write. */
export async function postSchedule(d: Pick<UiDeps, "store" | "clock">, w: ScheduleWrite, body: unknown, c: ScheduleWriteDeps): Promise<ApiResult> {
  const b = bodyOf(w, body);
  if (typeof b === "string") return apiError(400, b);
  const own = await c.owner("manages schedules");
  if ("error" in own) return apiError(403, own.error);
  if (w === "delete" && !(await isStored(d, b.id))) return apiError(404, `no schedule ${b.id}`);
  const r = await c.write(d.store, w, b.id, b.fields, own.user, d.clock.now());
  if (!r.ok) return apiError(409, r.problem);
  c.log.info(`schedule ${w}`, { id: b.id, actor: own.user });
  return { status: 200, value: { schedule: withSkip(r.schedule) } };
}

/** What a draft or improve runs, passed in by the route table: the core functions, the owner check, the model, a new ID and the log. */
export interface ScheduleDraftDeps {
  draft: typeof draftSchedule;
  improve: typeof improveSchedule;
  owner: ScheduleWriteDeps["owner"];
  llm: LLMProvider | null;
  newId: () => string;
  log: Logger;
}

export type ScheduleDraftVerb = "draft" | "improve";

/** One draft or improve POST: the body, then the owner, then the model; stores nothing. */
export async function postScheduleDraft(d: Pick<UiDeps, "store" | "scanner">, v: ScheduleDraftVerb, body: unknown, c: ScheduleDraftDeps): Promise<ApiResult> {
  const key = v === "draft" ? "words" : "id";
  if (typeof body !== "object" || body === null || Array.isArray(body)) return apiError(400, "The body must be a JSON object.");
  const unknown = Object.keys(body).find((k) => k !== key);
  if (unknown !== undefined) return apiError(400, `Unknown field "${unknown}".`);
  const value = (body as Record<string, unknown>)[key];
  if (typeof value !== "string" || value.trim() === "") return apiError(400, v === "draft" ? "words must be the words to draft from." : "id must be the schedule's ID.");
  const own = await c.owner("manages schedules");
  if ("error" in own) return apiError(403, own.error);
  if (c.llm === null) return apiError(503, "Draft and Improve are off: no model is configured (plugins.llm).");
  const deps = { llm: c.llm, scanner: d.scanner, newId: c.newId };
  const r = v === "draft" ? await c.draft(value, deps) : await c.improve(value.trim(), { ...deps, store: d.store });
  if (!r.ok) return apiError(409, r.reason);
  c.log.info(`schedule ${v}`, { actor: own.user });
  return { status: 200, value: { proposal: r.value } };
}

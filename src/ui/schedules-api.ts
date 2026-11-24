// Schedules over HTTP (design 08-schedules): what `factory schedule …` does, through the same core functions
// (src/core/schedule.ts). GET /api/v1/schedules lists them; GET /api/v1/schedules/runs?schedule=<id> lists one's runs
// (400 without the parameter, 404 for an unknown ID). POST /api/v1/schedules/add, /edit, /pause, /resume, /run and /delete
// take a JSON body with `id` and, for add and edit, the CLI's fields (`title`, `cadence`, `spec`, `zone`, `action`,
// `body`, `skip_when_busy`, `token_cap`). After the request guards (write-routes.ts, the pauses CSRF token) a body that
// is not an object or has an unknown, missing or wrongly typed field is a 400 before any store call; then the owner
// check (rules-api.ts ownerOf, passed in, 403); a delete of an unknown ID is a 404; any other refusal of the core is a
// 409 with its reason; else 200 with the schedule (a delete's as it was before it went).

import type { ScheduleFields, ScheduleWrite, writeSchedule } from "../core/schedule.js";
import type { UserId } from "../core/types.js";
import type { Logger } from "../core/log.js";
import { type ApiResult, apiError } from "./api.js";
import type { UiDeps } from "./deps.js";

export const SCHEDULES_PATH = "/api/v1/schedules";
export const SCHEDULE_RUNS_PATH = "/api/v1/schedules/runs";

/** GET /api/v1/schedules: every schedule, as stored. */
export async function readSchedules(d: Pick<UiDeps, "store">): Promise<ApiResult> {
  return { status: 200, value: { schedules: await d.store.listSchedules() } };
}

/** GET /api/v1/schedules/runs?schedule=<id>: its run rows, oldest first. */
export async function readScheduleRuns(d: Pick<UiDeps, "store">, id: string | null): Promise<ApiResult> {
  if (id === null || id.trim() === "") return apiError(400, "Give the schedule's ID as ?schedule=<id>.");
  if (!(await d.store.listSchedules()).some((s) => s.id === id)) return apiError(404, `No schedule ${id}.`);
  return { status: 200, value: { runs: await d.store.listScheduleRuns(id) } };
}

const TEXT_FIELDS = ["title", "cadence", "spec", "zone", "action", "body"] as const;

/** The write's ID and fields, or why the body is bad (no store call). */
function bodyOf(w: ScheduleWrite, body: unknown): { id: string; fields: ScheduleFields } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "The body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const takes = w === "add" || w === "edit";
  const known: readonly string[] = takes ? ["id", ...TEXT_FIELDS, "skip_when_busy", "token_cap"] : ["id"];
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
    fields.skip_when_busy = b.skip_when_busy;
  }
  if (b.token_cap !== undefined) {
    if (typeof b.token_cap !== "number") return "token_cap must be a number.";
    fields.token_cap = b.token_cap;
  }
  return { id: b.id.trim(), fields };
}

/** What a write runs, passed in by the route table (write-routes.ts): the core's write, the owner check (rules-api.ts ownerOf) and the log. */
export interface ScheduleWriteDeps {
  write: typeof writeSchedule;
  owner: (does: string) => Promise<{ user: UserId } | { error: string }>;
  log: Logger;
}

/** The write each POST path runs. */
export const SCHEDULE_WRITE_PATHS: Readonly<Record<string, ScheduleWrite>> = {
  [`${SCHEDULES_PATH}/add`]: "add", [`${SCHEDULES_PATH}/edit`]: "edit", [`${SCHEDULES_PATH}/pause`]: "pause", [`${SCHEDULES_PATH}/resume`]: "resume", [`${SCHEDULES_PATH}/run`]: "run",
  [`${SCHEDULES_PATH}/delete`]: "delete",
};

/** One POST: the body, then the owner, then the core's write. */
export async function postSchedule(d: Pick<UiDeps, "store" | "clock">, w: ScheduleWrite, body: unknown, c: ScheduleWriteDeps): Promise<ApiResult> {
  const b = bodyOf(w, body);
  if (typeof b === "string") return apiError(400, b);
  const own = await c.owner("manages schedules");
  if ("error" in own) return apiError(403, own.error);
  if (w === "delete" && !(await d.store.listSchedules()).some((s) => s.id === b.id)) return apiError(404, `no schedule ${b.id}`);
  const r = await c.write(d.store, w, b.id, b.fields, own.user, d.clock.now());
  if (!r.ok) return apiError(409, r.problem);
  c.log.info(`schedule ${w}`, { id: b.id, actor: own.user });
  return { status: 200, value: { schedule: r.schedule } };
}

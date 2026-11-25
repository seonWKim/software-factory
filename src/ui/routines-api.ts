// Routines over HTTP (design 08-routines): GET /api/v1/routines lists them, oldest first; GET
// /api/v1/routines/suggestions?routine=<id> lists one's suggestions (400 without the parameter, 404 for an unknown ID).
// POST /api/v1/routines/add, /edit, /pause, /resume, /delete and /run take a JSON body with `id` and, for add and edit,
// the routine's fields (`name`, `instruction`, `url`, `schedule` {kind, spec}, `zone`, `trigger`, `run_cap_usd`,
// `daily_cap_usd`). After the request guards (write-routes.ts, the pauses CSRF token) a body that is not an object or
// has an unknown, missing or wrongly typed field is a 400 before any store call; then the owner check (rules-api.ts
// ownerOf, passed in, 403); a refusal of the core (src/core/check-page.ts writeRoutine) is a 409 with its reason; else
// 200 with the routine (as it was, for a delete). Shaped as schedules-api.ts.

import type { RoutineFields, RoutineWrite, writeRoutine } from "../core/check-page.js";
import type { UserId } from "../core/types.js";
import type { Logger } from "../core/log.js";
import { type ApiResult, apiError } from "./api.js";
import type { UiDeps } from "./deps.js";

export const ROUTINES_PATH = "/api/v1/routines";
export const ROUTINE_SUGGESTIONS_PATH = "/api/v1/routines/suggestions";

/** GET /api/v1/routines: every routine, oldest first. */
export async function readRoutines(d: Pick<UiDeps, "store">): Promise<ApiResult> {
  return { status: 200, value: { routines: await d.store.listRoutines() } };
}

/** GET /api/v1/routines/suggestions?routine=<id>: its suggestions, oldest first. */
export async function readRoutineSuggestions(d: Pick<UiDeps, "store">, id: string | null): Promise<ApiResult> {
  if (id === null || id.trim() === "") return apiError(400, "Give the routine's ID as ?routine=<id>.");
  if ((await d.store.getRoutine(id)) === null) return apiError(404, `No routine ${id}.`);
  return { status: 200, value: { suggestions: await d.store.listRoutineSuggestions(id) } };
}

type Check = (v: unknown) => boolean;
const str: Check = (v) => typeof v === "string";
const strOrNull: Check = (v) => v === null || typeof v === "string";
const numOrNull: Check = (v) => v === null || typeof v === "number";
const cadenceOrNull: Check = (v) => {
  if (v === null) return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const c = v as Record<string, unknown>;
  return Object.keys(c).every((k) => k === "kind" || k === "spec") && typeof c.kind === "string" && typeof c.spec === "string";
};

/** Each field add and edit take: its check and what the 400 says. */
const FIELDS: Readonly<Record<keyof RoutineFields, [Check, string]>> = {
  name: [str, "a string"], instruction: [str, "a string"], url: [strOrNull, "a string or null"], zone: [str, "a string"],
  schedule: [cadenceOrNull, "{ kind, spec } (two strings) or null"], trigger: [strOrNull, "a string or null"],
  run_cap_usd: [numOrNull, "a number or null"], daily_cap_usd: [numOrNull, "a number or null"],
};

/** The write's ID and fields, or why the body is bad (no store call). */
function bodyOf(w: RoutineWrite, body: unknown): { id: string; fields: RoutineFields } | string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "The body must be a JSON object.";
  const b = body as Record<string, unknown>;
  const takes = w === "add" || w === "edit";
  const unknown = Object.keys(b).find((k) => k !== "id" && !(takes && Object.hasOwn(FIELDS, k)));
  if (unknown !== undefined) return `Unknown field "${unknown}".`;
  if (typeof b.id !== "string" || b.id.trim() === "") return "id must be the routine's ID.";
  const fields: Record<string, unknown> = {};
  for (const [k, [check, what]] of Object.entries(FIELDS)) {
    if (b[k] === undefined) continue;
    if (!check(b[k])) return `${k} must be ${what}.`;
    fields[k] = b[k];
  }
  // The core checks each value's meaning (routineProblem): a cadence kind, a zone, a trigger.
  return { id: b.id.trim(), fields: fields as RoutineFields };
}

/** What a write runs, passed in by the route table (write-routes.ts): the core's write, the owner check (rules-api.ts ownerOf) and the log. */
export interface RoutineWriteDeps {
  write: typeof writeRoutine;
  owner: (does: string) => Promise<{ user: UserId } | { error: string }>;
  log: Logger;
}

/** The write each POST path runs. */
export const ROUTINE_WRITE_PATHS: Readonly<Record<string, RoutineWrite>> = Object.fromEntries(
  (["add", "edit", "pause", "resume", "delete", "run"] as const).map((w) => [`${ROUTINES_PATH}/${w}`, w]),
);

/** One POST: the body, then the owner, then the core's write. */
export async function postRoutine(d: Pick<UiDeps, "store" | "clock">, w: RoutineWrite, body: unknown, c: RoutineWriteDeps): Promise<ApiResult> {
  const b = bodyOf(w, body);
  if (typeof b === "string") return apiError(400, b);
  const own = await c.owner("manages routines");
  if ("error" in own) return apiError(403, own.error);
  const r = await c.write(d.store, w, b.id, b.fields, own.user, d.clock.now());
  if (!r.ok) return apiError(409, r.problem);
  c.log.info(`routine ${w}`, { id: b.id, actor: own.user });
  return { status: 200, value: { routine: r.routine } };
}

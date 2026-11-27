// The schedules capabilities (design 08-schedules, 09-api-registry): what `factory schedule …` does, over the API
// registry. The handlers stay in src/ui/schedules-api.ts; each run passes them what write-routes-owner.ts passed
// before (the core's write, the owner check, the pauses log, the draft and improve functions and the Ask model).
// The handlers are imported inside each run, so scripts/gen-api.mjs, which loads this file with Node's type stripping,
// never loads them. A write's input schema types the fields the handler's bodyOf reads; bodyOf still checks them.

import type { ScheduleWrite } from "../../core/schedule.js";
import type { ApiResult } from "../../ui/api.js";
import type { ScheduleDraftVerb } from "../../ui/schedules-api.js";
import { type Declared, type Refusal, declare, refuse } from "../registry.js";
import { type ObjectSchema, array, boolean, jsonObject, nullable, number, object, optional, string } from "../schema.js";

const handlers = () => import("../../ui/schedules-api.js");
const answer = async <T>(r: Promise<ApiResult>): Promise<T | Refusal> => (await import("../../ui/api.js")).answerOf<T>(await r);

/** A schedule's ID only: pause, resume, run and delete. */
const ID_ONLY = object({ id: string() });
const text = () => optional(string());
const cap = () => optional(nullable(number()));
/** The fields edit takes; add takes run_now too. */
const EDIT_FIELDS = {
  id: string(), title: text(), cadence: text(), spec: text(), zone: text(), action: text(), body: text(), instruction: text(), url: text(),
  skip_when_busy: optional(boolean()), token_cap: optional(number()), run_cap_usd: cap(), daily_cap_usd: cap(),
};
const ADD_INPUT = object({ ...EDIT_FIELDS, run_now: optional(boolean()) });
const EDIT_INPUT = object(EDIT_FIELDS);
const DRAFT_INPUT = object({ words: string() });
/** One schedule as stored, with skip_when_busy (a JSON object, owner answer 3). */
const SCHEDULE_OUTPUT = object({ schedule: jsonObject() });

function write<I>(w: ScheduleWrite, input: ObjectSchema<I>, description: string): Declared {
  return declare({
    id: `schedules.${w}`, area: "schedules", description, permission: "owner", method: "POST", path: `/api/v1/schedules/${w}`, input, output: SCHEDULE_OUTPUT,
    run: async (c, body) => {
      const pauses = c.d.pauses; // write-routes.ts serves the registry's writes only with pauses wired
      if (pauses === undefined) return refuse(404, "Not found.");
      const [{ postSchedule }, { writeSchedule }, { ownerOf }] = await Promise.all([handlers(), import("../../core/schedule.js"), import("../../ui/rules-api.js")]);
      return answer(postSchedule(c.d, w, body, { write: writeSchedule, owner: (does) => ownerOf(c.d, pauses, does), log: pauses.log }));
    },
  });
}

function draft<I>(v: ScheduleDraftVerb, input: ObjectSchema<I>, description: string): Declared {
  return declare({
    id: `schedules.${v}`, area: "schedules", description, permission: "owner", method: "POST", path: `/api/v1/schedules/${v}`, input, output: object({ proposal: jsonObject() }),
    run: async (c, body) => {
      const pauses = c.d.pauses; // write-routes.ts serves the registry's writes only with pauses wired
      if (pauses === undefined) return refuse(404, "Not found.");
      const [{ postScheduleDraft }, { draftSchedule, improveSchedule }, { ownerOf }, { randomUUID }] = await Promise.all([
        handlers(), import("../../core/schedule-draft.js"), import("../../ui/rules-api.js"), import("node:crypto"),
      ]);
      return answer(postScheduleDraft(c.d, v, body, {
        draft: draftSchedule, improve: improveSchedule, owner: (does) => ownerOf(c.d, pauses, does), llm: c.d.settings?.ask?.llm ?? null, newId: randomUUID, log: pauses.log,
      }));
    },
  });
}

/** A GET of one schedule's rows: the handler answers 400 without the parameter, 404 for an unknown ID. */
const ONE_SCHEDULE = object({ schedule: optional(string()) });

export const SCHEDULES: readonly Declared[] = [
  declare({
    id: "schedules.list", area: "schedules", description: "Every schedule, Check a page ones too, as stored, with skip_when_busy.",
    permission: "read", method: "GET", path: "/api/v1/schedules", input: object({}), output: object({ schedules: array(jsonObject()) }),
    run: async (c) => answer((await handlers()).readSchedules(c.d)),
  }),
  declare({
    id: "schedules.runs", area: "schedules", description: "One schedule's runs, oldest first (?schedule=<id>).",
    permission: "read", method: "GET", path: "/api/v1/schedules/runs", input: ONE_SCHEDULE, output: object({ runs: array(jsonObject()) }),
    run: async (c, i) => answer((await handlers()).readScheduleRuns(c.d, i.schedule ?? null)),
  }),
  declare({
    id: "schedules.suggestions", area: "schedules", description: "One schedule's suggestions, oldest first, each state as of now (?schedule=<id>).",
    permission: "read", method: "GET", path: "/api/v1/schedules/suggestions", input: ONE_SCHEDULE, output: object({ suggestions: array(jsonObject()) }),
    run: async (c, i) => answer((await handlers()).readScheduleSuggestions(c.d, i.schedule ?? null)),
  }),
  write("add", ADD_INPUT, "Store a new schedule; run_now true stores it due now."),
  write("edit", EDIT_INPUT, "Change only the fields given; null clears a USD cap."),
  write("pause", ID_ONLY, "Pause a schedule: none of its slots fire."),
  write("resume", ID_ONLY, "Resume a paused schedule at its first slot after now."),
  write("run", ID_ONLY, "Make the schedule due now, so the next tick fires it once."),
  write("delete", ID_ONLY, "Remove the schedule and its suggestions; answers it as it was."),
  draft("draft", DRAFT_INPUT, "Draft a schedule from words with the Ask model; stores nothing."),
  draft("improve", ID_ONLY, "Propose a better text for a schedule with the Ask model; stores nothing."),
];

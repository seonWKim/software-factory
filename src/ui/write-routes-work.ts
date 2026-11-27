// The dashboard's POST routes that check the commands CSRF token: tasks, local calendar events, attachments, project
// files and Re-check. write-routes.ts runs the guards before each; a new commands-token write route adds one entry here.

import { TASK_WRITES } from "./tasks-api.js";
import { PROJECT_FILE_ROUTES } from "./project-files.js";
import { LOCAL_EVENT_WRITES } from "./calendar-local-api.js";
import { localEvents } from "../calendar/index.js";
import { storeSql } from "../impl/store/sql/store-sql.js";
import { ATTACH_PATH, writeAttachment } from "./attachments-api.js";
import { attach } from "../core/attachments.js";
import { recheckMergeCheck, recheckPathId } from "./changes.js";
import type { WriteRoute } from "./write-route-types.js";

/** The commands-token write routes, in table order (first match wins). */
export const WORK_WRITE_ROUTES: readonly WriteRoute[] = [
  { matches: (d, p) => Object.hasOwn(TASK_WRITES, p) && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, p, b) => TASK_WRITES[p]!(d, b) },
  {
    matches: (d, p) => Object.hasOwn(LOCAL_EVENT_WRITES, p) && d.commands !== undefined,
    token: (d) => d.commands!.token,
    run: (d, p, b) => LOCAL_EVENT_WRITES[p]!(d, b, localEvents(storeSql(d.store))),
  },
  { matches: (d, p) => p === ATTACH_PATH && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, _p, b) => writeAttachment(d, b, attach) },
  { matches: (d, p) => Object.hasOwn(PROJECT_FILE_ROUTES, p) && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, p, b) => PROJECT_FILE_ROUTES[p]!.run(d, b) },
  { matches: (d, p) => recheckPathId(p) !== null && d.commands !== undefined, token: (d) => d.commands!.token, run: (d, p) => recheckMergeCheck(d, recheckPathId(p)!) },
];

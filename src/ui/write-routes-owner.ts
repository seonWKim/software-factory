// The dashboard's POST routes that check the pauses CSRF token: the owner's writes (resume, stop, alarm dismiss,
// standing, improve, pack approvals, plugins import, rules, proposal verdict, migrate, supervisor, evals).
// write-routes.ts runs the guards before each; a new pauses-token write route adds one entry here. The schedule writes
// (draft and improve too) are the API registry's capabilities (src/api/capabilities/schedules.ts), behind the same
// guards and the pauses token through write-routes.ts's registry entry.

import { RESUME_PATH, STOP_PATH, resumePause, stopAllAgents } from "./pause-api.js";
import { ALARM_DISMISS_PATH, dismissPost } from "./alarm-api.js";
import { STANDING_PATH, writeStanding } from "./standing-api.js";
import { PACK_APPROVALS_PATH, writePackApproval } from "./packs-api.js";
import { RULE_WRITES, ownerOf } from "./rules-api.js";
import { IMPROVE_RUN_PATH, type ImproveRunDeps, PROPOSAL_VERDICT_PATH, improveRunWired, runImproveNow, writeProposalVerdict } from "./improve-api.js";
import { PLUGINS_IMPORT_PATH, writePluginsImport } from "./plugins-import-api.js";
import { MIGRATE_PATH, SUPERVISOR_PATH, postMigrate, postSupervisor } from "./migrate-api.js";
import { EVALS_WRITE_PATH, skillOf, writeEvals } from "./evals-api.js";
import { EVALS_RUNS_PATH, postSkillEvalRun } from "./evals-run-api.js";
import { liveEvalSource } from "../runtime/live-eval-source.js";
import { type WriteRoute, pausesToken } from "./write-route-types.js";

/** The pauses-token write routes, in table order (first match wins). */
export const OWNER_WRITE_ROUTES: readonly WriteRoute[] = [
  { matches: (d, p) => p === RESUME_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => resumePause(d, d.pauses!, b) },
  { matches: (d, p) => p === STOP_PATH && d.pauses !== undefined, token: pausesToken, run: (d) => stopAllAgents(d, d.pauses!) },
  { matches: (d, p) => p === ALARM_DISMISS_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => dismissPost(d, d.pauses!, b) },
  { matches: (d, p) => p === STANDING_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writeStanding(d, d.pauses!, b) },
  { matches: (d, p) => p === IMPROVE_RUN_PATH && improveRunWired(d), token: pausesToken, run: (d) => runImproveNow(d as ImproveRunDeps) },
  { matches: (d, p) => p === PACK_APPROVALS_PATH && d.pauses?.auth !== undefined, token: pausesToken, run: (d, _p, b) => writePackApproval(d, d.pauses!, b) },
  { matches: (d, p) => p === PLUGINS_IMPORT_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writePluginsImport(d, d.pauses!, b) },
  { matches: (d, p) => Object.hasOwn(RULE_WRITES, p) && d.pauses !== undefined, token: pausesToken, run: (d, p, b) => RULE_WRITES[p]!(d, d.pauses!, b) },
  { matches: (d, p) => p === PROPOSAL_VERDICT_PATH && d.pauses !== undefined, token: pausesToken, run: (d, _p, b) => writeProposalVerdict(d, d.pauses!, b) },
  { matches: (d, p) => p === MIGRATE_PATH && d.pauses !== undefined && d.migrate !== undefined, token: pausesToken, run: (d, _p, b) => postMigrate(d.migrate!, d.pauses!, b) },
  { matches: (d, p) => p === SUPERVISOR_PATH && d.pauses !== undefined && d.migrate !== undefined, token: pausesToken, run: (d, _p, b) => postSupervisor(d.migrate!, d.pauses!, b) },
  { matches: (d, p) => p === EVALS_WRITE_PATH && d.pauses !== undefined && d.evals !== undefined, token: pausesToken, run: (d, _p, b) => writeEvals(d, d.evals!, d.pauses!, b, liveEvalSource) },
  {
    matches: (d, p) => EVALS_RUNS_PATH.test(p) && d.pauses !== undefined && d.evals?.run !== undefined,
    token: pausesToken,
    run: (d, p, b) => postSkillEvalRun(d, skillOf(EVALS_RUNS_PATH.exec(p)?.[1]), b, { run: d.evals!.run!, owner: (does) => ownerOf(d, d.pauses!, does), log: d.pauses!.log }),
  },
];

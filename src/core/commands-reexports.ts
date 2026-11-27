// The re-export hub of src/core/commands.ts (design 04-gate-commands): core helpers the controller units reach
// through src/core/commands.ts, which they already import. One export per line, with its consumer or design topic;
// src/core/commands.ts re-exports this file whole, so adding a name here touches no other file.

export * from "./request-transition.js"; // the gates' shared checks (design 04-gate-commands)
export { settleHeldSkillVersion } from "./skill-eval-gate.js"; // the gates' shared checks (design 04-gate-commands)
export { AT_TRIAGE, type Attachment, addedContext, attachmentLine } from "./attachments.js"; // added context and attachments, for triage (02-attachments)
/** blocked_reason prefix (with `blocked_on: human`) of an item whose dependency closed without a merge (design §5). */
export { DEPENDENCY_CLOSED } from "./phase.js";
export { LOCAL_SOURCE, MERGE_COMMAND, RESTART_COMMAND } from "./local-merge.js"; // for the commands unit
export { type WriteRequest, authorizeWrite } from "./authorize.js"; // the commands unit's agent writes (design 08-permissions)
export { COORDINATOR_LIMIT_KEY, LIMIT_ALERTS_SCAN, coordinatorLimitAnswer } from "./spend.js"; // the coordinator limit answer (design 06-spend)
export { LOCAL_ID, dependsOnId, dependsOnIds, localItemOf, wantedDependsOn, withDependsOn } from "./task-build.js"; // for `/hold` and the coordination unit
export { CANCEL_APP_COMMAND, SENTENCE_APP_COMMAND, localIdentity } from "./local-cli.js"; // for the commands unit
export { specKind } from "./standing.js"; // for the commands unit
export { overCap } from "./split.js"; // an over-cap `/approve` (design 04-split-specs)
export { overCapApproval } from "./size-cap.js"; // an over-cap `/approve` (design 04-split-specs)

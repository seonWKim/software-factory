// Outbound component (RFC 0015 §7): every write to the outside world. Producers store intents and announce them as
// DeliveryRequested on deliveries.requests; the aggregator batches them per destination (§15.1); the flush sends
// each batch through its target (github-change, github-comment, github-labels, slack-thread, local, source) and announces
// DeliveryCompleted on deliveries.results. Other components import only this file.

export {
  ACTION_INTENT, GIT_TARGET, LOCAL_GIT_HOST, THREAD_INTENT, actionByKey, actionsOf, basePushTarget, gitTarget, announce, destinationOf, recordAction, type ActionKind, type ActionRow, type NewAction,
} from "./intents.js";
export { Outbound, type OutboundDeps } from "./outbound.js";
export { buildTargets } from "./targets/targets.js";
export type { Delivery, DeliveryTarget, TargetDeps } from "./targets/target.js";
export {
  basePushOutcome, localGit, mergeOutcome, type GitBasePushResult, type GitBasePushSpec, type GitMergeResult, type GitMergeSpec, type LocalGit,
} from "./targets/local-git.js";
export { DEFAULT_BATCHING, batchingPolicies, policyFor, type BatchingPolicy, type Budget } from "./aggregator/batching.js";
export type { OutboundContext } from "./context.js";
export { DELIVERY_REQUESTED } from "./topics/deliveries-requests.topic.js";
export { DELIVERY_COMPLETED } from "./topics/deliveries-results.topic.js";

/** The component name: its tables' prefix, its outbox and inbox. */
export const OUTBOUND = "outbound";

/** How often the aggregator's flush runs (RFC 0015 §5.3 `outbound-flush`). */
export const OUTBOUND_FLUSH_MS = 2_000;

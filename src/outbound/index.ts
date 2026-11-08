// Outbound component (RFC 0015 §7): every write to the outside world. Producers store intents and announce them as
// DeliveryRequested on deliveries.requests; the aggregator batches them per destination (§15.1); the flush sends
// each batch through its target (github-comment, github-labels, slack-thread, local, source) and announces
// DeliveryCompleted on deliveries.results. Other components import only this file.

export {
  ACTION_INTENT, THREAD_INTENT, announce, destinationOf, recordAction, type ActionKind, type NewAction,
} from "./intents.js";
export { Outbound, type OutboundDeps } from "./outbound.js";
export { buildTargets } from "./targets/targets.js";
export type { Delivery, DeliveryTarget, TargetDeps } from "./targets/target.js";
export { DEFAULT_BATCHING, type BatchingPolicy, type Budget } from "./aggregator/batching.js";
export type { OutboundContext } from "./context.js";
export { DELIVERY_REQUESTED } from "./topics/deliveries-requests.topic.js";
export { DELIVERY_COMPLETED } from "./topics/deliveries-results.topic.js";

/** The component name: its tables' prefix, its outbox and inbox. */
export const OUTBOUND = "outbound";

/** How often the aggregator's flush runs (RFC 0015 §5.3 `outbound-flush`). */
export const OUTBOUND_FLUSH_MS = 2_000;

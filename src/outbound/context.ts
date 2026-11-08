// What outbound's handlers get (RFC 0015 §6.2): the open transaction their inbox row and writes commit in, and the
// batching inputs of a destination.

import type { HandlerContext } from "../shared/handler.js";
import type { SqlExecutor } from "../state/index.js";
import type { BatchingPolicy, Budget } from "./aggregator/batching.js";

export interface OutboundContext extends HandlerContext {
  readonly tx: SqlExecutor;
  /** `outbound.batching.<destination kind>`, the kind being the destination's source type. */
  policy(destination: string): BatchingPolicy;
  /** The request budget of the account the destination is written through; null when none is known. */
  budget(destination: string): Budget | null;
}

// What inbound's handlers get (RFC 0015 §6.2): the open transaction their inbox row and emitted messages commit in.

import type { HandlerContext } from "../shared/handler.js";
import type { SqlExecutor } from "../state/index.js";

export interface InboundContext extends HandlerContext {
  readonly tx: SqlExecutor;
}

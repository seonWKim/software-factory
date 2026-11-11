import type { Timers } from "./timers.js";
export declare const DRAIN_TIMEOUT_MS: number;
export interface Drainable {
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  readonly exited: Promise<void>;
}
export declare function drainChild(child: Drainable, options?: { timeoutMs?: number; timers?: Timers }): Promise<"drained" | "killed">;

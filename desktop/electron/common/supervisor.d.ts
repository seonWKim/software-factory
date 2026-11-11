import type { Timers } from "./timers.js";
export declare const RESTART_DELAY_MS: number;
/** The part of a child process the supervisor uses; node's ChildProcess fits. */
export interface ChildLike {
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: "SIGTERM" | "SIGKILL"): unknown;
}
export type Spawn = (command: string, args: readonly string[], options: Record<string, unknown>) => ChildLike;
export interface SupervisorCommand {
  readonly command: string;
  readonly args: string[];
  readonly options: { cwd: string; env: Record<string, string | undefined> };
}
export declare function supervisorCommand(o: { execPath: string; checkout: string; env: Record<string, string | undefined>; sfHome: string }): SupervisorCommand;
export interface Supervisor {
  stop(timeoutMs: number): Promise<"drained" | "killed" | "not-running">;
}
export declare function startSupervisor(o: {
  spawn: Spawn;
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
  restartDelayMs?: number;
  timers?: Timers;
  onExit?: (code: number | null, signal: string | null) => void;
}): Supervisor;

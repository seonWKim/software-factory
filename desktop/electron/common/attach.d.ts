// Types of attach.js for the tests and typecheck; the shell itself runs the plain module.
import type { ShellFs } from "./app-data.js";
import type { Fetch } from "./status.js";
export declare const PROBE_TIMEOUT_MS: number;
export declare function supervisorStatusFile(checkout: string): string;
export declare function pidAlive(pid: unknown, kill?: (pid: number, signal: 0) => unknown): boolean;
export declare function liveSupervisor(o: {
  fs: Pick<ShellFs, "readFileSync">;
  fetch: Fetch;
  checkout: string;
  overviewUrl: string;
  alive?: (pid: unknown) => boolean;
  timeoutMs?: number;
}): Promise<string | null>;

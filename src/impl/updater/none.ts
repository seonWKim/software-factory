import type { Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";
import type { CommandRunner, SupervisorStatus, Updater } from "../../interfaces/updater.js";
import { writeSupervisorStatus } from "../../supervisor-status.js";

export interface NoneUpdaterOptions {
  /** The checkout `dev` runs from: `rev` is its HEAD. */
  repoPath: string;
  run: CommandRunner;
  env: Readonly<Record<string, string>>;
  clock: Clock;
  log: Logger;
  /** Where to write the SupervisorStatus for the status page. */
  statusFile: string;
}

/**
 * `dev` runs in place from the checkout it was started in. Launches nothing; writes the status file so the
 * page shows this process as the running factory: `running` at start (child_pid is this process), `stopped` at
 * shutdown. No `supervisor_pid`: `npm run migrate` does not ask an in-place factory to drain.
 */
export class NoneUpdater implements Updater {
  readonly mode = "in-place" as const;
  private rev: string | null = null;

  constructor(private readonly o: NoneUpdaterOptions) {}

  async start(): Promise<void> {
    this.rev = await this.head();
    await this.report("running");
  }
  async check(): Promise<string | null> {
    return null;
  }
  async poll(): Promise<void> {}
  childPid(): number | null {
    return null;
  }
  async shutdown(): Promise<void> {
    await this.report("stopped");
  }

  /** One `git rev-parse HEAD`; null when it fails. */
  private async head(): Promise<string | null> {
    try {
      const r = await this.o.run(["git", "rev-parse", "HEAD"], { cwd: this.o.repoPath, env: this.o.env });
      return r.exit_code === 0 ? r.stdout.trim() || null : null;
    } catch {
      return null;
    }
  }

  private report(state: "running" | "stopped"): Promise<void> {
    const status: SupervisorStatus = {
      state,
      rev: this.rev,
      target_rev: null,
      child_pid: state === "running" ? process.pid : null,
      draining_pids: [],
      since: this.o.clock.now().toISOString(),
      error: null,
    };
    return writeSupervisorStatus(this.o.statusFile, status, this.o.log);
  }
}

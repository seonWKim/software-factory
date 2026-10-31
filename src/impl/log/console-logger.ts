import type { LogFields, Logger } from "../../core/log.js";
import type { Clock } from "../../interfaces/clock.js";

/** One JSON line per event on stderr. */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly clock: Clock,
    private readonly component: string,
  ) {}

  info(msg: string, fields?: LogFields): void {
    this.write("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.write("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.write("error", msg, fields);
  }

  private write(level: string, msg: string, fields?: LogFields): void {
    process.stderr.write(
      `${JSON.stringify({ at: this.clock.now().toISOString(), level, component: this.component, msg, ...fields })}\n`,
    );
  }
}

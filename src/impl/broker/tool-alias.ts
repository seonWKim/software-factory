import type { Logger } from "../../core/log.js";
import { forgeToolName } from "../../interfaces/tool-broker.js";
import { SystemClock } from "../clock/system-clock.js";
import { ConsoleLogger } from "../log/console-logger.js";

/** The aliases already warned about in this process: one warning per alias per process. */
const warned = new Set<string>();
const defaultLog: Pick<Logger, "warn"> = new ConsoleLogger(new SystemClock(), "broker");

/**
 * The forge.* tool a broker runs for `name`. A github.* alias maps to its forge.* tool and logs one warning per
 * process naming both, so callers still on the old name show up without flooding the log.
 */
export function brokerToolName(name: string, log: Pick<Logger, "warn"> = defaultLog): string {
  const forge = forgeToolName(name);
  if (forge !== name && !warned.has(name)) {
    warned.add(name);
    log.warn(`tool ${name} is an old name of ${forge}; call ${forge}`, { tool: name, forge_tool: forge });
  }
  return forge;
}

import type { Updater } from "../../interfaces/updater.js";

/** `dev` runs in place from the checkout it was started in, as before the updater existed. Runs nothing. */
export class NoneUpdater implements Updater {
  readonly mode = "in-place" as const;

  async start(): Promise<void> {}
  async check(): Promise<string | null> {
    return null;
  }
  async poll(): Promise<void> {}
  childPid(): number | null {
    return null;
  }
  async shutdown(): Promise<void> {}
}

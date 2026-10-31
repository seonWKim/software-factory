import type { KeepAwake } from "../../interfaces/keep-awake.js";

/** Does nothing: the host's own power settings decide. For Linux, Windows, servers and tests. */
export class NoKeepAwake implements KeepAwake {
  async hold(): Promise<void> {}
  async release(): Promise<void> {}
}

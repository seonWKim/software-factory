import type { TacitEntry, TacitLedger } from "../../interfaces/tacit-ledger.js";

/** No ledger: captures nothing, lists nothing. The default (docs/plugins/tacit-ledger.md). */
export class NoTacitLedger implements TacitLedger {
  readonly enabled = false;
  async capture(): Promise<void> {}
  async list(): Promise<readonly TacitEntry[]> {
    return [];
  }
  async verdict(): Promise<void> {}
}

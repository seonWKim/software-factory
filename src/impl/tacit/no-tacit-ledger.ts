import type { TacitLedger, TacitPendingEntry, TacitRule } from "../../interfaces/tacit-ledger.js";

/** No ledger: captures nothing, lists nothing, judges nothing. The default (docs/plugins/tacit-ledger.md). */
export class NoTacitLedger implements TacitLedger {
  readonly enabled = false;
  async capture(): Promise<void> {}
  async pending(): Promise<readonly TacitPendingEntry[]> {
    return [];
  }
  async verdict(): Promise<void> {}
  async rules(): Promise<readonly TacitRule[]> {
    return [];
  }
}

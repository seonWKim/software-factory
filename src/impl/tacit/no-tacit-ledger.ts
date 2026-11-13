import type { TacitApplied, TacitEntryDetail, TacitLedger, TacitPendingEntry, TacitRetired, TacitRule } from "../../interfaces/tacit-ledger.js";

/** No ledger: captures nothing, lists and shows nothing, judges (and retires) nothing. The default (docs/plugins/tacit-ledger.md). */
export class NoTacitLedger implements TacitLedger {
  readonly enabled = false;
  async capture(): Promise<void> {}
  async pending(): Promise<readonly TacitPendingEntry[]> {
    return [];
  }
  async show(): Promise<TacitEntryDetail | null> {
    return null;
  }
  async verdict(): Promise<void> {}
  async rules(): Promise<readonly TacitRule[]> {
    return [];
  }
  async applied(): Promise<TacitApplied> {
    return { rules: [], elsewhere: [] };
  }
  async retired(): Promise<readonly TacitRetired[]> {
    return [];
  }
}

// The sync lease step and what other units ask of it: which replica syncs, the fence of a synced write, whether optional forge reads wait.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import type { SyncState, TickLease } from "../../../core/lease.js";
import { type SourceType } from "../../../core/types.js";
import type { SyncFence } from "../../../interfaces/factory-store.js";
import { GITHUB_SOURCE_TYPE } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The sync lease step and what other units ask of it: which replica syncs, the fence of a synced write, whether optional forge reads wait. */
export class SyncUnit {
  constructor(private readonly c: Ctx) {
    this.sync = c.k.d.sync ?? null;
  }

  /** The sync lease (design 05-coordination), from the role: only its holder delivers the synced type's outbox rows. */
  readonly sync: TickLease | null;

  /**
   * One step of the sync lease (design 05-coordination): the holder renews, another replica takes it once it is
   * free; at most one store call per heartbeat_ms. Then the shared forge budget is read, at most once per tick.
   */
  async syncStep(): Promise<void> {
    if (!this.sync) return;
    await this.sync.tick();
    await this.c.k.d.refresh_forge_budget?.();
  }

  /** The sync state as of the last sync step; null with no sync lease (or before the first step). */
  get syncState(): SyncState | null {
    return this.sync?.current ?? null;
  }

  /** True while another replica holds the sync lease: this one makes none of the sync's forge calls. */
  syncedElsewhere(): boolean {
    return this.syncState?.kind === "other";
  }

  /** The fence of a write for source type `type`: the held sync lease for the synced type, else none. */
  fenceFor(type: SourceType): SyncFence | null {
    const st = this.syncState;
    return type === GITHUB_SOURCE_TYPE && st?.kind === "held" ? st.fence : null;
  }

  /**
   * A write fenced with `fence` was refused. When the lease's token moved on, another replica took it: the lease is
   * dropped now rather than at the next heartbeat. A refusal under the current token (the delivery moved elsewhere)
   * keeps it.
   */
  async fenceRefused(fence: SyncFence): Promise<void> {
    if ((await this.c.k.d.store.getSyncLease(fence.name))?.token !== fence.token) this.sync?.lost();
  }

  /**
   * True while optional forge reads wait: any source's request budget is low (`lowBudget`, the shared forge budget
   * included; issue #254), or another replica holds the sync lease and makes them.
   */
  lowBudget(): boolean {
    return this.syncedElsewhere() || this.c.k.sources.some((s) => s.lowBudget?.() === true);
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "sync": SyncUnit;
  }
}

export default controllerUnit({
  name: "sync",
  create: (c: Ctx) => new SyncUnit(c),
  steps: [
    { name: "sync", every: "tick", order: 10, run: (u) => u.syncStep() },
  ],
});

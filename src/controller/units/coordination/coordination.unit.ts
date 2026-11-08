// Dependencies between items: edges, holds, cycles and releases.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { DEPENDENCY_CLOSED } from "../../../core/commands.js";
import { type DependencyLink, type DependencyVerdict, dependencyReason, dependencyVerdict, holdReason, isDependencySource, shortRef } from "../../../core/coordination.js";
import { runKey } from "../../../core/policy.js";
import { type Actor, type DependencyState, type SourceType, type Timestamp, type WorkItem, type WorkItemId } from "../../../core/types.js";
import type { FactoryStore } from "../../../interfaces/factory-store.js";
import { SYSTEM, completed, footerAfter, iso } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** How long the state of a dependency the store does not track, read from the forge, is reused (issue #254). */
export const DEPENDENCY_STATE_TTL_MS = 10 * 60_000;
/** Queued implement runs and dependency-held items looked at per coordination tick (design §5, 2026-11-03). */
const COORDINATION_BATCH = 50;
/** blocked_reason prefix (with `blocked_on: human`) of a dependency cycle; DEPENDENCY_CLOSED is in commands.ts. */
const DEPENDENCY_CYCLE = "dependency_cycle";

/** Dependencies between items: edges, holds, cycles and releases. */
export class CoordinationUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The forge's answers for dependencies the store does not track, by source id, each reused for
   * DEPENDENCY_STATE_TTL_MS (issue #254); `null` for a read that failed, so it is not retried before then. Per
   * process, only a cache: a replica without it asks the forge once.
   */
  readonly dependencyStates = new Map<string, { state: DependencyState | null; at: number }>();

  /**
   * When each item's last failed link read was, so a coordination pass does not read its stale links again before
   * DEPENDENCY_STATE_TTL_MS (issue #254). Per process, only a throttle: a replica without it reads once.
   */
  readonly linkFailures = new Map<WorkItemId, number>();

  async coordinationStep(): Promise<void> {
    // Dependency reads are optional: the sync state and the shared budget decide them (see lowBudget).
    await this.c.k.guard("sync", () => this.c.unit("sync").syncStep());
    const queued = (await this.c.k.d.store.listRunsByStatus(["queued"], COORDINATION_BATCH * 4))
      .filter((r) => r.kind === "implement")
      .slice(0, COORDINATION_BATCH);
    const held = await this.c.k.d.store.listWorkItemsWhere({ blocked_on: "dependency", limit: COORDINATION_BATCH });
    const ids = [...new Set([...queued.map((r) => r.work_item_id), ...held.map((i) => i.id)])];
    for (const id of ids) {
      await this.c.k.guard("coordination item", async () => {
        await this.coordinateItem(id, true);
        await this.holdComment(id);
      });
    }
  }

  /**
   * Reads the item's edges (from its source when `network` and they were never read with a time, else the stored
   * ones), records each edge's state, and applies what they mean: hold on `blocked_on: dependency`,
   * release, or block on a human for a dependency closed unmerged or a cycle (queued runs cancelled, one comment).
   * Only an implementing item without a PR is changed. A forge that fails changes nothing: stored edges apply.
   */
  async coordinateItem(id: WorkItemId, network: boolean): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || it.stage !== "RUNNING" || it.change_ref !== null) return;
    if (it.blocked_on !== "none" && it.blocked_on !== "dependency") return;
    await this.applyDependencies(it.id, await this.readDependencies(it, network ? "due" : "stored"));
  }

  /**
   * The item's dependency verdict after its edges and their states are read and stored: `stored` reads only the
   * store; `due` also reads the forge for links never read with a time (none within DEPENDENCY_STATE_TTL_MS of a
   * failed read) and for outside states past DEPENDENCY_STATE_TTL_MS, both skipped under a low request budget (issue #254); `now` reads the forge whatever
   * the cache (a human `/retry`, one read per edge).
   */
  async readDependencies(it: WorkItem, read: "stored" | "due" | "now"): Promise<DependencyVerdict> {
    const relink = read === "now"
      || (read === "due" && !this.linkReadFailedRecently(it.id) && (await this.c.k.d.store.dependencyLinksReadAt(it.id)) === null && !this.c.unit("sync").lowBudget());
    const edges = relink
      ? await this.refreshEdges(it, iso(this.c.k.d.clock.now().getTime()))
      : await this.c.k.d.store.listDependencyEdges({ work_item_id: it.id });
    for (const e of edges) {
      if (read === "now") this.dependencyStates.delete(e.depends_on);
      const state = await this.dependencyStateOf(it.source.type, e.depends_on, read !== "stored");
      if (state !== null && state !== e.state) await this.c.k.d.store.setDependencyState(it.id, e.depends_on, state);
    }
    const fresh = await this.c.k.d.store.listDependencyEdges({ work_item_id: it.id });
    return dependencyVerdict(it.source.id, fresh, await this.dependencyGraph());
  }

  /**
   * `/retry` at `dependency_closed` (design §5, 2026-11-07): the dependencies are read again now. None closed
   * unmerged and no cycle: the block is lifted with a new implement run (the block cancelled the old one), the
   * human as actor, then a dependency still open holds it as usual. Else refused, naming what still blocks.
   */
  async retryDependencies(
    it: WorkItem, actor: Extract<Actor, { kind: "user" }>, note: string | null, paths: readonly string[],
  ): Promise<string | null> {
    if (paths.length > 0) return "`+paths` applies only to a failed implement run; reply `/retry` without `+paths`";
    const v = await this.readDependencies(it, "now");
    const short = (d: string) => shortRef(d, it.source.id);
    if (v.kind === "closed") {
      return `${short(v.dependency)} is still closed without a merge; reply \`/retry\` once it is merged or the link to it is removed`;
    }
    if (v.kind === "cycle") return `the dependencies form a cycle: ${v.cycle.map(short).join(" → ")}; remove one of the links, then reply \`/retry\``;
    const blockedReason = it.blocked_reason;
    const refusal = await this.c.unit("transitions").decide(it.id, (cur) => {
      if (cur.stage !== "RUNNING" || cur.change_ref !== null || cur.blocked_on !== "human" || cur.blocked_reason !== blockedReason) return null;
      const next = { ...cur, restart_count: cur.restart_count + 1 };
      return {
        patch: { blocked_on: "none", blocked_reason: null, restart_count: next.restart_count },
        actor,
        reason: "retry_requested",
        detail: { released: blockedReason ?? DEPENDENCY_CLOSED, ...(note ? { note } : {}) },
        enqueue: { kind: "implement", idempotency_key: runKey(next, "implement") },
      };
    });
    if (refusal === null && v.kind === "wait") await this.applyDependencies(it.id, v);
    return refusal;
  }

  /**
   * The item's edges from its source (`Depends on` lines, sub-issues, blocked-by links), stored with `read_at`, the
   * issue's updated_at they were read at; else (no such source, or the source failed: logged, and the links
   * marked stale so a coordination pass reads them again once DEPENDENCY_STATE_TTL_MS has passed) the stored ones.
   */
  async refreshEdges(it: WorkItem, read_at: Timestamp): Promise<Awaited<ReturnType<FactoryStore["listDependencyEdges"]>>> {
    const adapter = this.c.k.byType.get(it.source.type);
    if (!adapter || !isDependencySource(adapter)) return this.c.k.d.store.listDependencyEdges({ work_item_id: it.id });
    let links: DependencyLink[];
    try {
      links = (await adapter.dependencyLinks(it.source)).filter((l) => l.depends_on !== it.source.id);
    } catch (err) {
      this.c.k.d.log.warn("dependency links not read: stored edges apply", { work_item_id: it.id, error: (err as Error).message });
      this.linkFailures.set(it.id, this.c.k.d.clock.now().getTime());
      await this.c.k.d.store.markDependencyLinksStale(it.id);
      return this.c.k.d.store.listDependencyEdges({ work_item_id: it.id });
    }
    this.linkFailures.delete(it.id);
    return this.c.k.d.store.replaceDependencyEdges(it.id, links, read_at);
  }

  /** Whether the item's links failed to read less than DEPENDENCY_STATE_TTL_MS ago; older failures are dropped. */
  linkReadFailedRecently(id: WorkItemId): boolean {
    const now = this.c.k.d.clock.now().getTime();
    for (const [k, at] of this.linkFailures) if (now - at >= DEPENDENCY_STATE_TTL_MS) this.linkFailures.delete(k);
    return this.linkFailures.has(id);
  }

  /**
   * One fresh read of an existing item's links when the issue's `updated_at` moved past the time they were read at
   * (or they never were with a time, whatever the delivery's `updated_at`); nothing when it did not. A failed read marks them stale (refreshEdges), so
   * a coordination pass DEPENDENCY_STATE_TTL_MS later reads them again instead of waiting for another edit.
   */
  async relinkIfChanged(it: WorkItem, updated_at: string | undefined): Promise<void> {
    const adapter = this.c.k.byType.get(it.source.type);
    if (!adapter || !isDependencySource(adapter)) return;
    const readAt = await this.c.k.d.store.dependencyLinksReadAt(it.id);
    // NaN (no or a bad updated_at) is never newer: only links never read with a time are read then.
    if (readAt !== null && !(Date.parse(updated_at ?? "") > Date.parse(readAt))) return;
    await this.refreshEdges(it, this.issueTime(updated_at));
  }

  /** A source's `updated_at` as a store timestamp; the store clock when the source gave none. */
  issueTime(updated_at: string | undefined): Timestamp {
    const ms = updated_at === undefined ? NaN : Date.parse(updated_at);
    return iso(Number.isFinite(ms) ? ms : this.c.k.d.clock.now().getTime());
  }

  /**
   * What a dependency's state is now: a work item's from the store (see `itemMerged`), else, with `network`, the
   * source's answer, reused for DEPENDENCY_STATE_TTL_MS. Null when unknown or not read now (no item, no network, no
   * capability, a low request budget, or the source failed: logged). `type`: the source type of the item that
   * waits, whose source read the link, so the dependency is in its id space.
   */
  async dependencyStateOf(type: SourceType, dependsOn: string, network: boolean): Promise<DependencyState | null> {
    const dep = await this.c.k.d.store.getWorkItemBySource(type, dependsOn);
    if (dep) {
      if (dep.stage !== "CLOSED") return "open";
      return (await this.itemMerged(dep)) ? "merged" : "closed_unmerged";
    }
    const adapter = this.c.k.byType.get(type);
    if (!network || !adapter || !isDependencySource(adapter)) return null;
    // At most one forge read per dependency per DEPENDENCY_STATE_TTL_MS, and none while the budget is low (issue #254).
    const now = this.c.k.d.clock.now().getTime();
    const cached = this.dependencyStates.get(dependsOn);
    if (cached && now - cached.at < DEPENDENCY_STATE_TTL_MS) return cached.state;
    if (this.c.unit("sync").lowBudget()) return null;
    let state: DependencyState | null;
    try {
      state = await adapter.dependencyState(dependsOn);
    } catch (err) {
      this.c.k.d.log.warn("dependency state not read: stored state applies", { depends_on: dependsOn, error: (err as Error).message });
      state = null;
    }
    this.dependencyStates.set(dependsOn, { state, at: now });
    // Keep the cache bounded: drop answers past their time.
    if (this.dependencyStates.size > COORDINATION_BATCH * 8) {
      for (const [k, v] of this.dependencyStates) if (now - v.at >= DEPENDENCY_STATE_TTL_MS) this.dependencyStates.delete(k);
    }
    return state;
  }

  /**
   * Whether a work item counts as merged for its dependents: closed `completed` with a merge sha, or a split
   * parent (never implemented itself, so no sha) closed `completed` whose recorded phases all closed `completed`,
   * the rule that closes a split (closeSplitIfDone).
   */
  async itemMerged(it: WorkItem): Promise<boolean> {
    if (!completed(it)) return false;
    if (it.merge_sha !== null) return true;
    const phases = await this.c.unit("phases").recordedPhases(it.id);
    return phases.length > 0 && phases.every(completed);
  }

  /** Source id → the source ids it waits for, over every edge not yet merged, for the cycle check. */
  async dependencyGraph(): Promise<Map<string, string[]>> {
    const graph = new Map<string, string[]>();
    const sourceOf = new Map<string, string | null>();
    for (const e of await this.c.k.d.store.listDependencyEdges()) {
      if (e.state === "merged") continue;
      if (!sourceOf.has(e.work_item_id)) sourceOf.set(e.work_item_id, (await this.c.k.d.store.getWorkItem(e.work_item_id))?.source.id ?? null);
      const from = sourceOf.get(e.work_item_id);
      if (from) graph.set(from, [...(graph.get(from) ?? []), e.depends_on]);
    }
    return graph;
  }

  /** The transition (and comment) a dependency verdict asks for; nothing when the item already shows it. */
  async applyDependencies(id: WorkItemId, v: DependencyVerdict): Promise<void> {
    await this.c.unit("transitions").decide(id, async (it) => {
      if (it.stage !== "RUNNING" || it.change_ref !== null || (it.blocked_on !== "none" && it.blocked_on !== "dependency")) return null;
      const short = (d: string) => shortRef(d, it.source.id);
      switch (v.kind) {
        case "clear":
          return it.blocked_on === "dependency"
            ? { patch: { blocked_on: "none", blocked_reason: null }, actor: SYSTEM, reason: "dependency_released" }
            : null;
        case "wait": {
          const reason = dependencyReason(v.open, it.source.id);
          if (it.blocked_on === "dependency" && it.blocked_reason === reason) return null;
          const patch = { blocked_on: "dependency" as const, blocked_reason: reason };
          await this.c.unit("outbox").comment(it, `dependency-hold:${it.id}:${v.open.join(",")}`, [
            `The implement run waits: ${reason}. It starts on its own once ${v.open.length === 1 ? "it merges" : "they merge"}; \`/approve\` does not lift a dependency hold.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: "dependency_hold", detail: { depends_on: v.open.join(",") } };
        }
        case "closed": {
          const patch = { blocked_on: "human" as const, blocked_reason: `${DEPENDENCY_CLOSED}:${short(v.dependency)}` };
          await this.c.unit("outbox").comment(it, `dependency-closed:${it.id}:${v.dependency}`, [
            `${short(v.dependency)}, which this item depends on, was closed without a merge, so the factory queued no implement run. A human decides how this item goes on.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: DEPENDENCY_CLOSED, detail: { depends_on: v.dependency }, cancel_queued_runs: true };
        }
        case "cycle": {
          const cycle = v.cycle.map(short).join(" → ");
          const patch = { blocked_on: "human" as const, blocked_reason: `${DEPENDENCY_CYCLE}: ${cycle}`.slice(0, 500) };
          await this.c.unit("outbox").comment(it, `dependency-cycle:${it.id}`, [
            `The dependencies of this item form a cycle, so the factory refused it and queued no implement run: ${cycle}. Remove one of the links, then a human decides how this item goes on.`,
            "",
            footerAfter(it, patch),
          ].join("\n"));
          return { patch, actor: SYSTEM, reason: DEPENDENCY_CYCLE, detail: { cycle: v.cycle.join(",") }, cancel_queued_runs: true };
        }
      }
    });
  }

  /** After `sourceId`'s item closed: every item waiting on it is re-checked from the store (no forge call). */
  async releaseDependents(sourceId: string): Promise<void> {
    for (const e of await this.c.k.d.store.listDependencyEdges({ depends_on: sourceId })) {
      await this.c.k.guard("dependent", () => this.coordinateItem(e.work_item_id, false));
    }
  }

  /**
   * One comment per coordination-cost hold (run, holder) the claim recorded on the item's queued implement run,
   * naming the hold reason, e.g. `waiting for #92 to merge: both change src/core/worker.ts (conflicted 6 times),
   * cost 4.0 > 2.5`. The status stays implementing.
   */
  async holdComment(id: WorkItemId): Promise<void> {
    const it = await this.c.k.d.store.getWorkItem(id);
    if (!it || it.stage !== "RUNNING" || it.blocked_on !== "none") return;
    const queued = new Set((await this.c.k.d.store.listRuns(id)).filter((r) => r.kind === "implement" && r.status === "queued").map((r) => r.id));
    const d = (await this.c.k.d.store.listClaimDecisions(id)).filter((x) => queued.has(x.run_id) && x.decision === "held" && !x.approved_by).at(-1);
    if (!d) return;
    await this.c.unit("outbox").comment(it, `coordination-hold:${d.run_id}:${d.holder_ref}`, [
      `The implement run is held: ${holdReason(d)}. It starts on its own when that work merges or no longer overlaps.`,
      "",
      `Reply \`/approve\` to start it now anyway (threshold \`max_coordination_cost\` = ${d.threshold}).`,
    ].join("\n"));
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "coordination": CoordinationUnit;
  }
}

export default controllerUnit({
  name: "coordination",
  create: (c: Ctx) => new CoordinationUnit(c),
  steps: [
    { name: "coordination", every: "poll", order: 50, run: (u) => u.coordinationStep() },
  ],
});

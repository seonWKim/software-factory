// The controller units' shared kernel (RFC 0015 M5).

import { LiveSettings, type ProjectSettings, settingValues } from "../../core/settings.js";
import { LOCAL_SOURCE } from "../../core/local-merge.js";
import { type SourceRef, type SourceType } from "../../core/types.js";
import type { Forge } from "../../interfaces/forge.js";
import type { SourceAdapter } from "../../interfaces/source-adapter.js";
import { type ControllerDeps, rateLimitWait } from "../../core/controller-deps.js";
import type { SqlDriver } from "../../state/index.js";

/**
 * The sources a controller runs (design 2026-11-01): any number, no two of one type. PRs come from the forge,
 * so no source type is required (issue #273). Errors name `plugins.source`, the config key that lists them.
 */
function checkSources(d: Pick<ControllerDeps, "source" | "sources">): readonly SourceAdapter[] {
  if (d.source !== undefined && d.sources !== undefined) throw new Error("Controller takes `source` or `sources`, not both");
  // None is allowed (issue #282): items and commands live in the store, and messages wait in the outbox.
  const sources = d.sources ?? (d.source ? [d.source] : []);
  const seen = new Set<SourceType>();
  for (const s of sources) {
    if (seen.has(s.type)) {
      throw new Error(`plugins.source lists two sources of type "${s.type}"; each source type can be listed once`);
    }
    seen.add(s.type);
  }
  return sources;
}

/**
 * What every unit shares (RFC 0015 M5): the legacy deps, the configured sources and forge, the live settings, and the
 * step guard. Built once per controller role; holds no decision.
 */
export class Kernel {
  /** The configured sources, in config order. Fixed at construction; the same on every replica. */
  readonly sources: readonly SourceAdapter[];
  readonly byType: ReadonlyMap<SourceType, SourceAdapter>;
  /** Where PRs live, or null when config selects no forge. Fixed at construction. */
  readonly forge: Forge | null;
  /** The settings in effect: a cache of the config file plus the stored overrides, refreshed each tick. */
  readonly live: LiveSettings;

  constructor(readonly d: ControllerDeps) {
    this.sources = checkSources(d);
    this.byType = new Map(this.sources.map((s) => [s.type, s]));
    this.forge = d.forge ?? null;
    this.live = d.settings ?? LiveSettings.fixed(d.config);
  }

  /** The config with each settable key at its effective value as of the last refresh. */
  get cfg() {
    return this.live.config();
  }

  /** Now, in ms, from the injected clock: the role's ticks and the units' time-based decisions (no-clock follow-up). */
  nowMs(): number {
    return this.d.clock.now().getTime();
  }

  /** The SQL driver under the store, for the controller's own actor tables (the merge queue); null for another store. */
  get db(): SqlDriver | null {
    return (this.d.store as { db?: SqlDriver }).db ?? null;
  }

  /** The configured repo's project key (design 2026-11-01): what every write and lookup uses. Never shown. */
  project(): string {
    return this.cfg.project.key;
  }

  /** The per-project gate settings of `project` (design 2026-11-01): the only way core reads them. */
  settings(project: string): ProjectSettings {
    return settingValues(project, this.cfg.settings, this.d.learned);
  }

  /** Whether this process can apply an item's transitions: it has the item's source adapter, or the item is local. */
  serves(type: SourceType): boolean {
    return type === LOCAL_SOURCE || this.byType.has(type);
  }

  /**
   * The adapter for `source`'s type. None configured (the source was removed from `plugins.source`): a
   * warning and null, so the call is skipped and the item keeps its state.
   */
  adapterFor(source: SourceRef, call: string): SourceAdapter | null {
    const adapter = this.byType.get(source.type);
    if (adapter) return adapter;
    // A local item's surface is the store itself: nothing to call, nothing to warn about.
    if (source.type === LOCAL_SOURCE) return null;
    this.d.log.warn("no source adapter for the item's source type; skipped", { source_type: source.type, source_id: source.id, call });
    return null;
  }

  async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A forge call refused with no calls left is a wait for the reset, not a failure: the step runs again next
      // poll, and every other step (local work) goes on.
      const until = rateLimitWait(err);
      if (until) this.d.log.warn("waiting for the GitHub rate-limit reset", { step: what, until });
      else this.d.log.error("loop step failed", { step: what, error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
    }
  }
}

// The tacit plugin a running process holds (design 08-settings, 2026-11-12): the config's `plugins.tacit` at start,
// then whatever the runtime `integrations` entry names. LiveSettings hands it the entry after each refresh (the
// controller and the worker pool each tick, the UI before each Rules request), and it rebuilds the plugin when the
// name changes: no restart. It keeps only the plugin it built and that plugin's name, never the entry itself.

import { errorText, type Logger } from "../core/log.js";
import type { IntegrationHolder } from "../core/settings.js";
import type { TacitDecision, TacitLedger, TacitPendingEntry, TacitPushback, TacitRule } from "../interfaces/tacit-ledger.js";

/** Builds the tacit plugin named `name`; throws for a name the registry does not hold. */
export type TacitBuild = (name: string) => Promise<TacitLedger>;

export class LiveTacit implements TacitLedger, IntegrationHolder {
  private applying: Promise<void> = Promise.resolve();
  private failed: string | null = null;

  private constructor(
    private readonly configured: string,
    private readonly build: TacitBuild,
    private readonly log: Logger | undefined,
    private name: string,
    private ledger: TacitLedger,
  ) {}

  /** The holder with the config's plugin (`configured`, the selection's `tacit`) built. */
  static async start(configured: string, build: TacitBuild, log?: Logger): Promise<LiveTacit> {
    return new LiveTacit(configured, build, log, configured, await build(configured));
  }

  /** The plugin name in use. */
  plugin(): string {
    return this.name;
  }

  get enabled(): boolean {
    return this.ledger.enabled;
  }

  /**
   * The `integrations` entry's `tacit`, else the config's choice: rebuilt when it differs from the plugin in use. A
   * build that fails keeps the plugin in use and warns once per name. Calls run one at a time.
   */
  apply(integrations: Readonly<Record<string, string>>): Promise<void> {
    const want = integrations.tacit ?? this.configured;
    this.applying = this.applying.then(async () => {
      if (want === this.name) return;
      try {
        this.ledger = await this.build(want);
      } catch (err) {
        if (this.failed !== want) this.log?.warn("tacit plugin could not be built; keeping the one in use", { plugin: want, in_use: this.name, error: errorText(err) });
        this.failed = want;
        return;
      }
      this.log?.info("tacit plugin switched", { from: this.name, to: want });
      this.name = want;
      this.failed = null;
    });
    return this.applying;
  }

  capture(p: TacitPushback): Promise<void> {
    return this.ledger.capture(p);
  }

  pending(): Promise<readonly TacitPendingEntry[]> {
    return this.ledger.pending();
  }

  verdict(id: string, decision: TacitDecision, reason: string, rule?: string): Promise<void> {
    return this.ledger.verdict(id, decision, reason, rule);
  }

  rules(): Promise<readonly TacitRule[]> {
    return this.ledger.rules();
  }
}

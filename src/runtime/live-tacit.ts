// The tacit plugin a running process holds (design 08-settings, 2026-11-12): the config's `plugins.tacit` at start,
// then whatever the runtime `integrations` entry names. LiveSettings hands it the entry after each refresh (the
// controller and the worker pool each tick, the UI before each Rules request), and it rebuilds the plugin when the
// name changes: no restart. It keeps only the plugin it built and that plugin's name, never the entry itself.
// The ledger is the TacitLedger interface (src/interfaces/tacit-ledger.ts), read structurally: a runtime component
// imports no legacy module.

/** What the holder delegates to: TacitLedger's shape. */
interface Ledger {
  readonly enabled: boolean;
  capture(...a: never[]): Promise<void>;
  pending(): Promise<unknown>;
  verdict(...a: never[]): Promise<void>;
  rules(): Promise<unknown>;
}

interface Log {
  info(msg: string, fields?: Record<string, string | null>): void;
  warn(msg: string, fields?: Record<string, string | null>): void;
}

export class LiveTacit<L extends Ledger> {
  private applying: Promise<void> = Promise.resolve();
  private failed: string | null = null;

  private constructor(
    private readonly configured: string,
    private readonly build: (name: string) => Promise<L>,
    private readonly log: Log | undefined,
    private name: string,
    private ledger: L,
  ) {}

  /** The holder with the config's plugin (`configured`, the selection's `tacit`) built; `build` throws for an unknown name. */
  static async start<L extends Ledger>(configured: string, build: (name: string) => Promise<L>, log?: Log): Promise<LiveTacit<L>> {
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
        const error = err instanceof Error ? err.message : String(err);
        if (this.failed !== want) this.log?.warn("tacit plugin could not be built; keeping the one in use", { plugin: want, in_use: this.name, error });
        this.failed = want;
        return;
      }
      this.log?.info("tacit plugin switched", { from: this.name, to: want });
      this.name = want;
      this.failed = null;
    });
    return this.applying;
  }

  capture(...a: Parameters<L["capture"]>): Promise<void> {
    return this.ledger.capture(...a);
  }

  pending(): ReturnType<L["pending"]> {
    return this.ledger.pending() as ReturnType<L["pending"]>;
  }

  verdict(...a: Parameters<L["verdict"]>): Promise<void> {
    return this.ledger.verdict(...a);
  }

  rules(): ReturnType<L["rules"]> {
    return this.ledger.rules() as ReturnType<L["rules"]>;
  }
}

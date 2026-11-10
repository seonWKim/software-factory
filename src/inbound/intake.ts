// Inbound intake (RFC 0015 §7 Inbound, M4): the only caller of a source's or the forge's poll. On inbound's
// `intake` tick it polls each source through its own cursor, the forge through its cursor, relays a stream
// source's records (its listener stored them) and the command rows, and stores this process's forge budget.
// Every record is stored with its InboundReceived in inbound's outbox, in the transaction that moves the cursor
// it was read through: a cursor never moves past a record that was not announced, and a record is never
// announced twice. Nothing here decides anything.
//
// The sync lease (design 05-coordination) is inbound's: only its holder polls the synced source type and the
// forge, its token fences their cursor moves, and the controller reads the same lease before its fenced
// deliveries. Time comes only from the tick.

import type { SourceType } from "../core/types.js";
import { type GitHubBudgetStatus, rateLimitWait } from "../core/controller-deps.js";
import type { TickLease } from "../core/lease.js";
import { errorText, type Logger } from "../core/log.js";
import type { SyncFence } from "../interfaces/factory-store.js";
import type { Forge } from "../interfaces/forge.js";
import type { PollSource, SourceAdapter, StreamSource } from "../interfaces/source-adapter.js";
import type { EventBus } from "../bus/index.js";
import { envelope, newMessageId, type Envelope } from "../shared/envelope.js";
import type { Tick } from "../shared/ticks/tick-generator.js";
import type { Dialect, SqlDriver, SqlExecutor } from "../state/index.js";
import {
  POLLED, commandActor, commandsAfter, fenceHolds, moveCursor, pruneRecords, readCursor, storeRecord, streamRecordsAfter, syncLeaseToken, type InboundEvent,
} from "./records.js";
import { INBOUND_RECEIVED } from "./topics/inbound-records.topic.js";

/** The cursor this process's forge budget is stored under after each poll, for the status page. */
export const GITHUB_BUDGET_CURSOR = "github:budget";
/** The command rows' cursor, and the `local` source's cursor it started from (issue #282). */
export const COMMANDS_CURSOR = "commands";
const LEGACY_LOCAL_CURSOR = "intake:local";
/** The stream of a command that names no source: the CLI's and the UI's. */
export const LOCAL_STREAM = "local";
/** Records and commands relayed per tick at most. */
const RELAY_BATCH = 100;
const DAY_MS = 86_400_000;
/** InboundReceived and its record's messages come again only by redelivery, well within the topic's retention. */
export const RECORD_TTL_MS = 7 * DAY_MS;

export interface InboundConfig {
  readonly poll_interval_ms: number;
  readonly inbox_retention_days: number;
  readonly project_key: string;
}

export interface InboundDeps {
  readonly db: SqlDriver;
  readonly dialect: Dialect;
  /** The bus as inbound publishes: it writes `inbound_outbox` in inbound's transaction. */
  readonly bus: EventBus;
  readonly sources: readonly SourceAdapter[];
  readonly forge: Forge | null;
  /** Read on every tick, so a poll interval or retention change applies at the next one. */
  readonly config: () => InboundConfig;
  /** The sync lease of `type`, held by one replica per project; null when no source or forge needs one. */
  readonly sync: { readonly lease: TickLease; readonly type: SourceType } | null;
  /** True while the forge's rate-limit pause holds: the synced type and the forge are not polled. */
  readonly forgePaused: () => Promise<boolean>;
  /** This process's forge budget, stored after each poll; absent with no forge client. */
  readonly budget?: () => GitHubBudgetStatus | null;
  /** Reads the shared forge budget into the forge client before the polls. */
  readonly refreshBudget?: () => Promise<void>;
  readonly replica_id?: string;
  /** Runs one stream source's listener (it stores pushed events as records) until `signal` aborts. */
  readonly listen?: (source: StreamSource, signal: AbortSignal) => Promise<void>;
  /**
   * The edge passport of a command row that has none (a comment command a poll stored) or of a stream source's
   * command event (a Slack `/approve`): Identity authenticates its actor through the provider mapping (RFC 0015 §8,
   * M9). Null when no provider resolves the actor; the controller's authorize still decides. Absent: commands keep
   * the passport their row has, and stream records get none.
   */
  readonly passportFor?: (origin: string, actor: string) => Promise<string | null>;
  readonly log: Logger;
}

interface Polled {
  readonly type: SourceType;
  readonly cursorName: string;
  readonly cursor: string | null;
  readonly events: readonly InboundEvent[];
  readonly next: string;
}

/** The seq a stream cursor holds; no cursor means before the first record. */
export function streamSeq(cursor: string | null): number {
  if (cursor === null) return 0;
  const n = Number(cursor);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`inbox cursor is not a sequence number: ${cursor.slice(0, 40)}`);
  return n;
}

/** The cursor a stream source's records are relayed through (one per source type, shared by every replica). */
export function inboxCursorName(type: SourceType): string {
  return `inbox:${type}`;
}

/** Thrown inside a transaction to roll it back: another writer moved the cursor, or the lease was taken. */
class Stale extends Error {
  constructor(readonly fenced: boolean) {
    super(fenced ? "sync lease taken over" : "cursor moved");
  }
}

export class Inbound {
  /** When this process last polled, ms; a throttle only, no other replica needs it. */
  private lastPoll = -Infinity;
  private readonly polls: readonly PollSource[];
  private readonly streams: readonly StreamSource[];

  constructor(private readonly d: InboundDeps) {
    this.polls = d.sources.filter((s): s is PollSource => s.intake === "poll");
    this.streams = d.sources.filter((s): s is StreamSource => s.intake === "stream");
  }

  /**
   * The `intake` tick: the sync lease, then (on the poll interval, or `force`) the polls, then every tick the
   * stream records and the commands, which are store reads. Each step runs on its own guard, so one failing never
   * stops the others.
   */
  async tick(t: Tick, force = false): Promise<void> {
    await this.guard("sync", () => this.syncStep());
    const now = Date.parse(t.now);
    if (force || now - this.lastPoll >= this.d.config().poll_interval_ms) {
      this.lastPoll = now;
      await this.poll(t);
    }
    for (const s of this.streams) await this.guard(`intake:${s.type}`, () => this.relayStream(s, t));
    await this.guard("commands", () => this.relayCommands(t));
  }

  /** The command rows after the cursor, announced in order (the CLI's, the UI's and the comment commands a poll stored). */
  async relayCommands(t: Tick): Promise<void> {
    const cursor = await readCursor(this.d.db, COMMANDS_CURSOR);
    const start = cursor ?? (await readCursor(this.d.db, LEGACY_LOCAL_CURSOR));
    const after = start ? Number(start) : 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error(`command inbox: bad cursor ${JSON.stringify(start)}`);
    const rows = await commandsAfter(this.d.db, after, RELAY_BATCH);
    if (rows.length === 0) return;
    // Passports are minted before the commit: one minted for a commit that loses its cursor race is never used.
    const announced: Envelope[] = [];
    for (const c of rows) {
      const passport = c.passport_id ?? (await this.d.passportFor?.(c.origin, c.actor)) ?? null;
      announced.push(this.received(c.id, "command", streamOf(c.args.source), t, passport));
    }
    await this.commit(COMMANDS_CURSOR, cursor, String(rows.at(-1)!.seq), null, async () => announced);
  }

  /** Removes records past `inbox_retention_days` (the `prune` tick); a stream's only once its cursor passed them. */
  async prune(t: Tick): Promise<void> {
    const before = new Date(Date.parse(t.now) - this.d.config().inbox_retention_days * DAY_MS).toISOString();
    const streams: { type: SourceType; through: number }[] = [];
    for (const s of this.streams) {
      const cursor = await readCursor(this.d.db, inboxCursorName(s.type));
      if (cursor !== null) streams.push({ type: s.type, through: streamSeq(cursor) });
    }
    const deleted = await this.d.db.transaction((tx) => pruneRecords(tx, before, streams));
    if (deleted > 0) this.d.log.info("inbox cleanup", { deleted });
  }

  /** Runs each stream source's listener until `signal` aborts. */
  async run(signal: AbortSignal): Promise<void> {
    const listen = this.d.listen;
    await Promise.all(listen ? this.streams.map((s) => listen(s, signal)) : []);
  }

  private async syncStep(): Promise<void> {
    if (!this.d.sync) return;
    await this.d.sync.lease.tick();
    await this.d.refreshBudget?.();
  }

  private syncedElsewhere(): boolean {
    return this.d.sync?.lease.current?.kind === "other";
  }

  private fenceFor(type: SourceType): SyncFence | null {
    const st = this.d.sync?.lease.current;
    return type === this.d.sync?.type && st?.kind === "held" ? st.fence : null;
  }

  /**
   * One poll of every source not skipped, then of the forge. The sources are read first and stored after the
   * forge (issue #273): a merge that closed an issue is announced before the close, in the same stream.
   */
  private async poll(t: Tick): Promise<void> {
    const sync = this.d.sync;
    const paused = sync !== null && (await this.d.forgePaused());
    const skip = (type: SourceType) => type === sync?.type && (paused || this.syncedElsewhere());
    const polled: Polled[] = [];
    for (const s of this.polls) {
      if (skip(s.type)) continue;
      await this.guard(`intake:${s.type}`, async () => {
        const cursorName = `intake:${s.type}`;
        const cursor = await readCursor(this.d.db, cursorName);
        const r = await s.poll(cursor);
        polled.push({ type: s.type, cursorName, cursor, events: r.events, next: r.next_cursor });
      });
    }
    const forge = this.d.forge;
    if (forge && !skip(forge.ref_type)) await this.guard("forge", () => this.pollForge(forge, t));
    for (const p of polled) await this.guard(`intake:${p.type}`, () => this.store(p, t));
    if (!this.syncedElsewhere()) await this.guard("forge budget", () => this.recordBudget());
  }

  /** The forge through `forge:<ref type>`; while that is empty, through its handover cursor (issue #273). */
  private async pollForge(forge: Forge, t: Tick): Promise<void> {
    const cursorName = `forge:${forge.ref_type}`;
    const cursor = await readCursor(this.d.db, cursorName);
    const first = cursor ?? (forge.handover_cursor ? await readCursor(this.d.db, forge.handover_cursor) : null);
    const r = await forge.poll(first);
    await this.store({ type: forge.ref_type, cursorName, cursor, events: r.events, next: r.next_cursor }, t);
  }

  /** One poll's records, their announcements and the cursor move, in one transaction. */
  private async store(p: Polled, t: Tick): Promise<void> {
    await this.commit(p.cursorName, p.cursor, p.next, this.fenceFor(p.type), async (tx) => {
      const out: Envelope[] = [];
      // A poll's records have no key of their own (two polls from one cursor may read different events): one per poll.
      const poll = newMessageId();
      for (const [i, event] of p.events.entries()) {
        const id = await storeRecord(tx, this.d.dialect, { source_type: p.type, dedupe_key: `${POLLED}${poll}:${i}`, event, received_at: t.now });
        out.push(this.received(id, "event", p.type, t));
      }
      return out;
    });
  }

  /** A stream source's records after its cursor, announced in order. Any replica may run it. */
  private async relayStream(s: StreamSource, t: Tick): Promise<void> {
    const name = inboxCursorName(s.type);
    const cursor = await readCursor(this.d.db, name);
    const rows = await streamRecordsAfter(this.d.db, s.type, streamSeq(cursor), RELAY_BATCH);
    if (rows.length === 0) return;
    // A command event's passport is minted before the commit, as a command row's; other events get none.
    const announced: Envelope[] = [];
    for (const r of rows) {
      const actor = commandActor(r.event);
      const passport = actor ? ((await this.d.passportFor?.(actor.provider, `${actor.provider}:${actor.subject}`)) ?? null) : null;
      announced.push(this.received(r.id, "event", s.type, t, passport));
    }
    await this.commit(name, cursor, String(rows.at(-1)!.seq), null, async () => announced);
  }

  /**
   * Moves cursor `name` and publishes what `write` stored, in one transaction, fenced by `fence` when given. A
   * cursor another writer moved first, or a lease taken over, rolls everything back: that writer announced them.
   */
  private async commit(
    name: string,
    expected: string | null,
    next: string,
    fence: SyncFence | null,
    write: (tx: SqlExecutor) => Promise<Envelope[]>,
  ): Promise<void> {
    try {
      await this.d.db.transaction(async (tx) => {
        if (fence && !(await fenceHolds(tx, this.d.db.dialect.forUpdate, fence))) throw new Stale(true);
        const messages = await write(tx);
        if (!(await moveCursor(tx, this.d.dialect, name, expected, next))) throw new Stale(false);
        await this.d.bus.publish(tx, messages);
      });
    } catch (err) {
      if (!(err instanceof Stale)) throw err;
      // The lease's token moved on: another replica took it, so drop it now rather than at the next heartbeat.
      if (err.fenced && fence && (await syncLeaseToken(this.d.db, fence.name)) !== fence.token) this.d.sync?.lease.lost();
    }
  }

  /** `passport`: a command's edge passport; the normalizer's CommandReceived or SourceEventReceived inherits it as its cause's. */
  private received(id: string, kind: "event" | "command", stream: string, t: Tick, passport: string | null = null): Envelope {
    return envelope(
      { type: INBOUND_RECEIVED, subject: stream, idempotency_key: id, idempotency_key_ttl_ms: RECORD_TTL_MS, payload: { record_id: id, kind } },
      { id: null, correlation_id: id, project_id: this.d.config().project_key, passport_id: passport, occurred_at: t.now },
      "inbound",
    );
  }

  /** This process's forge budget, replacing the stored one (never merged). */
  private async recordBudget(): Promise<void> {
    const status = this.d.budget?.();
    if (!status) return;
    const value = JSON.stringify({ ...status, replica_id: this.d.replica_id ?? null });
    await this.d.db.transaction(async (tx) => {
      await moveCursor(tx, this.d.dialect, GITHUB_BUDGET_CURSOR, await readCursor(tx, GITHUB_BUDGET_CURSOR), value);
    });
  }

  private async guard(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      // A forge call refused with no calls left is a wait for the reset, not a failure: the next poll tries again.
      const until = rateLimitWait(err);
      if (until) this.d.log.warn("waiting for the GitHub rate-limit reset", { step: what, until });
      else this.d.log.error("loop step failed", { step: what, error: errorText(err) });
    }
  }
}

/** A command's stream: the source type of the item it was written on, else the CLI's and the UI's. */
function streamOf(source: unknown): string {
  const type = (source as { type?: unknown } | null)?.type;
  return typeof type === "string" && type !== "" ? type : LOCAL_STREAM;
}

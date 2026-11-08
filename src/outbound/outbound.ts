// Outbound's flush (RFC 0015 §7, §15.1): on the `outbound-flush` tick, each destination's oldest unsent batch whose
// flush time came is sent by the targets, in intent order. One batch at a time per destination keeps its order.
// A batch is claimed (one sender), its text is scanned (G5), and its intents are delivered; when all are, the batch
// is marked sent and DeliveryCompleted is published in one transaction. A failure retries the whole batch with
// backoff: intents already delivered are skipped on the retry, so nothing is written twice.

import type { EventBus } from "../bus/index.js";
import { retryDelayMs } from "../core/policy.js";
import type { Logger } from "../core/log.js";
import type { EgressScanner } from "../interfaces/egress-scanner.js";
import type { FactoryStore, SyncFence } from "../interfaces/factory-store.js";
import { envelope } from "../shared/envelope.js";
import type { Tick } from "../shared/ticks/tick-generator.js";
import { addMs } from "../shared/time.js";
import type { SqlDriver } from "../state/index.js";
import { ACTION_INTENT, THREAD_INTENT, actionOf } from "./intents.js";
import type { Delivery, DeliveryTarget } from "./targets/target.js";
import { DELIVERY_COMPLETED } from "./topics/deliveries-results.topic.js";

export interface OutboundDeps {
  readonly db: SqlDriver;
  /** Outbound's bus: DeliveryCompleted goes to its outbox. */
  readonly bus: EventBus;
  /** The thread outbox rows (outbound_intents), through the legacy store until it shrinks (M11). */
  readonly store: Pick<FactoryStore, "getDelivery" | "claimDelivery" | "finishDelivery" | "failDelivery" | "getPostedComment">;
  readonly targets: readonly DeliveryTarget[];
  readonly scanner: EgressScanner;
  readonly log: Logger;
  config(): { lease_ms: number; retry_base_ms: number; retry_max_ms: number; project_key: string };
  /** Whether this process writes to `source_type` now (the sync lease: only its holder writes the synced type). */
  canSend(source_type: string): boolean;
  /**
   * The destination kinds (`<kind>:<ref>`) this process may write now: its adapters' types and the forge's, those
   * `canSend` allows. A flush selects only these, so batches no process here can send never crowd out the rest.
   */
  kinds(): readonly string[];
  /** The fence of a write to `source_type`: the held sync lease for the synced type, else none. */
  fenceFor(source_type: string): SyncFence | null;
  /** A fenced claim was refused: the lease may have moved on. */
  fenceRefused(fence: SyncFence): Promise<void>;
}

/** Batches one flush sends at most. */
const FLUSH_BATCH = 50;

type Loaded = { id: string; delivery: Delivery; seq: number; done: boolean; attempts: number };

/** Why a batch stopped: the failure retries it whole; a refused claim leaves it for its holder. */
class Stop extends Error {
  constructor(readonly retry_in_ms: number | null, message: string) {
    super(message);
  }
}

export class Outbound {
  constructor(private readonly d: OutboundDeps) {}

  /** Sends every due batch this process can; returns how many it sent. */
  async flush(t: Tick): Promise<number> {
    const now = t.now;
    const kinds = this.d.kinds();
    if (kinds.length === 0) return 0;
    const rows = await this.d.db.all(
      `SELECT b.* FROM outbound_batches b WHERE b.state <> 'sent' AND b.flush_at <= ?
         AND (${kinds.map(() => "SUBSTR(b.destination, 1, ?) = ?").join(" OR ")})
         AND NOT EXISTS (SELECT 1 FROM outbound_batches o WHERE o.destination = b.destination AND o.state <> 'sent' AND o.seq < b.seq)
       ORDER BY b.seq LIMIT ${FLUSH_BATCH}`,
      [now, ...kinds.flatMap((k) => [k.length + 1, `${k}:`])],
    );
    let sent = 0;
    for (const b of rows) {
      if (b.state === "sending" && b.claimed_until !== null && String(b.claimed_until) > now) continue;
      try {
        if (await this.send(b, now)) sent++;
      } catch (err) {
        this.d.log.error("outbound batch failed", { batch_id: String(b.id), error: err instanceof Error ? err.message.slice(0, 300) : "unknown" });
      }
    }
    return sent;
  }

  private async send(b: Record<string, unknown>, now: string): Promise<boolean> {
    const id = String(b.id);
    const ids = await this.d.db.all("SELECT intent_id, commit_id, commit_count FROM outbound_batch_intents WHERE batch_id = ? ORDER BY seq", [id]);
    // A batch is complete when every intent of each of its commits arrived.
    const commits = new Map<string, { n: number; of: number }>();
    for (const r of ids) {
      const c = commits.get(String(r.commit_id)) ?? { n: 0, of: Number(r.commit_count) };
      commits.set(String(r.commit_id), { ...c, n: c.n + 1 });
    }
    if ([...commits.values()].some((c) => c.n < c.of)) return false;
    const intents: Loaded[] = [];
    for (const r of ids) {
      const l = await this.load(String(r.intent_id));
      if (l) intents.push(l);
    }
    // Not every intent can be written here (no adapter, or the sync lease is another replica's): left for one that can.
    if (!intents.every((i) => i.done || (this.target(i.delivery) !== null && this.d.canSend(typeOf(i.delivery))))) return false;
    const until = addMs(now, this.d.config().lease_ms);
    const claimed = await this.d.db.run(
      `UPDATE outbound_batches SET state = 'sending', claim_token = claim_token + 1, claimed_until = ?
       WHERE id = ? AND state <> 'sent' AND claim_token = ?`,
      [until, id, Number(b.claim_token)],
    );
    if (claimed === 0) return false;
    const token = Number(b.claim_token) + 1;
    try {
      for (const i of intents) if (!i.done) await this.deliver(i, now);
    } catch (err) {
      if (!(err instanceof Stop)) throw err;
      const state = err.retry_in_ms === null ? "open" : "failed";
      const flush = err.retry_in_ms === null ? now : addMs(now, err.retry_in_ms);
      await this.d.db.run(
        `UPDATE outbound_batches SET state = ?, attempts = attempts + ?, last_error = ?, flush_at = ?, claimed_until = NULL
         WHERE id = ? AND claim_token = ?`,
        [state, err.retry_in_ms === null ? 0 : 1, err.message.slice(0, 1000), flush, id, token],
      );
      return false;
    }
    const destination = String(b.destination);
    const intent_ids = intents.map((i) => i.id);
    await this.d.db.transaction(async (tx) => {
      const n = await tx.run(
        "UPDATE outbound_batches SET state = 'sent', sent_at = ?, claimed_until = NULL, last_error = NULL WHERE id = ? AND claim_token = ?",
        [now, id, token],
      );
      if (n === 0) return;
      await this.d.bus.publish(tx, [envelope(
        { type: DELIVERY_COMPLETED, subject: destination, idempotency_key: id, idempotency_key_ttl_ms: 7 * 86_400_000, payload: { batch_id: id, destination, intent_ids } },
        { id: null, correlation_id: id, project_id: this.d.config().project_key, passport_id: null, occurred_at: now },
        "outbound",
      )]);
    });
    return true;
  }

  private target(d: Delivery): DeliveryTarget | null {
    return this.d.targets.find((t) => t.accepts(d)) ?? null;
  }

  private async load(intent_id: string): Promise<Loaded | null> {
    if (intent_id.startsWith(THREAD_INTENT)) {
      const seq = Number(intent_id.slice(THREAD_INTENT.length));
      const row = await this.d.store.getDelivery(seq);
      if (!row) return null;
      return {
        id: intent_id, seq, done: row.delivered_at !== null, attempts: row.attempts,
        delivery: { kind: "comment", source_type: row.source_type, target: row.target, body: row.body, marker: row.marker },
      };
    }
    if (intent_id.startsWith(ACTION_INTENT)) {
      const seq = Number(intent_id.slice(ACTION_INTENT.length));
      const [row] = await this.d.db.all("SELECT * FROM outbound_actions WHERE seq = ?", [seq]);
      if (!row) return null;
      const a = actionOf(row);
      return { id: intent_id, seq, done: a.delivered_at !== null, attempts: 0, delivery: { kind: "action", row: a } };
    }
    return null;
  }

  /**
   * G5 on every text that leaves. A flagged text is never written in any form: the intent is delivered once, under
   * its marker, as a notice naming the rules only, so it is not retried and the destination's later batches go on.
   */
  private async scanned(text: string, source_id: string): Promise<string> {
    const r = await this.d.scanner.scan("comment", text);
    if (r.clean) return text;
    const rules = [...new Set(r.findings.map((f) => f.rule))].join(", ");
    this.d.log.warn("message blocked by the egress scan; withheld", { source_id, rules });
    return `A factory message was withheld by the leak scanner (${rules}). It is not posted in any form.`;
  }

  private async deliver(i: Loaded, now: string): Promise<void> {
    const target = this.target(i.delivery)!;
    const cfg = this.d.config();
    const d = i.delivery;
    if (d.kind === "comment") {
      const fence = this.d.fenceFor(d.source_type);
      // Fenced: a replica whose sync lease was taken over claims nothing, so no comment goes out twice.
      const token = await this.d.store.claimDelivery(i.seq, cfg.lease_ms, ...(fence ? [fence] : []));
      if (token === null) {
        if (fence) await this.d.fenceRefused(fence);
        throw new Stop(null, "intent claimed elsewhere");
      }
      // A marker the store has a posted record of is delivered with its URL and no call; a changed body is not
      // edited, only logged.
      const stored = await this.d.store.getPostedComment(d.target.id, d.marker, d.body);
      if (stored?.comment_id) {
        if (!stored.same_body) this.d.log.warn("comment already posted with another body; not edited", { source_id: d.target.id, marker: d.marker });
        await this.d.store.finishDelivery(i.seq, token, stored.url);
        return;
      }
      let url: string | null;
      try {
        url = (await target.deliver({ ...d, body: await this.scanned(d.body, d.target.id) })).url;
      } catch (err) {
        const error = err instanceof Error ? err.message.slice(0, 300) : "unknown";
        const delay = retryDelayMs(i.attempts + 1, cfg.retry_base_ms, cfg.retry_max_ms);
        this.d.log.warn("outbox delivery failed; retried later", { outbox_seq: i.seq, target: target.name, attempts: i.attempts + 1, retry_in_ms: delay, error });
        await this.d.store.failDelivery(i.seq, token, error, delay);
        throw new Stop(delay, error);
      }
      await this.d.store.finishDelivery(i.seq, token, url);
      return;
    }
    const row = d.row;
    let outcome = "sent";
    let error: string | null = null;
    try {
      const body = row.action === "post" ? await this.scanned(String(row.args.body), row.target.id) : null;
      await target.deliver(body === null ? d : { ...d, row: { ...row, args: { ...row.args, body } } });
    } catch (err) {
      error = err instanceof Error ? err.message.slice(0, 300) : "unknown";
      // A close, a post or a PR close retries with its batch; a status label or a 👀 is best effort: a warning, never a hold.
      if (row.action === "close" || row.action === "post" || row.action === "close_pr") {
        const [b] = await this.d.db.all(
          "SELECT b.attempts FROM outbound_batches b JOIN outbound_batch_intents i ON i.batch_id = b.id WHERE i.intent_id = ?",
          [i.id],
        );
        const delay = retryDelayMs(Number(b?.attempts ?? 0) + 1, cfg.retry_base_ms, cfg.retry_max_ms);
        this.d.log.warn(`${row.action} failed; retried later`, { target: target.name, source_id: row.target.id, retry_in_ms: delay, error });
        throw new Stop(delay, error);
      }
      this.d.log.warn(row.action === "seen" ? "mark seen failed" : "set status failed", { target: target.name, source_id: row.target.id, error });
      outcome = "failed";
    }
    await this.d.db.run("UPDATE outbound_actions SET delivered_at = ?, outcome = ?, last_error = ? WHERE seq = ? AND delivered_at IS NULL", [
      now, outcome, error, row.seq,
    ]);
  }
}

function typeOf(d: Delivery): string {
  return d.kind === "comment" ? d.source_type : d.row.source_type;
}

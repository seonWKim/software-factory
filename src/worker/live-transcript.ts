// An agent step's transcript in shared storage (design 09-dashboard-item, live transcript): while the step runs,
// its output so far (the runner's `live` callback), at most once per LIVE_WRITE_MS and only when it grew; when the
// step ends, its whole output, which replaces the last partial one. The key is `transcripts/<item>/<run>.json`, or
// `<run>.<step>.json` for a second step of the same run.
//
// G5 before every write, on channel `log`. A known secret value or the canary fails the run (egress_blocked); in a
// partial write it also stops the agent through `stop`. A pattern hit alone (a token-shaped test fixture a failing
// test printed) only skips that write: the commit, PR and comment scans still stop that text from leaving.
//
// The throttle state lives in this object only, for one step of one run in this worker; nothing another worker
// needs. A partial write that fails is logged and skipped; the run goes on.

import { RunFailure, TRANSCRIPT_FAIL_RULES, type WorkerDeps } from "./support.js";

/** The least time between two partial writes of one step (owner answer: rewrite at most every 5 s). */
export const LIVE_WRITE_MS = 5000;

type Deps = Pick<WorkerDeps, "scanner" | "storage" | "clock" | "log">;

export class LiveTranscript {
  /** Aborted when a partial write finds a fail rule: the runner stops the agent. */
  readonly stop = new AbortController();
  private readonly key: string;
  private latest = "";
  /** The length of the text last written or skipped; a write needs more. */
  private done = 0;
  private lastAt = Number.NEGATIVE_INFINITY;
  private writing: Promise<void> | null = null;
  private timer: AbortController | null = null;
  private closed = false;
  private failure: RunFailure | null = null;

  constructor(
    private readonly d: Deps,
    private readonly run: { item: string; run: string; step?: string | undefined },
  ) {
    this.key = `transcripts/${run.item}/${run.run}${run.step ? `.${run.step}` : ""}.json`;
  }

  /** The runner's live callback: the step's output so far. Only whole lines are written, so no page shows a cut event. */
  readonly push = (text: string): void => {
    if (this.closed) return;
    this.latest = text.slice(0, text.lastIndexOf("\n") + 1);
    this.schedule();
  };

  /** Stops partial writes and waits for the one in flight; safe to call twice. */
  close(): Promise<void> {
    this.closed = true;
    this.timer?.abort();
    return this.writing ?? Promise.resolve();
  }

  /** The end-of-step write: after close, the fail rule of a partial write, else the whole output's scan and write. */
  async finish(transcript: string): Promise<void> {
    await this.close();
    if (this.failure) throw this.failure;
    const rules = await this.rules(transcript);
    if (rules.some((r) => TRANSCRIPT_FAIL_RULES.includes(r))) throw new RunFailure("egress_blocked", rules.join(","));
    if (rules.length > 0) {
      this.d.log.warn("transcript not stored: the egress scan flagged it", this.fields(rules));
    } else {
      await this.d.storage.put(this.key, new TextEncoder().encode(transcript));
    }
  }

  private schedule(): void {
    if (this.closed || this.writing || this.timer || this.latest.length <= this.done) return;
    const wait = this.lastAt + LIVE_WRITE_MS - this.d.clock.now().getTime();
    if (wait <= 0) {
      this.writing = this.write().finally(() => {
        this.writing = null;
        this.schedule();
      });
      return;
    }
    const timer = new AbortController();
    this.timer = timer;
    this.d.clock.sleep(wait, timer.signal).then(
      () => {
        this.timer = null;
        this.schedule();
      },
      () => undefined,
    );
  }

  private async write(): Promise<void> {
    const text = this.latest;
    this.done = text.length;
    this.lastAt = this.d.clock.now().getTime();
    try {
      const rules = await this.rules(text);
      if (rules.some((r) => TRANSCRIPT_FAIL_RULES.includes(r))) {
        this.failure = new RunFailure("egress_blocked", rules.join(","));
        this.closed = true;
        this.stop.abort(this.failure);
        return;
      }
      if (rules.length > 0) {
        this.d.log.warn("partial transcript not stored: the egress scan flagged it", this.fields(rules));
        return;
      }
      await this.d.storage.put(this.key, new TextEncoder().encode(text));
    } catch {
      // The next write, or the end-of-step one, tries again; the storage error's text stays out of the log.
      this.d.log.warn("partial transcript not stored: the write failed", this.fields([]));
    }
  }

  private async rules(text: string): Promise<string[]> {
    const scan = await this.d.scanner.scan("log", text);
    return scan.clean ? [] : scan.findings.map((f) => f.rule);
  }

  private fields(rules: readonly string[]) {
    return { run_id: this.run.run, step: this.run.step ?? "", ...(rules.length > 0 ? { rules: rules.join(",") } : {}) };
  }
}

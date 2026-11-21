import { describe, expect, it } from "vitest";
import type { Clock } from "../../src/interfaces/clock.js";

// RFC 0023 R2: the Clock contract (src/interfaces/clock.ts), run over every implementation by clock.contract.test.ts.
// Leases, timestamps and polling read `now()` and wait with `sleep()`; feature tests do it on a FakeClock, so the fake
// must keep the same promises as SystemClock.

/** One clock under test, and how to let its time pass: a real wait for SystemClock, `advance` for FakeClock. */
export interface ClockUnderTest {
  clock: Clock;
  pass(ms: number): Promise<void>;
}

/**
 * A timer may fire up to 1 ms before `Date.now()` shows the full delay (Node rounds timer and wall time differently),
 * so "at least `ms` passed" is checked to within 1 ms.
 */
const TIMER_SLACK_MS = 1;

/** Whether `p` has settled, without waiting for it. */
function track(p: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { settled: () => done };
}

/** Lets pending promise callbacks run. */
const flush = () => new Promise<void>((r) => setImmediate(r));

export function clockContract(make: () => ClockUnderTest): void {
  describe("now", () => {
    // Bug: time that passes is not seen by now() (a fake whose advance forgets to move it), so a lease never expires.
    it("moves forward by the time that passed", async () => {
      const { clock, pass } = make();
      const before = clock.now().getTime();
      await pass(50);
      expect(clock.now().getTime() - before).toBeGreaterThanOrEqual(50 - TIMER_SLACK_MS);
    });

    // Bug: now() hands out one shared Date, so a caller that adds to it (a lease's expiry) moves the clock.
    it("returns a new Date each call, so changing one does not move the clock", () => {
      const { clock } = make();
      const first = clock.now();
      const at = first.getTime();
      first.setTime(at + 3_600_000);
      expect(clock.now().getTime()).toBeLessThan(at + 3_600_000);
    });
  });

  describe("sleep", () => {
    // Bug: a sleep that resolves early, so a poll loop spins or a backoff does not back off.
    it("resolves only once its time has passed", async () => {
      const { clock, pass } = make();
      const sleep = track(clock.sleep(1_000));
      await pass(10);
      await flush();
      expect(sleep.settled()).toBe(false);
      await pass(1_000);
      await flush();
      expect(sleep.settled()).toBe(true);
    });

    // Bug: several waiters (lease renewal, a poll, a retry) wake out of deadline order, so the earliest one acts last.
    it("wakes sleepers in the order of their deadlines", async () => {
      const { clock, pass } = make();
      const woke: number[] = [];
      const late = clock.sleep(40).then(() => woke.push(40));
      const early = clock.sleep(10).then(() => woke.push(10));
      await pass(60);
      await Promise.all([late, early]);
      expect(woke).toEqual([10, 40]);
    });

    // Bug: a stop that arrives before the wait starts is ignored, so a stopped run sleeps its full backoff.
    it("rejects at once with the signal's reason when the signal is already aborted", async () => {
      const { clock } = make();
      const ctl = new AbortController();
      const reason = new Error("stopped");
      ctl.abort(reason);
      await expect(clock.sleep(10_000, ctl.signal)).rejects.toBe(reason);
    });

    // Bug: aborting mid-sleep does not wake the sleeper, so a stop waits out the whole delay.
    it("rejects with the signal's reason when aborted mid-sleep, before its time", async () => {
      const { clock } = make();
      const ctl = new AbortController();
      const reason = new Error("stopped");
      const sleep = clock.sleep(10_000, ctl.signal);
      ctl.abort(reason);
      await expect(sleep).rejects.toBe(reason);
    });
  });
}

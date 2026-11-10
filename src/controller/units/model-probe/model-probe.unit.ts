// The model-stall and network pauses' probes.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import { STALL_DEFAULTS } from "../../../core/config.js";
import { MODEL_STALL, NETWORK, NETWORK_SINCE, type ProbePause, networkProbeDelayMs } from "../../../core/policy.js";
import { type Timestamp } from "../../../core/types.js";
import type { LLMProvider } from "../../../interfaces/llm-provider.js";
import { iso } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** The model-stall and network pauses' probes. */
export class ModelProbeUnit {
  constructor(private readonly c: Ctx) {}

  /**
   * The probe pauses (design §5 Restarts), one schedule for both: once a pause's probe time has passed, the replica
   * whose conditional write moves it to the next probe time (claimProbe) probes, and no other one. A pass ends the
   * pause (endClaimPause), so claims resume; a failure keeps the pause and moves the next probe the pause's delay
   * after the failed probe. Any live controller may take a due probe, not only the one that set the pause.
   * `model_stall`: one short prompt on the cheap model class; no answer within stall_ms (an error, a refusal, a
   * throw) is a failure, the next probe probe_interval_ms later. With no LLM provider the pause ends at its probe.
   * `network`: the NetworkProbe, the next probe 30 s later, backing off to 5 min (networkProbeDelayMs).
   */
  async probeStep(): Promise<void> {
    const llm = this.c.k.d.llm;
    await this.probePause(MODEL_STALL, {
      delayMs: async () => this.c.k.cfg.probe_interval_ms ?? STALL_DEFAULTS.probe_interval_ms,
      probe: llm ? async () => ((await this.probe(llm)) ? null : "no answer") : null,
      // The model answered, so a stall pattern is its items', not the model's: they are held (design 05-restarts).
      ...(llm ? { onPass: () => this.c.unit("alarms").holdStalled() } : {}),
      passed: llm ? "model answered the probe: runs resume" : "no LLM provider to probe: the stall pause ends",
      failed: (next) => this.c.k.d.log.warn(`model not answering the probe: runs stay paused, next probe at ${next}`, { resume_at: next }),
    });
    const net = this.c.k.d.network_probe;
    await this.probePause(NETWORK, {
      delayMs: async (now) => {
        const since = await this.c.k.d.store.getClaimPause(NETWORK_SINCE);
        return networkProbeDelayMs(since === null ? 0 : now - Date.parse(since));
      },
      probe: net ? async () => {
        const r = await net.probe().catch(() => ({ ok: false as const, host: "unknown host" }));
        return r.ok ? null : r.host;
      } : null,
      passed: "network reachable again: claims resume",
      // Info, not warn: the pause's start was the one warning; the host is the only detail.
      failed: (next, host) => this.c.k.d.log.info(`network still unreachable: runs stay paused, next probe at ${next}`, { host, resume_at: next }),
    });
  }

  /** One probe pause's due probe; see probeStep. `probe` resolves null on a pass, else what failed. */
  async probePause(
    name: ProbePause,
    p: {
      delayMs: (now: number) => Promise<number>;
      probe: (() => Promise<string | null>) | null;
      /** After a pass, before the pause ends: what the pass changes besides ending it. */
      onPass?: () => Promise<void>;
      passed: string;
      failed: (next: Timestamp, why: string) => void;
    },
  ): Promise<void> {
    const due = await this.c.k.d.store.getClaimPause(name);
    const now = this.c.k.d.clock.now().getTime();
    if (due === null || Date.parse(due) > now) return;
    const next = iso(now + (await p.delayMs(now)));
    if (!(await this.c.k.d.store.claimProbe(name, due, next))) return;
    const failure = p.probe ? await p.probe() : null;
    if (failure === null) {
      if (p.onPass) await p.onPass();
      if ((await this.c.k.d.store.endClaimPause(name)).ended) this.c.k.d.log.info(p.passed, {});
      return;
    }
    const after = this.c.k.d.clock.now().getTime();
    const moved = await this.c.k.d.store.pauseClaims(iso(after + (await p.delayMs(after))), name);
    p.failed(moved.resume_at, failure);
  }

  /** One short prompt on the cheap model: true when it answered. Carries no work item data. */
  async probe(llm: LLMProvider): Promise<boolean> {
    try {
      const res = await llm.complete({
        model_class: "cheap",
        messages: [{ role: "user", content: "Reply with the word OK." }],
        max_tokens: 16,
        data_env: "test",
        signal: AbortSignal.timeout(this.c.k.cfg.stall_ms ?? STALL_DEFAULTS.stall_ms),
      });
      return res.stop_reason === "end" || res.stop_reason === "max_tokens";
    } catch {
      return false;
    }
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "model-probe": ModelProbeUnit;
  }
}

export default controllerUnit({
  name: "model-probe",
  create: (c: Ctx) => new ModelProbeUnit(c),
  steps: [
    { name: "model probe", every: "tick", order: 110, run: (u) => u.probeStep() },
  ],
});

// Run kinds (RFC 0015 §7 Workers): each kind is one `src/worker/runs/<kind>/<kind>.run.ts` (`defineRunKind`),
// found by discovery. The runner names no kind: it claims a run, finds its kind here, and drives the kind's
// `execute` through the ExecutionEngine. A kind declares its named timeouts and whether the runner makes its
// folder; its body calls `call.step(id, fn)` for each named step (`run-agent`, `push-branch`, ...), so a run
// taken over by another worker resumes after its last finished step.

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { ModelClass } from "../core/model-choice.js";
import type { Run, RunKind, WorkItem } from "../core/types.js";
import type { SandboxHandle } from "../interfaces/sandbox.js";
import type { ToolCallContext } from "../interfaces/tool-broker.js";
import { findDescriptorFiles } from "../state/index.js";
import type { RunTimeouts, StepContext, StepId } from "./engine/index.js";
import type { Worker } from "./runner.js";
import type { ResumePlan } from "./support.js";

export const RUN_KIND_FILE = /\.run\.(?:ts|js)$/;

/** What the runner hands a kind's `execute`. */
export interface RunCall {
  readonly run: Run;
  readonly item: WorkItem;
  readonly ctx: ToolCallContext;
  /** Aborts when the lease is lost. */
  readonly signal: AbortSignal;
  /** The run's model class (`cheap` for a kind with no agent). */
  readonly model: ModelClass;
  /** Runs a named step through the engine; a step an earlier attempt finished returns its stored result. */
  step<T>(id: StepId, fn: (s: StepContext) => Promise<T>): Promise<T>;
  /** The folder the runner made (kinds with `folder: true`), and how a paused or stopped run picks up. */
  readonly handle?: SandboxHandle;
  readonly plan?: ResumePlan | null;
  readonly kept?: string | null;
}

export interface RunKindDescriptor {
  readonly kind: "run";
  readonly name: RunKind;
  /** The runner makes the run's folder (or reattaches a paused one) and removes it when the run ends. */
  readonly folder: boolean;
  /**
   * Named timeouts (RFC 0016 S7). `heartbeat_ms` is the lease: the live `lease_ms` replaces it at each claim.
   * `start_to_close_ms` bounds one step; `schedule_to_close_ms` the run from its creation over all attempts.
   */
  readonly timeouts: RunTimeouts;
  execute(w: Worker, call: RunCall): Promise<Record<string, unknown>>;
}

export function defineRunKind(d: Omit<RunKindDescriptor, "kind">): RunKindDescriptor {
  return { kind: "run", ...d };
}

/**
 * The defaults most kinds share. A step may take an hour: above the agent's own `run_timeout_ms` (45 min by
 * default), so the agent's timeout fires first. `heartbeat_ms` is the default `lease_ms`. A run may live a week from
 * its creation: runs wait in claim pauses and coordination holds, which a shorter deadline would fail.
 */
export const DEFAULT_TIMEOUTS: RunTimeouts = {
  start_to_close_ms: 3_600_000,
  heartbeat_ms: 300_000,
  schedule_to_close_ms: 7 * 24 * 3_600_000,
};

const loaded = new Map<string, Promise<ReadonlyMap<string, RunKindDescriptor>>>();

/** Every run kind under `root` (default: `src/worker/runs/`), by name; two files naming one kind fail. */
export function loadRunKinds(root: string = `${import.meta.dirname}/runs`): Promise<ReadonlyMap<string, RunKindDescriptor>> {
  let found = loaded.get(root);
  if (!found) {
    found = (async () => {
      const out = new Map<string, RunKindDescriptor>();
      for (const file of findDescriptorFiles(root, RUN_KIND_FILE)) {
        const mod = (await import(pathToFileURL(file).href)) as { default?: RunKindDescriptor };
        if (mod.default?.kind !== "run") throw new Error(`${relative(root, file)}: default export must be defineRunKind(...)`);
        if (out.has(mod.default.name)) throw new Error(`run kind "${mod.default.name}" is defined twice (${relative(root, file)})`);
        out.set(mod.default.name, mod.default);
      }
      return out;
    })();
    loaded.set(root, found);
  }
  return found;
}

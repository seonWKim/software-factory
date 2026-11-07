// The `dev` entry point. Resolves the Updater through the plugin registry. Under `none` it runs controller +
// worker in this process, between the updater's start and shutdown (which write the status file). Under
// `git-worktree` it runs them in children forked from built version folders: on a new base commit it starts
// the new child first, then asks the old one to drain (an IPC message); stop (SIGTERM) goes to every live child.

import { type ChildProcess, fork } from "node:child_process";
import { type Loaded, Plugins } from "./compose.js";
import type { Logger } from "./core/log.js";
import type { Clock } from "./interfaces/clock.js";
import {
  type ChildHandle,
  type ChildLauncher,
  type ChildSpec,
  type CommandRunner,
  DRAINED_MESSAGE,
  DRAIN_MESSAGE,
  CHILD_ERROR_MESSAGE,
  type Updater,
} from "./interfaces/updater.js";
import { ConsoleLogger } from "./impl/log/console-logger.js";
import { runProcess } from "./impl/process/run-process.js";
import { createPlugin } from "./plugins.js";

export { SUPERVISED_ENV } from "./interfaces/updater.js";

export interface SignalSource {
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

export interface SuperviseDeps {
  updater: Updater;
  clock: Clock;
  pollMs: number;
  log: Logger;
  signals: SignalSource;
  /** Controller + worker in this process, until the signal aborts. Used when the updater runs in place. */
  inPlace(signal: AbortSignal): Promise<void>;
}

/** Runs until SIGINT/SIGTERM. Then stops every live child (old and new) and returns once all have exited. */
export async function supervise(d: SuperviseDeps): Promise<number> {
  const stop = new AbortController();
  for (const sig of ["SIGINT", "SIGTERM"] as const) d.signals.once(sig, () => stop.abort());
  if (d.updater.mode === "in-place") {
    await d.updater.start();
    try {
      await d.inPlace(stop.signal);
    } finally {
      await d.updater.shutdown();
    }
    return 0;
  }
  const stopping: { done?: Promise<void> } = {};
  stop.signal.addEventListener(
    "abort",
    () => {
      d.log.info("stop requested: stopping every live child", { pids: (d.updater.childPids?.() ?? [d.updater.childPid()].filter((p) => p !== null)).join(",") });
      stopping.done = d.updater.shutdown();
    },
    { once: true },
  );
  const step = (name: string, fn: () => Promise<void>) =>
    fn().catch((err: unknown) => d.log.error(`updater ${name} failed`, { error: err instanceof Error ? err.message.slice(0, 300) : "unknown" }));

  await step("start", () => d.updater.start());
  while (!stop.signal.aborted) {
    await d.clock.sleep(d.pollMs, stop.signal).catch(() => undefined);
    if (stop.signal.aborted) break;
    await step("poll", () => d.updater.poll());
  }
  await (stopping.done ?? d.updater.shutdown());
  const left = d.updater.childPids?.() ?? [];
  if (left.length) d.log.error("children still live after shutdown", { pids: left.join(",") });
  d.log.info("supervisor stopped");
  return 0;
}

export function createUpdater(
  loaded: Loaded,
  deps: { run: CommandRunner; launcher: ChildLauncher; clock: Clock; log: Logger },
): Promise<Updater> {
  return createPlugin(loaded.registry, "updater", loaded.plugins.updater, { ...new Plugins(loaded).base, ...deps });
}

/** `factory dev`: supervise per the configured updater; `inPlace` runs controller + worker here. */
export async function runDev(loaded: Loaded, inPlace: (signal: AbortSignal) => Promise<void>): Promise<number> {
  const clock = await new Plugins(loaded).clock();
  const log = new ConsoleLogger(clock, "supervisor");
  const updater = await createUpdater(loaded, { run: runProcess, launcher: new ForkLauncher(), clock, log });
  return supervise({ updater, clock, pollMs: loaded.config.poll_interval_ms, log, signals: process, inPlace });
}

// --- child side -----------------------------------------------------------------------------------------

export interface DrainChannel {
  /** Calls `cb` once a drain was requested (at once if it already was). */
  onDrain(cb: () => void): void;
  /** Tells the supervisor the worker drained. */
  acknowledge(): Promise<void>;
}

interface Loops {
  controller: { run(signal: AbortSignal): Promise<void> };
  worker: { run(signal: AbortSignal): Promise<void> };
}

const quiet: Logger = { info() {}, warn() {}, error() {} };

/**
 * The supervised `dev` child. A drain stops the controller loop (and its stream listeners) at once, so it
 * starts no new pass beside the new child's controller; a pass already running finishes. The worker stops
 * claiming and its in-flight run finishes (it runs on its own lease signal); the new child's controller
 * applies that run's outcome on its next pass. Then the drain is acknowledged. `stop` (SIGINT/SIGTERM) is the
 * hard stop of both loops.
 */
export async function runDevChild(app: Loops, channel: DrainChannel, stop: AbortSignal, log: Logger = quiet): Promise<"drained" | "stopped"> {
  const drain = new AbortController();
  channel.onDrain(() => drain.abort());
  const signal = AbortSignal.any([drain.signal, stop]);
  const worker = app.worker.run(signal);
  const controller = app.controller.run(signal).then(() => {
    if (drain.signal.aborted && !stop.aborted) log.info("controller stopped on drain: the new child handles outcomes");
  });
  await Promise.all([worker, controller]);
  if (stop.aborted || !drain.signal.aborted) return "stopped";
  await channel.acknowledge();
  return "drained";
}

const isMessage = (m: unknown, type: string) => typeof m === "object" && m !== null && (m as { type?: unknown }).type === type;

/** The child's end of the IPC channel. Listens from creation, so a drain sent during startup is not lost. */
export function processChannel(proc: NodeJS.Process = process): DrainChannel {
  let requested = false;
  let listener: (() => void) | null = null;
  proc.on("message", (m: unknown) => {
    if (!isMessage(m, DRAIN_MESSAGE) || requested) return;
    requested = true;
    listener?.();
  });
  return {
    onDrain(cb) {
      listener = cb;
      if (requested) cb();
    },
    acknowledge: () =>
      new Promise((resolve) => {
        if (!proc.send || !proc.connected) return resolve();
        proc.send({ type: DRAINED_MESSAGE }, undefined, {}, () => resolve());
      }),
  };
}

// --- supervisor side ------------------------------------------------------------------------------------

/** Forks `dist/main.js` of a version folder with an IPC channel. Output goes to the supervisor's terminal. */
export class ForkLauncher implements ChildLauncher {
  launch(spec: ChildSpec): ChildHandle {
    const child = fork(spec.entry, [...spec.args], {
      cwd: spec.cwd,
      env: { ...process.env, ...spec.env },
      execArgv: ["--disable-warning=ExperimentalWarning"],
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    return new ForkedChild(child);
  }
}

class ForkedChild implements ChildHandle {
  drainAcknowledged = false;
  lastError: string | null = null;
  lastErrorCode: string | null = null;
  readonly exited: Promise<number | null>;

  constructor(private readonly c: ChildProcess) {
    this.exited = new Promise((resolve) => {
      c.once("exit", (code) => resolve(code));
      c.once("error", () => {
        if (c.exitCode !== null || c.pid === undefined) resolve(c.exitCode);
      });
    });
    c.on("message", (m: unknown) => {
      if (isMessage(m, DRAINED_MESSAGE)) this.drainAcknowledged = true;
      if (isMessage(m, CHILD_ERROR_MESSAGE)) {
        const e = m as { error?: unknown; code?: unknown };
        this.lastError = String(e.error ?? "").slice(0, 500);
        this.lastErrorCode = typeof e.code === "string" ? e.code.slice(0, 100) : null;
      }
    });
  }

  get pid(): number {
    return this.c.pid ?? -1;
  }

  requestDrain(): void {
    if (this.c.connected) this.c.send({ type: DRAIN_MESSAGE });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.c.kill(signal);
  }
}

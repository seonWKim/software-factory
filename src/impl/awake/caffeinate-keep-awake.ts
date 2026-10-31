import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Logger } from "../../core/log.js";
import type { KeepAwake } from "../../interfaces/keep-awake.js";

/** The part of a child process this plugin uses. */
export interface AwakeChild {
  on(event: "error", fn: (err: Error) => void): unknown;
  on(event: "exit", fn: () => void): unknown;
  kill(): boolean;
}

/** Starts `cmd args` in the background. Injected so tests never spawn a real process. */
export type AwakeLauncher = (cmd: string, args: readonly string[]) => AwakeChild;

/** The real launcher: detached from our stdio, and does not keep the event loop alive. */
export const spawnLauncher: AwakeLauncher = (cmd, args) => {
  const child = spawn(cmd, [...args], { stdio: "ignore" });
  child.unref();
  return child;
};

/**
 * macOS: runs `caffeinate -i -s -w <pid>` while held. `-i` blocks idle sleep, `-s` system sleep on AC power,
 * `-w` ends caffeinate when this process exits, so a crash never leaves the machine awake for good.
 * A lid close still sleeps the machine; caffeinate cannot stop that.
 */
export class CaffeinateKeepAwake implements KeepAwake {
  private child: AwakeChild | null = null;

  constructor(private readonly opts: { launch: AwakeLauncher; log: Logger; pid: number }) {}

  async hold(): Promise<void> {
    if (this.child) return;
    let child: AwakeChild;
    try {
      child = this.opts.launch("caffeinate", ["-i", "-s", "-w", String(this.opts.pid)]);
    } catch (err) {
      this.warn(err);
      return;
    }
    this.child = child;
    child.on("error", (err) => {
      if (this.child === child) this.child = null;
      this.warn(err);
    });
    child.on("exit", () => {
      if (this.child === child) this.child = null;
    });
  }

  async release(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    try {
      child.kill();
    } catch (err) {
      this.opts.log.warn("keep-awake: caffeinate could not be stopped", { error: message(err) });
    }
  }

  private warn(err: unknown): void {
    this.opts.log.warn("keep-awake: caffeinate failed to start", { error: message(err) });
  }
}

/** Throws unless `name` is an executable file in one of the `path` entries. */
export function requireExecutable(name: string, path: string | undefined): void {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const file = join(dir, name);
    try {
      if (!statSync(file).isFile()) continue;
      accessSync(file, constants.X_OK);
      return;
    } catch {
      // not here
    }
  }
  throw new Error(`no ${name} executable on PATH`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "unknown";
}

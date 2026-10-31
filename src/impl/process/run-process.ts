import { spawn } from "node:child_process";
import type { ExecResult } from "../../interfaces/sandbox.js";

export interface RunProcessOptions {
  cwd: string;
  /** Full environment for the child. Nothing is inherited. */
  env: Readonly<Record<string, string>>;
  stdin?: string;
  timeout_ms?: number;
  signal?: AbortSignal;
}

const MAX_OUTPUT = 16 * 1024 * 1024;

/** Implementation helper for local process execution. Core code goes through Sandbox / AgentRunner instead. */
export function runProcess(cmd: readonly string[], opts: RunProcessOptions): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [file, ...args] = cmd;
    if (!file) return reject(new Error("empty command"));
    const child = spawn(file, args, { cwd: opts.cwd, env: { ...opts.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    const timer = opts.timeout_ms
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, opts.timeout_ms)
      : null;
    const onAbort = () => child.kill("SIGTERM");
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exit_code: code, signal, stdout, stderr, timed_out: timedOut });
    });
    child.stdin.end(opts.stdin ?? "");
  });
}

/** Minimal non-secret environment for helper processes (git etc.). */
export function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { LANG: process.env.LANG ?? "C.UTF-8" };
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  return { ...env, ...extra };
}

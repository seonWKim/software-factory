// Git bundles of a run's commits in shared storage (RFC 0015 §7 Workers): a paused run's WIP, and the result of a
// journaled step whose work is commits (implement's agent step, resolve's checked merge), so a run resumed on
// another host restores the commits instead of running the step again.

import type { Worker } from "./runner.js";

/** The run's folder, as the worker's own commands take it. */
type Folder = Parameters<Worker["gitRaw"]>[0];

/** A taken-over run whose finished step left no bundle to restore: it fails (infra) and is retried afresh. */
export const RESUME_LOST = "resume_lost";

/**
 * The commits `revs` names (git rev arguments ending at HEAD, `^` for what the other side has) as a git bundle in
 * shared storage (base64 text), under `bundles/<item>/<run><suffix>.bundle.b64`. Like transcripts, nothing is
 * stored before the egress scan (G5): `patch`, the text those commits add, must scan clean, else no bundle is
 * kept. Returns the key, or null (logged, prefixed with `what`).
 */
export async function saveBundle(
  w: Worker,
  run: { readonly id: string },
  item: { readonly id: string },
  handle: Folder,
  dirs: string,
  o: { revs: readonly string[]; patch: string; what: string; suffix?: string },
): Promise<string | null> {
  const scan = await w.d.scanner.scan("commit", o.patch);
  if (!scan.clean) {
    w.d.log.warn(`${o.what}: the commits did not scan clean; no bundle kept`, { run_id: run.id, rules: scan.findings.map((f) => f.rule).join(",") });
    return null;
  }
  const file = `${dirs.split("\n").at(-1)}/sf-run.bundle`;
  const made = await w.gitRaw(handle, ["bundle", "create", file, ...o.revs]);
  // `-i`: the input file on BSD base64; ignore-garbage, a no-op when encoding, on GNU (which reads `file` itself).
  const text = made.exit_code === 0 ? await w.d.sandbox.exec(handle, ["base64", "-i", file], { env: w.d.toolEnv }) : null;
  await w.d.sandbox.exec(handle, ["rm", "-f", "--", file], { env: w.d.toolEnv });
  if (!text || text.exit_code !== 0) {
    w.d.log.warn(`${o.what}: git bundle failed; no bundle kept`, { run_id: run.id });
    return null;
  }
  const key = `bundles/${item.id}/${run.id}${o.suffix ?? ""}.bundle.b64`;
  await w.d.storage.put(key, new TextEncoder().encode(text.stdout.replace(/\s+/g, "")));
  return key;
}

/**
 * Fetches the bundle stored under `key` into the run's git folder. The fetched commit must be `head`, the one the
 * journal or the store recorded, so a changed bundle is never trusted. Nothing is checked out.
 */
export async function fetchBundle(w: Worker, handle: Folder, gitDir: string, key: string | null, head: string | null): Promise<"restored" | "missing" | "failed"> {
  const data = key && head ? await w.d.storage.get(key) : null;
  if (!data || !head) return "missing";
  const file = `${gitDir}/sf-resume.bundle`;
  const wrote = await w.d.sandbox.exec(handle, ["sh", "-c", 'base64 -d > "$1"', "sh", file], {
    env: w.d.toolEnv,
    stdin: new TextDecoder().decode(data),
  });
  const fetched = wrote.exit_code === 0 ? await w.gitRaw(handle, ["fetch", "--quiet", "--no-tags", file, "HEAD"]) : wrote;
  const got = fetched.exit_code === 0
    ? await w.gitRaw(handle, ["rev-parse", "--verify", "--end-of-options", "FETCH_HEAD^{commit}"])
    : fetched;
  await w.d.sandbox.exec(handle, ["rm", "-f", "--", file], { env: w.d.toolEnv });
  return got.exit_code === 0 && got.stdout.trim() === head ? "restored" : "failed";
}

import type { ExecResult } from "../../interfaces/sandbox.js";
import { basename, isUnder, resolvePath } from "./paths.js";
import { DEFAULT_PATH } from "./policy.js";
import type { ToolContext, ToolResult, ToolSpec } from "./types.js";

/** Env for the tools' own helper commands (realpath, cat, find, grep): no allowlist, no credential. */
export const HELPER_ENV: Readonly<Record<string, string>> = { PATH: DEFAULT_PATH };
const HELPER_TIMEOUT_MS = 60_000;

export class Refusal extends Error {}

/** Runs a helper command in the sandbox. Arguments are argv entries, never spliced into a shell string. */
export function helper(ctx: ToolContext, cmd: readonly string[], stdin?: string): Promise<ExecResult> {
  return ctx.sandbox.exec(ctx.handle, cmd, {
    env: HELPER_ENV,
    timeout_ms: HELPER_TIMEOUT_MS,
    ...(stdin !== undefined && { stdin }),
    ...(ctx.signal && { signal: ctx.signal }),
  });
}

/** Content cut at the policy's output cap; `truncated: true` only when cut. */
export function capped(ctx: ToolContext, content: string): ToolResult {
  const cap = ctx.policy.output_cap;
  return content.length > cap ? { ok: true, content: content.slice(0, cap), truncated: true } : { ok: true, content };
}

/** Wraps a tool body: refusals and every thrown error become `{ok:false, error}`. Checks `policy.invalid` first. */
export function defineTool(
  spec: Omit<ToolSpec, "run"> & { run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> },
): ToolSpec {
  return {
    name: spec.name,
    description: spec.description,
    input_schema: spec.input_schema,
    capability: spec.capability,
    async run(input, ctx) {
      try {
        if (ctx.policy.invalid) return { ok: false, error: ctx.policy.invalid };
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          return { ok: false, error: `${spec.name}: input must be an object` };
        }
        return await spec.run(input as Record<string, unknown>, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: err instanceof Refusal ? message : `${spec.name} failed: ${message}` };
      }
    },
  };
}

export function str(input: Record<string, unknown>, key: string, required: true): string;
export function str(input: Record<string, unknown>, key: string, required: false): string | undefined;
export function str(input: Record<string, unknown>, key: string, required: boolean): string | undefined {
  const v = input[key];
  if (v === undefined && !required) return undefined;
  if (typeof v !== "string" || (required && v === "")) throw new Refusal(`${key} must be a non-empty string`);
  return v;
}

export function int(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Refusal(`${key} must be a non-negative integer`);
  return v;
}

// For each argument: the canonical path (every symlink resolved) of its deepest existing ancestor, with the
// not-yet-existing rest appended. A dangling symlink on the way is reported, not followed, so a Write cannot
// create a file wherever one points. Output: one `OK:<path>`, `DANGLING` or `ERR` per argument, NUL-separated.
// Arguments arrive normalized (absolute, no `.`/`..`, no trailing slash) and are only ever used quoted.
const CANONICALIZE = `for p do
  rest=
  while [ ! -e "$p" ]; do
    if [ -L "$p" ]; then printf 'DANGLING\\0'; continue 2; fi
    rest="/\${p##*/}$rest"
    p=\${p%/*}
    [ -n "$p" ] || p=/
  done
  if r=$(realpath -- "$p" && echo .); then
    r=\${r%.}; r=\${r%?}
    case $r in /) r= ;; esac
    printf 'OK:%s%s\\0' "$r" "$rest"
  else
    printf 'ERR\\0'
  fi
done`;

/** Canonical forms of absolute, normalized paths, resolved in the sandbox. null: dangling or unresolvable. */
export async function canonicalize(ctx: ToolContext, paths: readonly string[]): Promise<(string | null)[]> {
  const r = await helper(ctx, ["/bin/sh", "-c", CANONICALIZE, "sh", ...paths]);
  if (r.exit_code !== 0 || r.timed_out) throw new Error(`could not resolve paths (exit ${r.exit_code})`);
  const parts = r.stdout.split("\0").slice(0, -1);
  if (parts.length !== paths.length) throw new Error("could not resolve paths");
  return parts.map((s) => (s.startsWith("OK:") ? s.slice(3) || "/" : null));
}

/** The guard's view of the policy, canonical forms included. Built once per tool call. */
export interface ResolvedGuard {
  /** Canonical workdir and writable_paths: where file tools may read and write. */
  roots: string[];
  /** Lexical and canonical forms of every deny_paths entry. */
  denies: string[];
}

export async function resolveGuard(ctx: ToolContext, target: string): Promise<{ guard: ResolvedGuard; canonical: string | null }> {
  const { workdir, writable_paths, deny_paths } = ctx.policy;
  const all = await canonicalize(ctx, [target, workdir, ...writable_paths, ...deny_paths]);
  const canonical = all[0] ?? null;
  const roots = all.slice(1, 2 + writable_paths.length).filter((p): p is string => p !== null);
  const denies = [...deny_paths, ...all.slice(2 + writable_paths.length).filter((p): p is string => p !== null)];
  return { guard: { roots, denies }, canonical };
}

/**
 * The one `.env.*` name file tools may open: it lists secret names and must hold no values (architecture §5;
 * the push path checks that). Exact name only: `.env.example.local` or `.env.EXAMPLE` stay denied.
 */
export const ENV_EXAMPLE = ".env.example";

/** `.env` and `.env.*` files, except `.env.example`, are denied wherever they are, as the runner's rules do. */
function isEnvFile(p: string): boolean {
  const b = basename(p);
  return b === ".env" || (b.startsWith(".env.") && b !== ENV_EXAMPLE);
}

/**
 * True if `path` (canonical) is a regular file with more than one hard link. A hard link has no target to
 * resolve, so `.env.example` hard-linked to `.env` would pass the name check; it is refused instead.
 */
async function isHardLinked(ctx: ToolContext, path: string): Promise<boolean> {
  const r = await helper(ctx, ["find", path, "-maxdepth", "0", "-type", "f", "-links", "+1"]);
  return r.stdout.trim() !== "";
}

export function isDenied(guard: ResolvedGuard, path: string): boolean {
  return isEnvFile(path) || guard.denies.some((d) => isUnder(path, d));
}

/**
 * The path check for Read, Glob, Grep, Write and Edit. Resolves `input` against the workdir, then refuses it
 * if either its lexical or its canonical form is under a deny entry, or if its canonical form is outside the
 * workdir and every writable_paths entry. Returns the canonical path: the one the tool then operates on.
 */
export async function checkPath(ctx: ToolContext, input: string): Promise<{ path: string; guard: ResolvedGuard }> {
  // Control characters (newlines, NUL) would break the NUL/newline-separated helper output.
  if (/[\x00-\x1f]/.test(input)) throw new Refusal("path contains control characters");
  const lexical = resolvePath(ctx.policy.workdir, input);
  const { guard, canonical } = await resolveGuard(ctx, lexical);
  if (canonical === null) throw new Refusal(`refused: ${input} is a dangling or unresolvable symlink`);
  if (isDenied(guard, lexical) || isDenied(guard, canonical)) throw new Refusal(`refused: ${input} is a denied path`);
  if (!guard.roots.some((r) => isUnder(canonical, r))) {
    throw new Refusal(`refused: ${input} is outside the workdir and writable paths`);
  }
  // `.env.example` passed the name check; a symlink to a secret file was refused above by its canonical name.
  if ((basename(lexical) === ENV_EXAMPLE || basename(canonical) === ENV_EXAMPLE) && (await isHardLinked(ctx, canonical))) {
    throw new Refusal(`refused: ${input} is a hard-linked ${ENV_EXAMPLE}`);
  }
  return { path: canonical, guard };
}

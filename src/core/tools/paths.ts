// POSIX path helpers. core/ may not import node:path (tests/boundaries.test.ts), so these are hand-written.
// They work on strings only; symlinks are resolved inside the sandbox (`canonicalize` in guard.ts).

export function isAbsolute(p: string): boolean {
  return p.startsWith("/");
}

/** Normalizes an absolute path: no `.`, `..`, empty segments or trailing slash. `..` at the root stays at the root. */
export function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

/** `p` against `base` (absolute), normalized. */
export function resolvePath(base: string, p: string): string {
  return normalize(isAbsolute(p) ? p : `${base}/${p}`);
}

/** True if `p` is `dir` or below it. Both normalized. */
export function isUnder(p: string, dir: string): boolean {
  return dir === "/" || p === dir || p.startsWith(`${dir}/`);
}

export function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** `p` relative to `dir`, for `p` under `dir`. */
export function relativeTo(p: string, dir: string): string {
  if (p === dir) return "";
  return dir === "/" ? p.slice(1) : p.slice(dir.length + 1);
}

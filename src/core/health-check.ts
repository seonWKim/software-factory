// A Health or doctor check's result, and the token-expiry thresholds: pure values that the status page, the system
// actions and doctor share. Kernel code (RFC 0023 §3): the UI reads it without importing setup.ts and, through it, the
// composition root.

/**
 * `warn`: not a doctor failure (hardening local use may skip). `token_days`: the token expiry check's whole days left. `fix`:
 * how to fix a FAIL whose `msg` is outside text as it came (an error, a version). `plain`: Health's sentence, no path (doctor
 * prints `msg`, Health shows it behind Details). `label`: a forge status label's name; Health folds those into one row.
 * `since` / `next`: ISO instants kept out of `msg` (a probe pause's start, next probe), shown locally. */
export type Check = { ok: boolean; msg: string; warn?: boolean; token_days?: number; fix?: string; plain?: string; label?: string; since?: string; next?: string };

/** A check's result in one word: what doctor prints and the status page shows. */
export type CheckStatus = "ok" | "warn" | "fail";

export function checkStatus(c: Check): CheckStatus {
  return c.ok ? "ok" : c.warn ? "warn" : "fail";
}

/** At or under this many days left a token is a FAIL; under TOKEN_WARN_DAYS a warn (design §9 Health). */
export const TOKEN_FAIL_DAYS = 0;
export const TOKEN_WARN_DAYS = 3;

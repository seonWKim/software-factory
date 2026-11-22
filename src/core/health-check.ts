// A Health or doctor check's result, and the token-expiry thresholds: pure values that the status page, the system
// actions and doctor share. Kernel code (RFC 0023 §3): the UI reads it without importing setup.ts and, through it, the
// composition root.

/**
 * `warn`: not a doctor failure (hardening local use may skip). `token_days`: the token expiry check's whole days left. `fix`:
 * how to fix a FAIL whose `msg` is outside text as it came (an error, a version). `plain`: Health's sentence, no path (doctor
 * prints `msg`, Health shows it behind Details). `label`: a forge status label's name; Health folds those into one row.
 * `group`: the check's cause; Health folds the checks of one group (one result, one `plain`) into one row, every `msg`
 * behind its Details. `action`: what Health offers on the row (`add_model_credential`: the Add model credential dialog).
 * `since` / `next`: ISO instants kept out of `msg` (a probe pause's start, next probe), shown locally. */
export type Check = {
  ok: boolean; msg: string; warn?: boolean; token_days?: number; fix?: string; plain?: string; label?: string; group?: string; action?: CheckAction;
  since?: string; next?: string;
};

/** An action Health offers on a check's row. */
export type CheckAction = "add_model_credential";

/** A check's result in one word: what doctor prints and the status page shows. */
export type CheckStatus = "ok" | "warn" | "fail";

export function checkStatus(c: Check): CheckStatus {
  return c.ok ? "ok" : c.warn ? "warn" : "fail";
}

/** At or under this many days left a token is a FAIL; under TOKEN_WARN_DAYS a warn (design §9 Health). */
export const TOKEN_FAIL_DAYS = 0;
export const TOKEN_WARN_DAYS = 3;

/** Health's sentences (design 09-health, 2026-11-23): no variable name, command or URL; doctor's `msg` keeps those. */
const PLAIN = {
  sandbox_on: "Auto mode can run: this computer's OS sandbox guards agent runs",
  sandbox_off: "Auto mode is off: this computer has no OS sandbox. Details: how to install it",
  credential_saved: "A model credential is saved",
  credential_missing: "No model credential is saved, so agent runs wait until you add one",
};

/** The model credential check's Health fields: saved, or missing with the Add model credential action. */
export function credentialPlain(found: boolean): Pick<Check, "plain" | "action"> {
  return found ? { plain: PLAIN.credential_saved } : { plain: PLAIN.credential_missing, action: "add_model_credential" };
}

/**
 * doctor's sandbox checks, one per line (reads, writes, network) in the order given, each a warn when not OS-enforced.
 * The lines of one result and cause share a `group`, so Health shows them as one row.
 */
export function sandboxChecks(lines: readonly { line: string; enforced: boolean; why: string }[]): Check[] {
  return lines.map(({ line, enforced: on, why }) => ({
    ok: on, warn: !on, msg: `sandbox ${line}: ${on ? "OS-enforced" : "not OS-enforced, so auto mode is refused"} (${why})`,
    plain: on ? PLAIN.sandbox_on : PLAIN.sandbox_off, group: `sandbox ${on ? "on" : "off"}: ${why}`,
  }));
}

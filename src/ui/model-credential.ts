// The dashboard's Add model credential dialog (design 09-status-page, Needs you; 09-dashboard-system, Failures). GET
// /api/v1/model-credential names the secrets the selected runners declare for their model credential (the `oneOf`
// group compose.ts modelCredentialSecrets reads) and the page's CSRF token; POST /api/v1/model-credential writes the
// pasted values to the factory's secret file through the setup writer (the one `npm run setup` and the calendar connect
// use), then ends the store-wide `model_credential` claim pause, so Needs you clears and the next worker tick claims the
// waiting runs (its secret store reads the file again within seconds, worker-deps.ts claimableKinds). The request
// guards (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts; then the owner check server.ts
// passes in (rules-api.ts ownerOf: the store's owner only); every refusal comes before any write. Write-only: no value is returned, logged or stored in the store;
// answers and log lines name secrets, never values.

import { MODEL_CREDENTIAL } from "../core/policy.js";
import { errorText } from "../core/log.js";
import type { SecretName } from "../interfaces/secret-store.js";
import { type ApiResult, apiError } from "./api.js";
import type { PauseDeps } from "./pause-api.js";
import { Withholder } from "./withhold.js";

export const MODEL_CREDENTIAL_PATH = "/api/v1/model-credential";
/** The longest value the dialog takes for one secret. */
const MAX_VALUE = 4096;

/** The dialog's parts, as the UI composition gives them (compose.ts buildUiParts). */
export interface UiModelCredential {
  /** The model credential's declared secret names, in declaration order: any one of them is enough. */
  secrets: readonly SecretName[];
  /** Writes each value under its name in the secret file; a refusal throws before any write. */
  save(values: ReadonlyMap<SecretName, string>): Promise<void>;
}

declare module "./settings-api.js" {
  interface UiSettings {
    /** The Add model credential dialog's routes. Absent (no selected runner reads one): GET is a 404 and POST a 405. */
    modelCredential?: UiModelCredential;
  }
}

/** GET /api/v1/model-credential: the declared names and the page's CSRF token, never a value or whether one is saved. */
export function readModelCredential(d: PauseDeps): ApiResult {
  const m = d.settings?.modelCredential;
  if (!m) return apiError(404, "Not found.");
  return { status: 200, value: { secrets: m.secrets, csrf_token: d.settings!.csrfToken } };
}

/** Who acts from the page when it is the store's owner, else why not (rules-api.ts ownerOf, given what the action does). */
export type OwnerCheck = (does: string) => Promise<{ user: string } | { error: string }>;

/** POST /api/v1/model-credential after server.ts's guards: the owner check, the body, the write, then the pause ends. */
export async function writeModelCredential(d: PauseDeps, owner: OwnerCheck | null, body: unknown): Promise<ApiResult> {
  const m = d.settings?.modelCredential;
  if (!m) return apiError(404, "Not found.");
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const who = owner ? await owner("adds a model credential") : { error: "The page has no owner check: adding a model credential is off." };
  if ("error" in who) return apiError(403, await text(who.error));
  const b = parseBody(body, m.secrets);
  if ("error" in b) return apiError(400, b.error);
  try {
    await m.save(b.values);
  } catch (err) {
    // The writer's errors name the secret and the step, never the value; the Withholder drops a known secret anyway.
    return apiError(422, await text(errorText(err)));
  }
  const names = [...b.values.keys()];
  const resumed = (await d.store.endClaimPause(MODEL_CREDENTIAL)).ended;
  d.pauses?.log.info("model credential saved from the dashboard", { secrets: names.join(","), by: who.user, resumed });
  return { status: 200, value: { saved: names, resumed } };
}

/** `{ values: { NAME: value } }` with at least one declared name and only declared names; empty values are left out. */
function parseBody(body: unknown, declared: readonly SecretName[]): { values: ReadonlyMap<SecretName, string> } | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "values");
  if (extra !== undefined) return { error: `unknown field "${extra}"` };
  const raw = b.values;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { error: "values must be an object from secret name to value" };
  const values = new Map<SecretName, string>();
  for (const [k, v] of Object.entries(raw)) {
    const name = declared.find((n) => n === k);
    if (name === undefined) return { error: `"${k}" is not a model credential secret; the secrets are ${declared.join(", ")}` };
    if (typeof v !== "string" || v.length > MAX_VALUE) return { error: `values.${k} must be a string of at most ${MAX_VALUE} characters` };
    const value = v.trim();
    if (/\s/.test(value)) return { error: `values.${k} must not contain spaces or line breaks` };
    if (value !== "") values.set(name, value);
  }
  if (values.size === 0) return { error: `paste a value for one of ${declared.join(", ")}` };
  return { values };
}

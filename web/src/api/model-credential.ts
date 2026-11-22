// The Add model credential dialog (design 09-status-page, Needs you; 09-dashboard-system, Failures): GET
// /api/v1/model-credential and POST /api/v1/model-credential (postModelCredential). Write-only: the server never sends a
// saved value back, and the page keeps none after the dialog closes.

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import { API } from "./routes.js";

/** `/api/v1/model-credential`: the secret names the agent runner declares for its model credential (any one is enough). */
export interface ModelCredentialView {
  secrets: string[];
  csrf_token: string;
}

/** Saves the non-empty `values` by secret name; the answer names what was saved, never a value. */
export async function postModelCredential(token: string, values: Readonly<Record<string, string>>): Promise<{ ok: true } | { ok: false; error: string }> {
  const r = await postJson<{ error?: string }>(API.modelCredential, token, { values });
  return r.ok ? { ok: true } : { ok: false, error: r.value.error ?? t("api.http", { status: r.status }) };
}

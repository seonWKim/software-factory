import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API, type ModelCredentialView, postModelCredential, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { Field } from "../components/ui/field.js";
import { Input, PASSWORD } from "../components/ui/input.js";
import { t } from "../i18n/index.js";

// The Add model credential dialog (design 09-status-page): one masked field per secret the agent runner declares for
// its model credential, Save and Cancel. Needs you's model_credential row opens it from its "⋯" menu, the Failures
// page's setup_missing group from its button; neither row changes height. Save posts the filled fields with the page's
// CSRF token; the server writes them to the secret file and ends the pause, then the overview and failures reload so
// the row goes. Write-only: the fields are masked and their values leave the page with the dialog.

/** A catalog line whose `backticked` parts are code elements. */
function withCode(text: string) {
  return text.split("`").map((part, i) => (i % 2 ? <code key={i} className="font-mono">{part}</code> : part));
}

/** The catalog keys of each declared secret's plain label and help. */
const KNOWN = {
  CLAUDE_CODE_OAUTH_TOKEN: { label: "needs.credentialLabel.CLAUDE_CODE_OAUTH_TOKEN", help: "needs.credentialHelp.CLAUDE_CODE_OAUTH_TOKEN" },
  ANTHROPIC_API_KEY: { label: "needs.credentialLabel.ANTHROPIC_API_KEY", help: "needs.credentialHelp.ANTHROPIC_API_KEY" },
} as const;

/** The plain label and help for a declared secret name; a name the catalog lacks gets the fallback pair. */
function describeSecret(name: string): { label: string; help: string } {
  const k = Object.hasOwn(KNOWN, name) ? KNOWN[name as keyof typeof KNOWN] : null;
  return k ? { label: t(k.label), help: t(k.help) } : { label: t("needs.credentialLabelOther"), help: t("needs.credentialHelpOther") };
}

/** The dialog, mounted to open it. */
export function ModelCredentialDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const view = useApi<ModelCredentialView>(API.modelCredential, false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = useId();
  const v = view.data;
  const filled = Object.fromEntries(Object.entries(values).filter(([, x]) => x.trim() !== ""));
  const save = async () => {
    if (!v) return;
    setBusy(true);
    setError(null);
    try {
      const r = await postModelCredential(v.csrf_token, filled);
      if (!r.ok) return setError(r.error);
      announceStatus(t("needs.credentialSaved"));
      await Promise.all([API.overview, API.pauses].map((k) => client.invalidateQueries({ queryKey: [k] })));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const loadError = view.isError ? t("common.couldNotLoad", { message: view.error instanceof Error ? view.error.message : String(view.error) }) : null;
  return (
    <Dialog title={t("needs.credentialTitle")} consequence={t("needs.credentialConsequence")} confirmLabel={t("needs.credentialSave")}
      confirmDisabled={busy || !v || Object.keys(filled).length === 0} error={error ?? loadError} onConfirm={() => void save()} onClose={onClose}>
      {v === undefined ? (!loadError && <p className="text-sm">{t("common.loading")}</p>) : (
        <div data-credential-fields className="flex min-w-0 flex-col gap-3">
          {v.secrets.length > 1 && <p className="text-sm text-pretty">{t("needs.credentialOneOf")}</p>}
          {v.secrets.map((n) => {
            const d = describeSecret(n);
            return (
              <Field key={n} label={d.label} help={withCode(d.help)} htmlFor={`${uid}-${n}`}>
                <Input id={`${uid}-${n}`} {...PASSWORD} autoComplete="off" spellCheck={false} value={values[n] ?? ""}
                  onChange={(e) => setValues({ ...values, [n]: e.target.value })} />
                <Disclosure summary={t("needs.credentialDetails")}><code className="font-mono text-xs break-all">{n}</code></Disclosure>
              </Field>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

/** The Failures page's opener for a setup_missing group: a small secondary button that opens the dialog. */
export function AddModelCredential() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="add-model-credential" variant="secondary" size="sm" onClick={() => setOpen(true)}>{t("needs.addCredential")}</Button>
      {open && <ModelCredentialDialog onClose={() => setOpen(false)} />}
    </>
  );
}

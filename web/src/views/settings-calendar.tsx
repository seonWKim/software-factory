import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API, type CalendarPluginView, type CalendarView, postCalendarConnect, postCalendarDisconnect, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Badge, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { useNow } from "./common.js";

// The Settings page's Calendar section (design 08-settings, 2026-11-13): each calendar plugin the server lists from
// the registry's connect hooks, by its own name (this file names no provider), connected or not, with its last sync time
// and last error. Connect posts the plugin; when the server answers which secrets the sign-in needs, a Dialog asks for
// them in password fields, and the values leave the page's state once the attempt is sent. The server then answers the
// consent page, opened in a new tab (and linked, if the browser blocks it), and the section polls GET /api/v1/calendar
// for the result. Disconnect asks first in the danger Dialog; nothing is sent until Confirm.

export function CalendarSection({ token }: { token: string }) {
  const view = useApi<CalendarView>(API.calendar);
  if (view.isError) return <ErrorNote error={view.error} />;
  if (!view.data) return <Loading rows={1} />;
  // A server without the section (an older build) answers no list: the page shows no section rather than failing.
  const plugins = view.data.plugins ?? [];
  if (plugins.length === 0) return null;
  return (
    <Section title={t("calendar.title")} count={plugins.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">{t("calendar.hint")}</p>
      <ul className="space-y-4 text-sm">
        {plugins.map((p) => (
          <CalendarRow key={p.name} plugin={p} token={token} />
        ))}
      </ul>
    </Section>
  );
}

/**
 * A password field from the shared Input, whose typed variants are text, search and number only: it hands `type` to the
 * native field as given. Adding `password` to Input's variants (components.md) is a follow-up outside this change.
 */
const PASSWORD = { type: "password" } as unknown as { type: "text" };

/** What the last Connect answered, until the next one. */
type Asking = { needs: string[] } | null;

function CalendarRow({ plugin, token }: { plugin: CalendarPluginView; token: string }) {
  const client = useQueryClient();
  const now = useNow();
  const uid = useId();
  const [asking, setAsking] = useState<Asking>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const signingIn = plugin.attempt?.state === "signing_in";
  const refresh = () => client.invalidateQueries({ queryKey: [API.calendar] });

  const connect = async (sent?: Record<string, string>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postCalendarConnect(token, plugin.name, sent);
      if (!r.ok) return setError(r.error);
      if (r.state === "needs_input") return setAsking({ needs: r.needs });
      setAsking(null);
      if (r.state === "signing_in") {
        setConsent(r.consent_url);
        window.open(r.consent_url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // The typed values never outlive the attempt.
      setValues({});
      setBusy(false);
      await refresh();
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postCalendarDisconnect(token, plugin.name);
      if (!r.ok) return setError(r.error);
      setConfirming(false);
      setConsent(null);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const closeAsk = () => {
    setAsking(null);
    setValues({});
    setError(null);
  };

  return (
    <li data-calendar={plugin.name} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium wrap-anywhere">{plugin.name}</span>
        <Badge level={plugin.connected ? "ready_to_merge" : undefined}>{plugin.connected ? t("calendar.connected") : t("calendar.notConnected")}</Badge>
        <span className="text-xs text-text-2 tabular-nums">
          {plugin.synced_at ? t("calendar.lastSync", { time: t("time.ago", { time: ago(plugin.synced_at, now) }) }) : t("calendar.neverSynced")}
        </span>
      </div>
      {plugin.error && <p className="text-xs text-pretty break-words text-pill-bad-fg">{t("calendar.lastError", { error: plugin.error })}</p>}
      <Attempt plugin={plugin} consent={consent} />
      <ButtonRow>
        {plugin.connected ? (
          <Button variant="danger" disabled={busy || signingIn} aria-label={t("calendar.disconnectLabel", { name: plugin.name })} onClick={() => (setError(null), setConfirming(true))}>
            {t("calendar.disconnect")}
          </Button>
        ) : (
          <Button disabled={busy || signingIn} aria-label={t("calendar.connectLabel", { name: plugin.name })} onClick={() => void connect()}>
            {t("calendar.connect")}
          </Button>
        )}
      </ButtonRow>
      {error && asking === null && !confirming && (
        <p role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">
          {error}
        </p>
      )}
      {asking && (
        <Dialog
          title={t("calendar.connectTitle", { name: plugin.name })}
          consequence={t("calendar.connectConsequence")}
          confirmLabel={t("calendar.signIn")}
          confirmDisabled={busy || asking.needs.some((n) => !values[n]?.trim())}
          error={error}
          onConfirm={() => void connect(Object.fromEntries(asking.needs.map((n) => [n, values[n] ?? ""])))}
          onClose={closeAsk}
        >
          {asking.needs.map((n) => (
            <Field key={n} label={n} htmlFor={`${uid}-${n}`}>
              <Input
                id={`${uid}-${n}`}
                {...PASSWORD}
                autoComplete="off"
                spellCheck={false}
                value={values[n] ?? ""}
                onChange={(e) => setValues({ ...values, [n]: e.target.value })}
              />
            </Field>
          ))}
        </Dialog>
      )}
      {confirming && (
        <Dialog
          title={t("calendar.disconnectTitle", { name: plugin.name })}
          consequence={t("calendar.disconnectConsequence")}
          confirmLabel={t("calendar.disconnect")}
          danger
          confirmDisabled={busy}
          error={error}
          onConfirm={() => void disconnect()}
          onClose={() => (setConfirming(false), setError(null))}
        />
      )}
    </li>
  );
}

/** The sign-in this server started: waiting (with the consent page's link), connected with its count, or why it failed. */
function Attempt({ plugin, consent }: { plugin: CalendarPluginView; consent: string | null }) {
  const a = plugin.attempt;
  if (!a) return null;
  if (a.state === "signing_in") {
    return (
      <p role="status" className="text-xs text-pretty text-text-2">
        {t("calendar.signingIn")}{" "}
        {consent && (
          <a href={consent} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
            {t("calendar.openSignIn")}
          </a>
        )}
      </p>
    );
  }
  if (a.state === "failed") {
    return (
      <p role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">
        {t("calendar.failed", { error: a.error ?? "" })}
      </p>
    );
  }
  return (
    <div role="status" className="text-xs text-pretty break-words">
      <p>{a.events === null ? t("calendar.connectedLater") : t("calendar.connectedEvents", { count: a.events })}</p>
      {a.error && <p className="text-pill-bad-fg">{t("calendar.firstSyncFailed", { error: a.error })}</p>}
    </div>
  );
}

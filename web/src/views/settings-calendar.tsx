import { useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { API, type CalendarPluginView, type CalendarView, RECONNECT_ERROR, postCalendarConnect, postCalendarDisconnect, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input, PASSWORD } from "../components/ui/input.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { When, useNow } from "./common.js";
import { Card } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";

// The Settings page's Calendar section (design 08-settings, 2026-11-13): each calendar plugin the server lists from
// the registry's connect hooks, by its own name (this file names no provider), connected or not, with its last sync time
// and last error. Connect posts the plugin alone: the server signs in with the plugin's default client and answers the
// consent page at once, with no dialog. A build with no default client (`default_client: false`) shows no Connect, which
// could only fail: it says so, and "Use my own client" is the main action. Only the "Use my own client" option asks for values: when the server
// answers which secrets that sign-in needs, a Dialog asks for them in password fields, and the values leave the page's
// state once the attempt is sent. Either way the server answers the consent page, opened in a new tab (and linked, if the browser blocks it), and the section polls GET /api/v1/calendar
// for the result. Disconnect asks first in the danger Dialog; nothing is sent until Confirm.
// Beside the connect actions, a note (collapsed by default) explains the provider's unverified-app screen and the
// 7-day expiry of a client in Testing status. A stored sync error of RECONNECT_ERROR (the sign-in expired or was
// revoked) shows the reconnect line with the same note, open, in place of "Last error", and keeps the connect actions.

export function CalendarSection({ token }: { token: string }) {
  const view = useApi<CalendarView>(API.calendar);
  if (view.isError) return <ErrorNote error={view.error} />;
  if (!view.data) return <Loading rows={1} />;
  // A server without the section (an older build) answers no list: the page shows no section rather than failing.
  const plugins = view.data.plugins ?? [];
  if (plugins.length === 0) return null;
  return (
    <div id="calendar">
      <Card title={t("calendar.title")} count={plugins.length}>
        <p className="mb-2 text-sm text-pretty text-text-2">{t("calendar.hint")}</p>
        <ul className="space-y-4 text-sm">
          {plugins.map((p) => (
            <CalendarRow key={p.name} plugin={p} token={token} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

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
  const reconnect = plugin.error === RECONNECT_ERROR;
  const refresh = () => client.invalidateQueries({ queryKey: [API.calendar] });

  /** The default sign-in with no argument; the own-client option with `own` (and, from its Dialog, the typed values). */
  const connect = async (own?: { values?: Record<string, string> }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await postCalendarConnect(token, plugin.name, own);
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
        <span data-raw className="font-medium wrap-anywhere">{plugin.name}</span>
        <Badge level={plugin.connected ? "ready_to_merge" : undefined}>{plugin.connected ? t("calendar.connected") : t("calendar.notConnected")}</Badge>
        <span className="text-xs text-text-2 tabular-nums">
          {plugin.synced_at ? <When at={plugin.synced_at} now={now} label="calendar.lastSync" /> : t("calendar.neverSynced")}
        </span>
      </div>
      {reconnect ? (
        <p role="alert" className="text-xs font-medium text-pretty text-pill-bad-fg">
          {t("calendar.reconnect")}
        </p>
      ) : (
        plugin.error && <p data-raw className="text-xs text-pretty break-words text-pill-bad-fg">{t("calendar.lastError", { error: plugin.error })}</p>
      )}
      {!plugin.connected && !plugin.default_client && <p className="text-xs text-pretty text-text-2">{t("calendar.noDefaultClient")}</p>}
      <Attempt plugin={plugin} consent={consent} />
      <ButtonRow>
        {(!plugin.connected || reconnect) && (
          <>
            {plugin.default_client && (
              <Button disabled={busy || signingIn} aria-label={t("calendar.connectLabel", { name: plugin.name })} onClick={() => void connect()}>
                {t("calendar.connect")}
              </Button>
            )}
            <Button
              variant={plugin.default_client ? "ghost" : "secondary"}
              disabled={busy || signingIn}
              aria-label={t("calendar.ownClientLabel", { name: plugin.name })}
              onClick={() => void connect({})}
            >
              {plugin.default_client ? t("calendar.ownClient") : t("calendar.ownClientMain")}
            </Button>
          </>
        )}
        {plugin.connected && (
          <Button variant="danger" disabled={busy || signingIn} aria-label={t("calendar.disconnectLabel", { name: plugin.name })} onClick={() => (setError(null), setConfirming(true))}>
            {t("calendar.disconnect")}
          </Button>
        )}
      </ButtonRow>
      {(!plugin.connected || reconnect) && <ConnectNote key={String(reconnect)} open={reconnect} />}
      {error && asking === null && !confirming && (
        <p role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">
          {error}
        </p>
      )}
      {asking && (
        <Dialog
          title={t("calendar.ownClientTitle", { name: plugin.name })}
          consequence={t("calendar.connectConsequence")}
          confirmLabel={t("calendar.signIn")}
          confirmDisabled={busy || asking.needs.some((n) => !values[n]?.trim())}
          error={error}
          onConfirm={() => void connect({ values: Object.fromEntries(asking.needs.map((n) => [n, values[n] ?? ""])) })}
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

/** Why the provider's consent page may warn, and when a connect expires: collapsed beside Connect, open when reconnecting. */
function ConnectNote({ open: start }: { open: boolean }) {
  const [open, setOpen] = useState(start);
  const id = useId();
  return (
    <div data-calendar-note>
      <Button variant="ghost" size="sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)} className={LINK_CLASS}>
        {t("calendar.noteToggle")}
      </Button>
      <div id={id} hidden={!open} className="mt-1 space-y-1 text-xs text-pretty text-text-2">
        <p>{t("calendar.noteUnverified")}</p>
        <p>{t("calendar.noteTesting")}</p>
      </div>
    </div>
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

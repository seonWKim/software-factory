import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { API, type AutoStop, type MigrateDryRun, type PausesView, type SettingsView, type SupervisorView, type SystemAction, postMigrate, postResume, postSupervisor, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { BANNER_LINK_CLASS } from "../components/ui/link-style.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { useNavigate } from "../nav.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { OverflowMenu } from "../components/ui/menu.js";
import { BASE } from "../pages.js";
import { When, useNow } from "./common.js";
import { AutoStopNote, alarmAnchor } from "./settings/general.js";

/**
 * Shown while the app was built from another revision than the server it talks to runs (design §9): the tab
 * holds old code, or the UI server does. Only "they differ", never which is newer. Hidden while either is unknown.
 */
export function RevisionBanner({ server, web }: { server: string | null | undefined; web: string | null }) {
  if (!server || !web || server === web) return null;
  return (
    <p role="alert" data-testid="revision-banner" className="border-b border-pill-warn-fg bg-pill-warn-bg px-4 py-2 text-sm text-pretty text-pill-warn-fg">
      {t("banner.outOfDate")}<a href="" className={BANNER_LINK_CLASS}>{t("banner.reload")}</a>{t("banner.restart")}<code className="font-mono">{"factory ui"}</code>
    </p>
  );
}


const FAILURES = `${BASE}failures`;

/**
 * One system action as a Needs-you row in the Check group (design 09-status-page): an open alarm (AlarmRow), a claim
 * pause (PauseCheckRow), else its sentence and the command that clears it.
 */
export function CheckRow({ action }: { action: SystemAction }) {
  if (action.code === "alarm") return <AlarmRow action={action} />;
  if (action.code === "claim_pause" && action.pause) return <PauseCheckRow action={action} pause={action.pause} />;
  return (
    <ListRow
      data-check={action.code}
      title={<p title={action.text} className={cn(ROW_TITLE, "text-text-1")}>{action.text}</p>}
      details={<code className="min-w-0 font-mono wrap-anywhere">{action.command}</code>}
    >
      {action.code === "migration_pending" && <SupervisorActions actions={["migrate"]} />}
    </ListRow>
  );
}

/**
 * A claim pause's Needs-you row (design 09-dashboard-tasks): its plain name, when it is checked next (model_stall) or
 * ends, as a relative time with the local time on hover, and Resume now. No CLI command: the button is the action.
 */
function PauseCheckRow({ action, pause }: { action: SystemAction; pause: string }) {
  const now = useNow();
  const token = useApi<PausesView>(API.pauses).data?.csrf_token ?? null;
  const due = action.until !== null && Date.parse(action.until) <= now;
  const stall = pause === "model_stall";
  const label = stall ? (due ? "needs.pauseNextDue" : "needs.pauseNext") : due ? "needs.pauseEnded" : "needs.pauseEnds";
  return (
    <ListRow
      data-check="claim_pause"
      data-pause={pause}
      title={<p title={action.text} className={cn(ROW_TITLE, "text-text-1")}>{action.text}</p>}
      {...(action.until !== null ? { details: <When at={action.until} now={now} label={label} /> } : {})}
    >
      <ResumeNow name={pause} token={token} />
    </ListRow>
  );
}

/**
 * "Resume now" for one claim pause, the one copy of its handler (the Tasks pause row and Health's pause list): posts
 * `{ name }` with the page's CSRF token, then reloads the pauses and the overview. The endpoint's refusal shows beside
 * the button. Nothing while the server has no resume route (`token` null).
 */
export function ResumeNow({ name, token }: { name: string; token: string | null }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (token === null) return null;
  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postResume(token, name);
      if (!r.ok) setError(r.error);
      else await Promise.all([client.invalidateQueries({ queryKey: [API.pauses] }), client.invalidateQueries({ queryKey: [API.overview] })]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="secondary" disabled={busy} onClick={() => void resume()}>{t("pause.resume")}</Button>
      {error && <span role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error}</span>}
    </>
  );
}

/** One of the supervisor's dashboard actions (design 08-self-update): Migrate now, Start, Restart now. */
export type SupervisorActionName = "migrate" | "start" | "restart";

const ACTION_LABEL = { migrate: "supervisor.migrate", start: "supervisor.start", restart: "supervisor.restart" } as const;

/**
 * The buttons of `actions` the server offers (GET /api/v1/supervisor), each behind a confirm dialog. When it offers
 * none of them, the first one's reason in plain words (no live supervisor, a migration under way, …). Nothing while
 * the read fails (a server without these routes).
 */
export function SupervisorActions({ actions }: { actions: readonly SupervisorActionName[] }) {
  const view = useApi<SupervisorView>(API.supervisor);
  const [open, setOpen] = useState<SupervisorActionName | null>(null);
  const v = view.data;
  if (!v) return null;
  const offered = actions.filter((a) => v[a].offered);
  if (offered.length === 0) {
    const reason = actions.map((a) => v[a].reason).find((r) => r !== null);
    return reason ? <span data-supervisor-refusal className="min-w-0 text-xs text-pretty wrap-anywhere text-text-2">{reason}</span> : null;
  }
  return (
    <span className="flex flex-wrap gap-2">
      {offered.map((a) => (
        <Button key={a} data-supervisor-action={a} variant="secondary" onClick={() => setOpen(a)}>{t(ACTION_LABEL[a])}</Button>
      ))}
      {open === "migrate" && <MigrateDialog token={v.csrf_token} onClose={() => setOpen(null)} />}
      {(open === "start" || open === "restart") && <SupervisorDialog action={open} token={v.csrf_token} onClose={() => setOpen(null)} />}
    </span>
  );
}

/** Reloads what the supervisor's state shows: the offers and the overview's banner. */
function useReloadSupervisor() {
  const client = useQueryClient();
  return () => Promise.all([client.invalidateQueries({ queryKey: [API.supervisor] }), client.invalidateQueries({ queryKey: [API.overview] })]);
}

/** Migrate now: the dry run (the pending steps and each change) first, then the confirm runs the migration. */
function MigrateDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const reload = useReloadSupervisor();
  const [dry, setDry] = useState<MigrateDryRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The dry run, once per opening: it files nothing.
  useEffect(() => {
    let live = true;
    void postMigrate(token, false).then(
      (r) => live && (r.ok ? setDry(r.dry_run) : setError(r.error)),
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    );
    return () => {
      live = false;
    };
  }, [token]);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postMigrate(token, true);
      if (!r.ok) return setError(r.error);
      announceStatus(t("supervisor.migrateStarted"));
      await reload();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t("supervisor.migrateTitle")} consequence={t("supervisor.migrateConsequence")} confirmLabel={t("supervisor.migrate")}
      confirmDisabled={busy || dry === null || !dry.ok} error={error} onConfirm={() => void confirm()} onClose={onClose}>
      <div data-migrate-dry-run className="min-w-0 space-y-2 text-sm">
        {dry === null ? (error ? null : <p>{t("supervisor.dryRunLoading")}</p>) : (
          <>
            <p className="text-pretty wrap-anywhere">{dry.pending.length > 0 ? t("supervisor.pending", { pending: dry.pending.join(", ") }) : t("supervisor.noPending")}</p>
            {!dry.ok && <p className="text-pill-bad-fg">{t("supervisor.dryRunFailed")}</p>}
            {dry.lines.length > 0 && (
              <pre className="max-h-64 overflow-auto rounded-control bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{dry.lines.join("\n")}</pre>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** Start or Restart now, behind its confirm: files the request the supervisor reads on its next poll. */
function SupervisorDialog({ action, token, onClose }: { action: "start" | "restart"; token: string; onClose: () => void }) {
  const reload = useReloadSupervisor();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postSupervisor(token, action);
      if (!r.ok) return setError(r.error);
      announceStatus(t("supervisor.filed"));
      await reload();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const start = action === "start";
  return (
    <Dialog title={t(start ? "supervisor.startTitle" : "supervisor.restartTitle")} consequence={t(start ? "supervisor.startConsequence" : "supervisor.restartConsequence")}
      confirmLabel={t(ACTION_LABEL[action])} confirmDisabled={busy} error={error} onConfirm={() => void confirm()} onClose={onClose} />
  );
}

/**
 * An open alarm's row on the shared ListRow: its text on one line, the full text (with the detail) behind a toggle,
 * and "Open on Failures" in its "⋯" menu (every row action is in the menu, owner feedback 2026-11-20). The auto-mode stop's alarm (design 03-risk) is the target of the Settings link to it and has
 * "Turn auto back on" as its button, with "Open on Failures" in the same "⋯" menu. No dismiss: an alarm closes by itself.
 */
function AlarmRow({ action }: { action: SystemAction }) {
  const stop = action.auto_stop;
  const navigate = useNavigate();
  return (
    <ListRow
      data-check="alarm"
      {...(stop ? { id: alarmAnchor(stop.alert_id) } : {})}
      title={<p data-alarm-summary title={action.text} className={cn(ROW_TITLE, "text-text-1")}>{action.text}</p>}
      menu={<OverflowMenu label={t("commands.more")} items={[{ label: t("needs.alarmOpen"), action: "failures", onSelect: () => navigate(FAILURES) }]} />}
    >
      {stop && <AutoStopLine stop={stop} />}
    </ListRow>
  );
}

/** The auto-mode stop's when and why with "Turn auto back on"; it reads the settings view for the button's write. */
function AutoStopLine({ stop }: { stop: AutoStop }) {
  const settings = useApi<SettingsView>(API.settings);
  return <AutoStopNote stop={stop} view={settings.data} />;
}

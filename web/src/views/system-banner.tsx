import { useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { API, type AutoStop, type FactoryState, type MigrateDryRun, type PausesView, type SettingsView, type SupervisorView, type SystemAction, postMigrate, postResume, postSupervisor, useApi } from "../api.js";
import { postDismissAlarm } from "../api/alarms.js";
import { postJson } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Disclosure } from "../components/ui/disclosure.js";
import { BANNER_LINK_CLASS, LINK_CLASS } from "../components/ui/link-style.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { ListRow, ROW_TITLE } from "../components/ui/list-row.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { useWide } from "../components/ui/parts.js";
import { When, useNow } from "./common.js";
import { alarmAnchor } from "./settings/general.js";
import { Outcome, useWrite } from "./settings-file-keys.js";
import { ModeDialog } from "./settings/mode-dialog.js";
import { ShowFailuresDialog, WhatFailedDialog } from "./alarm-dialogs.js";
import { HeldCases, HeldVersionActions, heldRates, useHeldVersions } from "./evals.js";
import { AddModelCredential } from "./model-credential-dialog.js";
import { Toast } from "../components/ui/toast.js";

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

/** Local merges whose base push waits (design 09-dashboard-shell): the RevisionBanner's markup; hidden at 0 or unknown. */
export function UnpushedMerges({ count }: { count: number | undefined }) {
  if (!count) return null;
  return (
    <p role="alert" data-testid="unpushed-merges" className="border-b border-pill-warn-fg bg-pill-warn-bg px-4 py-2 text-sm text-pretty text-pill-warn-fg">
      {t("unpushed.merges", { count })}
    </p>
  );
}

/** This browser's last seen factory revision (design 09-dashboard-shell): a revision's update toast shows once. */
export const SEEN_REV_KEY = "sf-factory-rev";

/** Storage can throw (private mode, blocked site data): then nothing is stored and no toast shows. */
function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // no storage: nothing kept
  }
}

/**
 * Notes `rev` as seen and says whether its update toast shows: only when this browser had stored another revision.
 * Storing it at once is what keeps a reload, a poll or another tab from showing the same revision's toast again. A
 * first visit (none stored) only stores it.
 */
function noteFor(rev: string): boolean {
  const seen = stored(SEEN_REV_KEY);
  if (seen === rev) return false;
  store(SEEN_REV_KEY, rev);
  return seen !== null && stored(SEEN_REV_KEY) === rev;
}

const shortRev = (rev: string) => rev.slice(0, 7);

/**
 * One toast after the factory moved to a new revision (design 09-dashboard-shell): "Updated to <rev>: N changes" and
 * the commit subjects behind a Changes toggle, in the shared Toast, which goes by itself after a few seconds (or on
 * Dismiss). Shown once per revision in this browser. Without a count (git failed, or no previous_rev) it names the
 * revision only.
 */
export function UpdateNote({ factory }: { factory: FactoryState | null | undefined }) {
  const rev = factory?.rev ?? null;
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (rev !== null && noteFor(rev)) setShown(rev);
  }, [rev]);
  if (rev === null || shown !== rev) return null;
  const count = factory?.changes?.count ?? null;
  const subjects = count === null ? [] : (factory?.changes?.subjects ?? []);
  const short = shortRev(rev);
  return (
    <Toast key={rev} dismissLabel={t("update.dismiss")} onClose={() => setShown(null)}>
      <div data-testid="update-note">
        <p data-update-text className="font-medium text-pretty">
          {count === null ? t("update.noteNoCount", { rev: short }) : count === 1 ? t("update.noteOne", { rev: short }) : t("update.note", { rev: short, count })}
        </p>
        {subjects.length > 0 && (
          <Disclosure summary={t("update.changes")}>
            <ul className="mt-1 max-h-48 list-disc space-y-0.5 overflow-y-auto pl-5 text-xs text-text-2 wrap-anywhere">
              {subjects.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
            {count !== null && count > subjects.length && <p className="mt-1 text-xs text-text-2">{t("update.more", { count: count - subjects.length })}</p>}
          </Disclosure>
        )}
      </div>
    </Toast>
  );
}

/**
 * The running revision in the sidebar footer (design 09-dashboard-shell), one quiet line at the labels' left edge: its
 * short form and "up to date" or "N behind" ("Factory version" for screen readers and in the tooltip) when the status file says (a separate code checkout); the tooltip says what the hash is.
 * Shown with the full sidebar (from `lg`); the icon sidebar has no room, and Health's code row names it there.
 * Hidden without a factory status or a running revision.
 */
export function FactoryRevision({ factory }: { factory: FactoryState | null | undefined }) {
  if (!factory?.rev) return null;
  const rev = shortRev(factory.rev);
  const behind = factory.behind ?? null;
  const text = behind === null ? rev : behind === 0 ? t("update.revCurrent", { rev }) : t("update.revBehind", { rev, count: behind });
  return (
    // One quiet line, starting where the sidebar labels start (after the row's 8px padding, 16px icon and 8px gap).
    <p title={t("update.revTooltip")} className="truncate pl-8 text-xs text-text-2 max-lg:hidden">
      <span className="sr-only">{t("update.revLabel")} </span>
      <span data-testid="factory-rev" className="font-mono">{text}</span>
    </p>
  );
}

/**
 * One system action as a Needs-you row in the Check group (design 09-status-page): an open alarm (AlarmRow), a claim
 * pause (PauseCheckRow), a missing model credential (ModelCredentialRow), else its sentence and the command that clears it.
 */
export function CheckRow({ action }: { action: SystemAction }) {
  if (action.code === "alarm") return <AlarmRow action={action} />;
  if (action.code === "claim_pause" && action.pause) return <PauseCheckRow action={action} pause={action.pause} />;
  if (action.code === "model_credential") return <ModelCredentialRow action={action} />;
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
  const pauses = useApi<PausesView>(API.pauses).data;
  const token = pauses?.csrf_token ?? null;
  if (pause === OWNER_PAUSE) return <OwnerPauseRow action={action} since={pauses?.pauses.find((p) => p.name === OWNER_PAUSE)?.since ?? null} token={token} />;
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
 * The missing model credential's Needs-you row (design 09-status-page): its sentence, why it matters in the details
 * line, no command, and a visible Add model credential button that opens the dialog.
 */
function ModelCredentialRow({ action }: { action: SystemAction }) {
  return (
    <ListRow
      data-check="model_credential"
      title={<p title={action.text} className={cn(ROW_TITLE, "text-text-1")}>{action.text}</p>}
      details={<span>{t("needs.credentialWhy")}</span>}
    >
      <AddModelCredential />
    </ListRow>
  );
}

/** The owner pause's name (`factory stop`, Stop all agents): it has no end time, only when it began. */
const OWNER_PAUSE = "owner";

/**
 * The owner pause's Needs-you row (design 09-dashboard-tasks): "Agents stopped by you at 16:03" in local time, and Resume
 * now. Until the pause list has loaded, the server's plain name.
 */
function OwnerPauseRow({ action, since, token }: { action: SystemAction; since: string | null; token: string | null }) {
  const title = since === null ? action.text : t("stop.stoppedAt", { time: clockTime(since) });
  return (
    <ListRow data-check="claim_pause" data-pause={OWNER_PAUSE} title={<p title={title} className={cn(ROW_TITLE, "text-text-1")}>{title}</p>}>
      <ResumeNow name={OWNER_PAUSE} token={token} />
    </ListRow>
  );
}

/** POST /api/v1/agents/stop (src/ui/agents-api.ts): starts the owner pause. */
const STOP_PATH = "/api/v1/agents/stop";

/**
 * Stop all agents in the top bar (design 09-dashboard-shell): a secondary button (icon-only below `sm`, its name as `aria-label`) that opens a confirm dialog, which posts
 * the stop and then reloads the pauses and the overview, so Needs you shows the stop with Resume now. Hidden while the
 * agents are stopped (Resume now is the way back) and while the server has no pause routes.
 */
export function StopAllAgents() {
  const client = useQueryClient();
  const view = useApi<PausesView>(API.pauses).data;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wide = useWide();
  const token = view?.csrf_token ?? null;
  if (token === null || view?.pauses.some((p) => p.name === OWNER_PAUSE)) return null;
  const close = () => {
    setOpen(false);
    setError(null);
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postJson<{ error?: string }>(STOP_PATH, token, {});
      if (!r.ok) return setError(r.value.error ?? t("api.http", { status: r.status }));
      announceStatus(t("stop.stopped"));
      await Promise.all([client.invalidateQueries({ queryKey: [API.pauses] }), client.invalidateQueries({ queryKey: [API.overview] })]);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {wide ? (
        <Button data-testid="stop-all-agents" variant="secondary" className="shrink-0" onClick={() => setOpen(true)}>{t("stop.button")}</Button>
      ) : (
        <Button data-testid="stop-all-agents" variant="secondary" size="icon" aria-label={t("stop.button")} onClick={() => setOpen(true)}>
          <OctagonX aria-hidden className="size-4" />
        </Button>
      )}
      {open && (
        <Dialog title={t("stop.title")} consequence={t("stop.consequence")} confirmLabel={t("stop.button")} confirmDisabled={busy} error={error}
          onConfirm={() => void confirm()} onClose={close} />
      )}
    </>
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

/** Each auto-mode stop's cause (its alarm's error code, design 03-risk), as the alarm row's sentence names it. */
const STOP_CAUSE: Readonly<Record<string, MessageKey>> = {
  red_main: "needs.autoStopRedMain",
  budget_checkpoint: "needs.autoStopBudget",
  failure_alert: "needs.autoStopFailure",
};

/** A time of day in the browser's time zone, hours and minutes (16:03). */
const clockTime = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * An open alarm's row on the shared ListRow (design 09-dashboard-tasks-needs): Dismiss at the row's end, then its "⋯"
 * menu. The auto-mode stop's alarm (design 03-risk) is AutoStopRow, which has no Dismiss. A held skill version's alarm is
 * HeldVersionAlarmRow, settled by its buttons. A red_main alarm has What failed; a repeated error has Show failures; both
 * open a dialog on this page. Other alarms have no menu.
 */
function AlarmRow({ action }: { action: SystemAction }) {
  if (action.auto_stop) return <AutoStopRow action={action} stop={action.auto_stop} />;
  return action.pattern === "skill_version_gate" ? <HeldVersionAlarmRow action={action} /> : <PlainAlarmRow action={action} />;
}

/**
 * A held skill version's alarm (design 07-self-improvement): its sentence, the version and its pass rates, the cases that
 * got worse, then "Keep the current version" and "Use this version", the Evals page's own actions; settling either way
 * dismisses the alarm. Until the held versions load, or when this alarm names none of them, the plain alarm row.
 */
function HeldVersionAlarmRow({ action }: { action: SystemAction }) {
  const held = useHeldVersions().data?.held?.find((h) => h.alert_id !== null && h.alert_id === action.alert_id);
  if (!held?.skill) return <PlainAlarmRow action={action} />;
  return (
    <ListRow
      data-check="alarm"
      data-held-alarm={held.version}
      title={<p data-alarm-summary data-raw title={action.text} className={cn(ROW_TITLE, "text-text-1")}>{action.text}</p>}
      details={<><span>{t("evals.heldTitle", { n: held.version })}</span><span>{heldRates(held)}</span></>}
    >
      <p className="text-xs font-medium text-text-2">{t("evals.heldWorse")}</p>
      <HeldCases held={held} />
      <HeldVersionActions held={held} skill={held.skill} size="sm" />
    </ListRow>
  );
}

/**
 * A non-auto-stop alarm's row: Dismiss and its refusal, then the "⋯" menu when the alarm has a dialog. A failed chat
 * check (issue #915) links Health before Dismiss; an alarm with a raw `detail` shows it under a closed Details toggle
 * only, and its plain sentence wraps instead of being cut, so its first clause reads in full at 390 px.
 */
function PlainAlarmRow({ action }: { action: SystemAction }) {
  const what = action.pattern === "red_main" ? "what_failed" : action.pattern === "repeated_error" && action.error_code ? "show_failures" : null;
  const dismiss = useDismissAlarm(action.alert_id ?? null);
  const health = action.pattern === "chat_eval_failed" && <Link data-alarm-health href={`${BASE}health`} className={cn(LINK_CLASS, "shrink-0 text-sm")}>{t("system.openHealth")}</Link>;
  const detail = action.detail ?? null;
  return (
    <AlarmMenuRow action={action} title={action.text} wrap={action.detail !== undefined} lead={[]} dialog={what} output={action} end={health || dismiss.button ? <>{health}{dismiss.button}</> : null}>
      {detail !== null && (
        <Disclosure data-alarm-details lazy summary={t("needs.alarmDetails")}>
          <p data-raw className="text-xs text-pretty wrap-anywhere text-text-2">{detail}</p>
        </Disclosure>
      )}
      {dismiss.error}
    </AlarmMenuRow>
  );
}

/**
 * Dismiss on an alarm row, modelled on ResumeNow: posts the alarm's `alert_id` with the pauses' CSRF token, then
 * reloads the overview, so the row leaves Needs you. `button` goes in the row's end slot (the sm Button's negative
 * margin keeps the row's height); `error`, a refusal, goes on its own line below the row's title, never in the actions
 * column (patterns C-050). Neither while the alarm has no `alert_id` or the server has no pause routes.
 */
function useDismissAlarm(alertId: string | null): { button: ReactNode; error: ReactNode } {
  const client = useQueryClient();
  const token = useApi<PausesView>(API.pauses).data?.csrf_token ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (token === null || alertId === null) return { button: null, error: null };
  const dismiss = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await postDismissAlarm(token, alertId);
      if (!r.ok) setError(r.error);
      else await client.invalidateQueries({ queryKey: [API.overview] });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return {
    button: <Button data-dismiss-alarm size="sm" variant="secondary" className="-my-1" disabled={busy} onClick={() => void dismiss()}>{t("needs.dismissAlarm")}</Button>,
    error: error && <p data-row-error role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error}</p>,
  };
}

/**
 * The auto-mode stop's row, the target of the Settings link to it: one sentence in local time, "Auto mode stopped at
 * 16:03: <cause>", with the server's full text behind a Details toggle (closed); its menu has Turn auto back on, then
 * What failed.
 */
function AutoStopRow({ action, stop }: { action: SystemAction; stop: AutoStop }) {
  const turnOn = useTurnAutoOn();
  const [confirming, setConfirming] = useState(false);
  const cause = STOP_CAUSE[stop.cause];
  const sentence = t("needs.autoStopped", { time: clockTime(stop.at), cause: cause ? t(cause) : stop.cause });
  const lead = [{ label: t("needs.autoStopTurnOn"), action: "auto_on", disabled: !turnOn.ready, onSelect: () => setConfirming(true) }];
  return (
    <AlarmMenuRow action={action} id={alarmAnchor(stop.alert_id)} title={sentence} lead={lead} dialog="what_failed" output={stop}>
      <Disclosure data-alarm-details lazy summary={t("needs.alarmDetails")}>
        <p className="text-xs text-pretty wrap-anywhere text-text-2">{action.text}</p>
      </Disclosure>
      {confirming && <ModeDialog to="auto" busy={turnOn.busy} error={turnOn.error} onConfirm={() => void turnOn.write().then((ok) => ok && setConfirming(false))} onClose={() => setConfirming(false)} />}
      <Outcome error={turnOn.error} done={null} />
    </AlarmMenuRow>
  );
}

/**
 * An alarm row's ListRow: its title on one line (or wrapped), `end` (Dismiss) in the row's end slot before the "⋯" menu, `lead` then
 * the item that opens its dialog in that menu, and the dialog.
 */
function AlarmMenuRow({ action, id, title, wrap = false, lead, dialog, output, end, children }: {
  action: SystemAction;
  id?: string;
  title: string;
  /** The title wraps onto more lines instead of being cut with an ellipsis (a fixed, plain sentence). */
  wrap?: boolean;
  lead: MenuItem[];
  dialog: "what_failed" | "show_failures" | null;
  output: Pick<SystemAction, "failing_tests" | "output_tail">;
  end?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const opener = dialog === "what_failed" ? "needs.whatFailed" : "needs.showFailures";
  const items = dialog === null ? lead : [...lead, { label: t(opener), action: dialog, onSelect: () => setOpen(true) }];
  return (
    <ListRow
      data-check="alarm"
      {...(id ? { id } : {})}
      title={<p data-alarm-summary data-raw title={title} className={cn(wrap ? "block text-sm text-pretty" : ROW_TITLE, "text-text-1")}>{title}</p>}
      {...(items.length > 0 || end ? { menu: <span className="flex items-center gap-2">{end}{items.length > 0 && <OverflowMenu label={t("commands.more")} items={items} />}</span> } : {})}
    >
      {children}
      {open && dialog === "what_failed" && <WhatFailedDialog output={output} onClose={() => setOpen(false)} />}
      {open && dialog === "show_failures" && <ShowFailuresDialog code={action.error_code ?? ""} onClose={() => setOpen(false)} />}
    </ListRow>
  );
}

/**
 * Turn auto back on from the auto-stop row, once its ModeDialog is confirmed: mode auto through POST /api/v1/settings,
 * the same write as the Settings note's button, at the project's level when it has its own mode. Not ready while the
 * settings view loads or a write is under way.
 */
function useTurnAutoOn() {
  const view = useApi<SettingsView>(API.settings).data;
  const { busy, error, write } = useWrite(view?.csrf_token ?? "");
  const row = view?.keys.find((k) => k.key === "mode");
  const own = view && row && view.project !== null ? row.projects.some((p) => p.project === view.project) : false;
  return {
    ready: row !== undefined && !busy,
    busy,
    error,
    write: () => write({ action: "set", key: "mode", value: JSON.stringify("auto"), ...(own && view ? { project: view.repo } : {}) }),
  };
}

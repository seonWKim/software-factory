import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ACTIVITY_KEY, type ActivityActor, type ActivityAction, type ActivityAlert, type ActivityView, useActivity } from "../../api/activity.js";
import { postDismissAlarm } from "../../api/alarms.js";
import { API, type Session, useApi } from "../../api.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card } from "../../components/ui/card.js";
import { type Column, DataTable } from "../../components/ui/data-table.js";
import { KeyValue } from "../../components/ui/key-value.js";
import { Notice, PageHeader } from "../../components/ui/notice.js";
import { ErrorNote, Loading } from "../../components/ui/parts.js";
import { t } from "../../i18n/index.js";
import { localDateTime, relativeTime } from "../../lib/format.js";
import { Link, useNavigate } from "../../nav.js";
import { useNow } from "../common.js";

// The Activity page (design 09-dashboard-activity): PageHeader Activity; a Card Actors with a DataTable of one row per
// actor (Badge state, Button Transcript); a Card About <actor> with KeyValue now, last, next run and a DataTable of its
// recent actions (outcome, reason, Transcript or log link). Open factory alerts come with a Clear button. One read:
// GET /api/v1/activity, the `activity.actors` capability (the chat reads the same one).

const STATE_LEVEL = { idle: undefined, running: "info", attention: "warn" } as const;
const STATE_TEXT = { idle: "actors.state.idle", running: "actors.state.running", attention: "actors.state.attention" } as const;

const when = (at: string | null, now: number, empty: string) => (at === null ? empty : <span title={localDateTime(at)}>{relativeTime(at, now)}</span>);

/** The Transcript button: opens the run's transcript; absent for an action whose reference is a log line. */
function TranscriptButton({ href, label }: { href: string | null; label: string }) {
  const go = useNavigate();
  if (href === null) return null;
  return <Button size="sm" aria-label={label} onClick={() => go(href)}>{t("actors.transcript")}</Button>;
}

function ActionLink({ a }: { a: ActivityAction }) {
  if (a.link === null) return null;
  if (a.link.kind === "transcript" && a.link.href !== null) return <Link href={a.link.href} className="underline">{t("actors.link.transcript")}</Link>;
  return <span title={a.link.text}>{t("actors.link.log")}: {a.link.text}</span>;
}

/** Open factory alerts, each with a Clear button that dismisses it. */
function Alerts({ alerts }: { alerts: readonly ActivityAlert[] }) {
  const client = useQueryClient();
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? null;
  const [error, setError] = useState<string | null>(null);
  const clear = async (id: string) => {
    if (token === null) return;
    setError(null);
    const r = await postDismissAlarm(token, id);
    if (!r.ok) setError(t("actors.clearFailed", { error: r.error }));
    await client.invalidateQueries({ queryKey: [ACTIVITY_KEY] });
  };
  if (alerts.length === 0 && error === null) return null;
  return (
    <Card title={t("actors.alerts")} label={t("actors.alertsLabel")} count={alerts.length}>
      {error !== null && <Notice tone="bad">{error}</Notice>}
      <DataTable<ActivityAlert>
        label={t("actors.alertsLabel")} empty={t("actors.noActions", { days: 30 })} rowKey={(a) => a.alert_id}
        rows={alerts}
        columns={[
          { key: "text", header: t("actors.col.reason") },
          { key: "created_at", header: t("actors.col.at"), render: (a) => localDateTime(a.created_at) },
          { key: "clear", header: "", render: (a) => <Button size="sm" aria-label={t("actors.clearFor", { text: a.text })} disabled={token === null} onClick={() => void clear(a.alert_id)}>{t("actors.clear")}</Button> },
        ]}
      />
    </Card>
  );
}

/** The recent actions of one actor: outcome, reason and a Transcript or log link. */
function ActionsTable({ actor, days }: { actor: ActivityActor; days: number }) {
  const columns: Column<ActivityAction>[] = [
    { key: "at", header: t("actors.col.at"), render: (a) => localDateTime(a.at), className: "whitespace-nowrap" },
    { key: "subject", header: t("actors.col.subject") },
    { key: "outcome", header: t("actors.col.outcome") },
    { key: "reason", header: t("actors.col.reason") },
    { key: "link", header: t("actors.col.link"), render: (a) => <ActionLink a={a} /> },
  ];
  return <DataTable<ActivityAction> label={t("actors.recentLabel", { name: actor.name })} empty={t("actors.noActions", { days })} rowKey={(a) => String(a.seq)} rows={actor.actions} columns={columns} />;
}

function ActorDetail({ actor, days, now }: { actor: ActivityActor; days: number; now: number }) {
  return (
    <Card title={t("actors.about", { name: actor.name })}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-2 text-pretty">{actor.about}</p>
        <KeyValue
          items={[
            { key: "now", term: t("actors.detail.now"), value: actor.now },
            { key: "last", term: t("actors.detail.last"), value: when(actor.last_at, now, t("actors.never")) },
            { key: "next", term: t("actors.detail.next"), value: when(actor.next_run_at, now, t("actors.noNext")) },
          ]}
        />
        <ActionsTable actor={actor} days={days} />
      </div>
    </Card>
  );
}

/** The Activity page's body: the Actors Card and the About Card of the selected actor. */
export function ActivityBody({ view, now }: { view: ActivityView; now: number }) {
  const [selected, setSelected] = useState<string | null>(null);
  const actor = view.actors.find((a) => a.actor_id === selected) ?? view.actors[0];
  const columns: Column<ActivityActor>[] = [
    { key: "name", header: t("actors.col.actor") },
    { key: "state", header: t("actors.col.state"), render: (a) => <Badge level={STATE_LEVEL[a.state]}>{t(STATE_TEXT[a.state])}</Badge> },
    { key: "now", header: t("actors.col.now") },
    { key: "last_at", header: t("actors.col.last"), render: (a) => when(a.last_at, now, t("actors.never")) },
    { key: "next_run_at", header: t("actors.col.next"), render: (a) => when(a.next_run_at, now, t("actors.noNext")) },
    { key: "transcript", header: "", render: (a) => <TranscriptButton href={a.transcript?.href ?? null} label={t("actors.transcriptFor", { name: a.name })} /> },
  ];
  return (
    <>
      <Alerts alerts={view.alerts} />
      <Card title={t("actors.actors")} label={t("actors.actorsLabel")} count={view.actors.length}>
        <DataTable<ActivityActor>
          label={t("actors.actorsLabel")} empty={t("actors.noActors")} rowKey={(a) => a.actor_id} dataKey
          rows={view.actors} columns={columns}
          select={{ key: actor?.actor_id ?? null, onSelect: setSelected, label: (a) => t("actors.about", { name: a.name }) }}
        />
      </Card>
      {actor !== undefined && <ActorDetail actor={actor} days={view.retention_days} now={now} />}
    </>
  );
}

/** The Activity page: every autonomous actor, what it does now, its last and next run and its recent actions. */
export function ActivityActorsPage() {
  const now = useNow();
  const q = useActivity();
  return (
    <>
      <PageHeader title={t("actors.title")} description={t("actors.description", { days: q.data?.retention_days ?? 30 })} />
      {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={3} label="actors.loading" onRetry={() => void q.refetch()} /> : <ActivityBody view={q.data} now={now} />}
    </>
  );
}

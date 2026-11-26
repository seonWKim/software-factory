import { Copy } from "lucide-react";
import { type CoordinatorAction, type CoordinatorView, useCoordinator } from "../api/coordinator.js";
import { Badge } from "../components/ui/badge.js";
import { Card } from "../components/ui/card.js";
import { copyToClipboard } from "../components/ui/copy.js";
import { announceStatus } from "../components/ui/dialog.js";
import { ROW_TITLE, ListRow } from "../components/ui/list-row.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { useNow } from "./common.js";

// The Coordinator card of the Work page (design 09-dashboard-system): above the work list, the coordinator's switch
// (read-only: it changes with `factory settings set coordinator`), what it does now, when its next check is due (every
// 15 minutes) and its recent actions, newest first. One read: GET /api/v1/coordinator, the `coordinator.status`
// capability. Built from Card, ListRow, Switch, Badge and EmptyState; each action's menu holds its transcript.

const OUTCOMES = ["requested", "refused", "skipped", "failed"] as const;
const outcomeText = (o: string) => ((OUTCOMES as readonly string[]).includes(o) ? t(`coordinator.outcome.${o}` as MessageKey) : o);

/** What the coordinator is doing: off, waiting for its first check, or checking every interval. */
function activityText(v: CoordinatorView): string {
  if (!v.on) return t("coordinator.activityOff");
  return v.next_check_at === null ? t("coordinator.activityFirst") : t("coordinator.activityOn");
}

/** The action's menu: its transcript link, only when one is stored. */
function transcriptMenu(a: CoordinatorAction): readonly MenuItem[] {
  if (a.transcript === null) return [];
  const link = `storage:${a.transcript}`;
  return [{ label: t("coordinator.transcript"), icon: Copy, onSelect: () => void copyToClipboard(link).then((ok) => ok && announceStatus(t("copy.done"))) }];
}

function ActionRow({ a, now }: { a: CoordinatorAction; now: number }) {
  const items = transcriptMenu(a);
  return (
    <ListRow
      data-coordinator-action={`${a.cycle_id}:${a.seq}`}
      title={<span className={ROW_TITLE} title={a.command}>{a.command}</span>}
      details={<>
        <Badge level={a.outcome === "failed" ? "failed" : undefined}>{outcomeText(a.outcome)}</Badge>
        <span>{a.reason}</span>
        <span title={localDateTime(a.at)}>{relativeTime(a.at, now)}</span>
      </>}
      menu={items.length > 0 ? <OverflowMenu label={t("coordinator.actionMenu", { command: a.command })} items={items} /> : undefined}
    />
  );
}

function Body({ view, now }: { view: CoordinatorView; now: number }) {
  const next = view.on && view.next_check_at !== null ? t("coordinator.next", { time: relativeTime(view.next_check_at, now) }) : null;
  return (
    <ul aria-label={t("coordinator.label")} className="divide-y divide-border rounded-box border border-border">
      <ListRow
        data-coordinator-status
        leading={<Switch checked={view.on} readOnly onCheckedChange={() => undefined} aria-label={t("coordinator.switch")} />}
        title={<span className={ROW_TITLE}>{activityText(view)}</span>}
        details={<>
          <span>{t("coordinator.every")}</span>
          {next !== null && <span title={localDateTime(view.next_check_at ?? "")}>{next}</span>}
          <span>{t("coordinator.setting")}</span>
        </>}
      />
      {view.actions.map((a) => <ActionRow key={`${a.cycle_id}:${a.seq}`} a={a} now={now} />)}
    </ul>
  );
}

/** The Coordinator card: its switch, current activity, next check and recent actions. */
export function CoordinatorCard() {
  const now = useNow();
  const q = useCoordinator();
  return (
    <Card title={t("coordinator.title")} label={t("coordinator.label")}>
      {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={2} label="loading.coordinator" onRetry={() => void q.refetch()} /> : (
        <>
          <Body view={q.data} now={now} />
          {q.data.actions.length === 0 && <EmptyState title={t("coordinator.noActions")} />}
        </>
      )}
    </Card>
  );
}

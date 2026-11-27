import { useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { useApi } from "../api/client.js";
import { type CoordinatorAction, type CoordinatorView, useCoordinator } from "../api/coordinator.js";
import type { Session } from "../api/overview.js";
import { API } from "../api/routes.js";
import { Badge } from "../components/ui/badge.js";
import { Card } from "../components/ui/card.js";
import { copyToClipboard } from "../components/ui/copy.js";
import { announceStatus } from "../components/ui/dialog.js";
import { ROW_TITLE, ListRow } from "../components/ui/list-row.js";
import { type MenuItem, OverflowMenu } from "../components/ui/menu.js";
import { EmptyState } from "../components/ui/notice.js";
import { ErrorNote, LIST_BOX, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { localDateTime, relativeTime } from "../lib/format.js";
import { useNow } from "./common.js";
import { Outcome, useWrite } from "./settings-file-keys.js";

// The Coordinator card of the Work page (design 09-dashboard-system): above the work list, the coordinator's switch
// (one press sets the `coordinator` setting through POST /api/v1/settings, the Settings page's write, postSettings; the
// server checks the owner, and a refusal shows under the card), what it does now, when its next check is due (every
// 15 minutes) and its recent actions, newest first. One read: GET /api/v1/coordinator, the `coordinator.status`
// capability, read again after a write. Built from Card, ListRow, Switch, Badge and EmptyState; each action's menu holds
// its transcript.

const outcomeText = (o: string): string => {
  switch (o) {
    case "requested": return t("coordinator.outcome.requested");
    case "refused": return t("coordinator.outcome.refused");
    case "skipped": return t("coordinator.outcome.skipped");
    case "failed": return t("coordinator.outcome.failed");
    default: return o;
  }
};

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

function Body({ view, now, busy, onSwitch }: { view: CoordinatorView; now: number; busy: boolean; onSwitch(next: boolean): Promise<void> }) {
  const next = view.on && view.next_check_at !== null ? t("coordinator.next", { time: relativeTime(view.next_check_at, now) }) : null;
  return (
    <ul aria-label={t("coordinator.label")} className={cn("divide-y divide-border", LIST_BOX)}>
      <ListRow
        data-coordinator-status
        leading={<Switch checked={view.on} disabled={busy} onCheckedChange={(next) => void onSwitch(next)} aria-label={t("coordinator.switch")} />}
        title={<span className={ROW_TITLE}>{activityText(view)}</span>}
        details={<>
          <span>{t("coordinator.every")}</span>
          {next !== null && <span title={localDateTime(view.next_check_at ?? "")}>{next}</span>}
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
  const client = useQueryClient();
  // The token from the session read; a missing or stale one is refreshed and retried once by postJson.
  const token = useApi<Session>(API.session, false).data?.csrf_token ?? "";
  const { busy, error, write } = useWrite(token);
  // The switch shows the stored value only: it moves when the read after a successful write says so.
  const onSwitch = async (next: boolean) => {
    if (await write({ action: "set", key: "coordinator", value: String(next) })) await client.invalidateQueries({ queryKey: ["/api/v1/coordinator"] });
  };
  return (
    <Card title={t("coordinator.title")} label={t("coordinator.label")}>
      {q.isError ? <ErrorNote error={q.error} /> : !q.data ? <Loading rows={2} label="loading.coordinator" onRetry={() => void q.refetch()} /> : (
        <>
          <Body view={q.data} now={now} busy={busy} onSwitch={onSwitch} />
          <Outcome error={error} done={null} />
          {q.data.actions.length === 0 && <EmptyState title={t("coordinator.noActions")} />}
        </>
      )}
    </Card>
  );
}

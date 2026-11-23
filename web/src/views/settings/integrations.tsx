import { useState } from "react";
import { API, type RulesView, type SettingsView, useApi } from "../../api.js";
import { Dialog } from "../../components/ui/dialog.js";
import { Notice } from "../../components/ui/notice.js";
import { Loading } from "../../components/ui/parts.js";
import { Switch } from "../../components/ui/switch.js";
import { t } from "../../i18n/index.js";
import { Outcome, useWrite } from "../settings-file-keys.js";
import { CalendarSection } from "../settings-calendar.js";
import { asObject } from "./values.js";
import { Card } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { AgentsHomePicker } from "../agents-home-picker.js";

/**
 * Turning the tacit ledger on: the Rules page's agents home picker and check over what GET /api/v1/rules says (read once
 * when the dialog opens). Turn on posts that read's `turn_on` with the settings token, and is off while the home in use
 * is missing or the viewer is not the owner (the same reason as on Rules); a refusal stays in the dialog.
 */
function TurnOnDialog({ name, busy, error, onTurnOn, onClose }: { name: string; busy: boolean; error: string | null; onTurnOn: (value: string) => void; onClose: () => void }) {
  const rules = useApi<RulesView>(API.rules, false);
  const v = rules.data;
  return (
    <Dialog
      title={t("settings.turnOnTitle", { name })}
      consequence={t("settings.turnOnConsequence")}
      confirmLabel={t("settings.turnOn")}
      confirmDisabled={busy || !v || v.turn_on === null}
      error={error ?? (rules.isError ? (rules.error instanceof Error ? rules.error.message : String(rules.error)) : null)}
      onConfirm={() => v?.turn_on != null && onTurnOn(v.turn_on)}
      onClose={onClose}
    >
      {!v ? !rules.isError && <Loading rows={2} label="loading.rules" onRetry={() => void rules.refetch()} /> : (
        <>
          {v.home !== null && <AgentsHomePicker home={v.home} />}
          {v.judge !== null && <Notice tone="warn">{v.judge}</Notice>}
        </>
      )}
    </Dialog>
  );
}

/** Each integration's state; the Switch turns an `integrations` entry off at once, and the tacit ledger on through a dialog. */
function IntegrationsSection({ view }: { view: SettingsView }) {
  const { busy, error, done, write } = useWrite(view.csrf_token);
  const [turningOn, setTurningOn] = useState<string | null>(null);
  const row = view.keys.find((k) => k.key === "integrations");
  const integrations = view.integrations ?? [];
  if (!row || integrations.length === 0) return null;
  const back = (kind: string) => {
    const rest = { ...(asObject(row.value) ?? {}) };
    delete rest[kind];
    void write(Object.keys(rest).length === 0 ? { action: "reset", key: row.key } : { action: "set", key: row.key, value: JSON.stringify(rest) });
  };
  return (
    <Card title={t("settings.integrations")} count={integrations.length}>
      <ul className="space-y-2 text-sm">
        {integrations.map((i) => {
          const on = i.plugin !== "none";
          return (
            <li key={i.kind} data-integration={i.kind} className="flex flex-wrap items-center gap-2">
              <Switch aria-label={t("settings.integrationLabel", { name: i.interface })} checked={on} disabled={busy || (on && i.source !== "setting")} onCheckedChange={() => (on ? back(i.kind) : setTurningOn(i.interface))} />
              <span className="font-medium">{i.interface}</span>
              <Badge level={on ? "needs_approval" : undefined}>{on ? i.plugin : t("settings.integrationOff")}</Badge>
              <span className="text-xs text-pretty text-text-2">{i.source === "setting" ? t("settings.integrationFromDashboard") : t("settings.integrationFromConfig")}</span>
            </li>
          );
        })}
      </ul>
      <Outcome error={error} done={done} />
      {turningOn !== null && (
        <TurnOnDialog
          name={turningOn}
          busy={busy}
          error={error}
          onTurnOn={(value) => void write({ action: "set", key: row.key, value }).then((ok) => ok && setTurningOn(null))}
          onClose={() => setTurningOn(null)}
        />
      )}
    </Card>
  );
}

/** The Integrations tab: the integrations and Calendar. */
export function IntegrationsTab({ view }: { view: SettingsView }) {
  return (
    <div>
      <IntegrationsSection view={view} />
      <CalendarSection token={view.csrf_token} />
    </div>
  );
}

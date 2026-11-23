import { useId, useState } from "react";
import { API, type RulesView, type SettingsView, useApi } from "../../api.js";
import { Dialog } from "../../components/ui/dialog.js";
import { Notice } from "../../components/ui/notice.js";
import { Loading } from "../../components/ui/parts.js";
import { Tooltip } from "../../components/ui/menu.js";
import { Switch } from "../../components/ui/switch.js";
import { t } from "../../i18n/index.js";
import { Outcome, useWrite } from "../settings-file-keys.js";
import { CalendarSection } from "../settings-calendar.js";
import { asObject } from "./values.js";
import { Card } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { AgentsHomePicker } from "../agents-home-picker.js";
import { cn } from "../../lib/cn.js";
import { SETTINGS_ROW, SETTINGS_ROWS } from "./rows.js";

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

/** The eval source plugin the Switch turns on (src/impl/eval-source/agents-home.plugin.ts). */
const EVAL_SOURCE = "agents-home";

/** Turning the eval source on: names the plugin; Turn on sets the entry's `eval_source` to it. A refusal stays in the dialog. */
function EvalSourceDialog({ name, busy, error, onTurnOn, onClose }: { name: string; busy: boolean; error: string | null; onTurnOn: () => void; onClose: () => void }) {
  return (
    <Dialog
      title={t("settings.turnOnTitle", { name })}
      consequence={t("settings.turnOnConsequence")}
      confirmLabel={t("settings.turnOn")}
      confirmDisabled={busy}
      error={error}
      onConfirm={onTurnOn}
      onClose={onClose}
    >
      <p className="text-sm text-pretty">{t("settings.evalSourceTurnOn", { plugin: EVAL_SOURCE })}</p>
    </Dialog>
  );
}

/** A small padlock; the row text carries the meaning. */
function Lock() {
  return (
    <svg aria-hidden data-testid="integration-lock" focusable="false" viewBox="0 0 16 16" className="size-3.5 shrink-0 text-text-3" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
  );
}

/**
 * An integration's switch. One set in the config file is read-only (same colour as any on switch), with a lock, and a
 * tooltip and description that say where to change it (`plugins.<kind>`).
 */
function IntegrationSwitch({ kind, name, on, readOnly, busy, onChange }: { kind: string; name: string; on: boolean; readOnly: boolean; busy: boolean; onChange: () => void }) {
  const descId = useId();
  const sw = <Switch aria-label={t("settings.integrationLabel", { name })} checked={on} readOnly={readOnly} disabled={busy} onCheckedChange={onChange} aria-describedby={readOnly ? descId : undefined} />;
  if (!readOnly) return sw;
  const hint = t("settings.integrationConfigKey", { kind });
  return (
    <Tooltip text={hint} placement="bottom" align="start" className="items-center gap-1">
      {sw}
      <Lock />
      <span id={descId} className="sr-only">{hint}</span>
    </Tooltip>
  );
}

/**
 * Each integration's state; the Switch turns an `integrations` entry off at once, the tacit ledger on through its
 * dialog, and the eval source on through its own (the entry's `eval_source` set to agents-home).
 */
function IntegrationsSection({ view }: { view: SettingsView }) {
  const { busy, error, done, write } = useWrite(view.csrf_token);
  const [turningOn, setTurningOn] = useState<{ kind: string; name: string } | null>(null);
  const row = view.keys.find((k) => k.key === "integrations");
  const integrations = view.integrations ?? [];
  if (!row || integrations.length === 0) return null;
  const entry = () => ({ ...(asObject(row.value) ?? {}) });
  const back = (kind: string) => {
    const rest = entry();
    delete rest[kind];
    void write(Object.keys(rest).length === 0 ? { action: "reset", key: row.key } : { action: "set", key: row.key, value: JSON.stringify(rest) });
  };
  const turnOn = (value: string) => void write({ action: "set", key: row.key, value }).then((ok) => ok && setTurningOn(null));
  return (
    <Card title={t("settings.integrations")} count={integrations.length}>
      <ul className={SETTINGS_ROWS}>
        {integrations.map((i) => {
          const on = i.plugin !== "none";
          return (
            <li key={i.kind} data-integration={i.kind} className={cn(SETTINGS_ROW, "flex flex-wrap items-center gap-2")}>
              <IntegrationSwitch kind={i.kind} name={i.interface} on={on} readOnly={on && i.source !== "setting"} busy={busy} onChange={() => (on ? back(i.kind) : setTurningOn({ kind: i.kind, name: i.interface }))} />
              <span className="font-medium">{i.interface}</span>
              <Badge level={on ? "needs_approval" : undefined}>{on ? i.plugin : t("settings.integrationOff")}</Badge>
              <span className="text-xs text-pretty text-text-2">{i.source === "setting" ? t("settings.integrationFromDashboard") : t("settings.integrationFromConfig")}</span>
            </li>
          );
        })}
      </ul>
      <Outcome error={error} done={done} />
      {turningOn?.kind === "eval_source" ? (
        <EvalSourceDialog
          name={turningOn.name}
          busy={busy}
          error={error}
          onTurnOn={() => turnOn(JSON.stringify({ ...entry(), eval_source: EVAL_SOURCE }))}
          onClose={() => setTurningOn(null)}
        />
      ) : turningOn !== null && (
        <TurnOnDialog name={turningOn.name} busy={busy} error={error} onTurnOn={turnOn} onClose={() => setTurningOn(null)} />
      )}
    </Card>
  );
}

/** The Integrations tab: the integrations and Calendar, Cards 24px apart (Card's own gap). */
export function IntegrationsTab({ view }: { view: SettingsView }) {
  return (
    <div>
      <IntegrationsSection view={view} />
      <CalendarSection token={view.csrf_token} />
    </div>
  );
}

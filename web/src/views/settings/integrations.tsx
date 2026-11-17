import type { SettingsView } from "../../api.js";
import { Badge, Section } from "../../components/ui/parts.js";
import { Switch } from "../../components/ui/switch.js";
import { t } from "../../i18n/index.js";
import { Outcome, useWrite } from "../settings-file-keys.js";
import { CalendarSection } from "../settings-calendar.js";
import { asObject } from "./values.js";

/** Each integration's state; the Switch removes the `integrations` entry the dashboard stored (back to the config). */
function IntegrationsSection({ view }: { view: SettingsView }) {
  const { busy, error, done, write } = useWrite(view.csrf_token);
  const row = view.keys.find((k) => k.key === "integrations");
  const integrations = view.integrations ?? [];
  if (!row || integrations.length === 0) return null;
  const back = (kind: string) => {
    const rest = { ...(asObject(row.value) ?? {}) };
    delete rest[kind];
    void write(Object.keys(rest).length === 0 ? { action: "reset", key: row.key } : { action: "set", key: row.key, value: JSON.stringify(rest) });
  };
  return (
    <Section title={t("settings.integrations")} count={integrations.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">
        {t("settings.integrationsHint")}
      </p>
      <ul className="space-y-2 text-sm">
        {integrations.map((i) => {
          const on = i.plugin !== "none";
          return (
            <li key={i.kind} data-integration={i.kind} className="flex flex-wrap items-center gap-2">
              <Switch aria-label={t("settings.integrationLabel", { name: i.interface })} checked={on} disabled={busy || i.source !== "setting"} onCheckedChange={() => back(i.kind)} />
              <span className="font-medium">{i.interface}</span>
              <Badge level={on ? "needs_approval" : undefined}>{on ? i.plugin : t("settings.integrationOff")}</Badge>
              <span className="text-xs text-pretty text-text-2">{i.source === "setting" ? t("settings.integrationFromDashboard") : t("settings.integrationFromConfig")}</span>
            </li>
          );
        })}
      </ul>
      <Outcome error={error} done={done} />
    </Section>
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

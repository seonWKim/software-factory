import { useState } from "react";
import { API, type SettingsView, useApi } from "../api.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Tabs } from "../components/ui/tabs.js";
import { PageHeader, PageToolbar } from "../components/ui/notice.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { useUrlParam } from "../lib/url-param.js";
import { AdvancedTab, SettingsSearch } from "./settings/advanced.js";
import { GeneralTab } from "./settings/general.js";
import { IntegrationsTab } from "./settings/integrations.js";

// The Settings page (design §8 and §9, issue #236; three tabs since 2026-11-16, design 08-settings): the tab is the `tab`
// query parameter (General, Integrations, Advanced; General when it names none).
// - General: Mode (and the auto-merge tier) and Notices.
// - Integrations: the integrations and Calendar (settings-calendar.tsx), which connects and disconnects each calendar plugin.
// - Advanced: every settable key, the file keys, the PR-only keys, the audit history, Commands and the ignored overrides.
// A settable key's row reads its human label and description (lib/key-label.ts, en.ts) with its value and an edit
// control; its key name, source, file value and when a change applies sit behind one Details toggle, and a reset shows
// when an override exists. Every key write is POST /api/v1/settings, which runs the same checks as `factory settings`; a
// refusal is shown next to the field it came from. A per-project gate key also shows the configured project's learned
// value (design 08-settings) next to its file and override values, with its evidence runs, its set time and a reset
// that runs the same check as `factory settings reset --learned`. The owner notices' two keys (design 09-notifications)
// are edited in their own Notices section: a switch per kind and a quiet-hours field. Integrations (design 08-settings,
// 2026-11-12) lists each integration with the plugin in force; its Switch removes the dashboard's choice, so
// factory.config.json decides again. The file-only keys have their own typed form (settings-file-keys.tsx), saved on a
// local branch the owner merges; the PR-only table keeps the remaining keys. The project label control above the
// settable keys stores the configured repo's project label (design 08-settings, 2026-11-16), which every per-project
// value is found by. Pending proposals, Standing approvals and the Providers table moved to the Rules page (Approvals)
// and the Plugins page (Models tab).

type SettingsTab = "general" | "integrations" | "advanced";
const TABS: readonly { id: SettingsTab; label: MessageKey }[] = [
  { id: "general", label: "settings.tabGeneral" },
  { id: "integrations", label: "settings.tabIntegrations" },
  { id: "advanced", label: "settings.tabAdvanced" },
];

/** The selected tab: the `tab` query parameter, General when it names no tab. */
function useTabParam(): [SettingsTab, (tab: SettingsTab) => void] {
  const [tab, choose] = useUrlParam("tab", (v) => TABS.some((x) => x.id === v));
  return [(tab ?? "general") as SettingsTab, choose];
}

export function SettingsPage() {
  const settings = useApi<SettingsView>(API.settings);
  const [tab, setTab] = useTabParam();
  // The Advanced tab's search, in the toolbar's second row while that tab is open.
  const [query, setQuery] = useState("");
  if (settings.isError) return <><PageHeader title={t("page.settings")} width="read" /><ErrorNote error={settings.error} /></>;
  if (!settings.data) return <><PageHeader title={t("page.settings")} width="read" /><Loading rows={8} /></>;
  const v = settings.data;
  return (
    <>
      <PageHeader title={t("page.settings")} width="read" />
      <PageToolbar tabs={<Tabs label={t("settings.tabs")} options={TABS.map((x) => ({ id: x.id, label: t(x.label) }))} value={tab} onChange={setTab} />}>
        {tab === "advanced" && <SettingsSearch value={query} onChange={setQuery} />}
      </PageToolbar>
      {tab === "general" && <GeneralTab view={v} />}
      {tab === "integrations" && <IntegrationsTab view={v} />}
      {tab === "advanced" && <AdvancedTab view={v} query={query} />}
    </>
  );
}

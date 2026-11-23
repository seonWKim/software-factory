import { API, type CapabilitiesView, type CapabilityRow, useApi } from "../api.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { t } from "../i18n/index.js";
import { When, useNow } from "./common.js";
import { Card } from "../components/ui/card.js";
import { Badge } from "../components/ui/badge.js";

// The Plugins page's Models tab (design 09-dashboard-app, 2026-11-16; it was the Settings page's Providers section,
// design 08-settings 2026-11-15): each provider entry of the capability list (a registered agent runner or LLM
// provider, one per configured endpoint) with whether config selects it, its model per class, the roles it serves and
// when a stored run last used it. Read once when the tab opens, never polled.

/** The name, then the provider's endpoint and its model per class. */
function NameCell({ row }: { row: CapabilityRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs wrap-anywhere">{row.name}</span>
      {row.detail !== null && <span className="text-xs text-pretty wrap-anywhere text-text-2">{row.detail}</span>}
      {row.models && row.models.length > 0 && (
        <span className="font-mono text-xs wrap-anywhere text-text-2">{row.models.map((m) => t("settings.capModel", { class: m.class, model: m.model })).join(" · ")}</span>
      )}
    </div>
  );
}

export function ModelsTab() {
  const now = useNow();
  const q = useApi<CapabilitiesView>(API.capabilities, false);
  const title = t("plugins.tabModels");
  const rows = q.data?.capabilities.filter((c) => c.kind === "provider");
  const columns: Column<CapabilityRow>[] = [
    { key: "name", header: t("settings.capColName"), render: (r) => <NameCell row={r} /> },
    {
      key: "state",
      header: t("settings.capColState"),
      render: (r) => <Badge level={r.enabled ? "ready_to_merge" : undefined}>{r.enabled ? t("settings.capEnabled") : t("settings.capDisabled")}</Badge>,
    },
    { key: "roles", header: t("settings.capColRoles"), render: (r) => <span className="text-xs text-pretty">{r.roles.length > 0 ? r.roles.join(", ") : t("settings.capNoRole")}</span> },
    {
      key: "last_used",
      header: t("settings.capColLastUsed"),
      render: (r) => <span className="text-xs tabular-nums whitespace-nowrap">{r.last_used ? <When at={r.last_used} now={now} /> : t("settings.capNever")}</span>,
    },
  ];
  return (
    <Card title={title} count={rows?.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">{t("plugins.modelsHint")}</p>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !rows ? (
        <Loading rows={3} label="loading.models" onRetry={() => void q.refetch()} />
      ) : (
        <DataTable label={title} columns={columns} rows={rows} rowKey={(r) => r.id} empty={t("settings.providersEmpty")} />
      )}
    </Card>
  );
}

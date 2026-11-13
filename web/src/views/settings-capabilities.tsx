import { API, type CapabilitiesView, type CapabilityRow, useApi } from "../api.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { StatusBadge } from "../components/ui/notice.js";
import { ErrorNote, Loading, Section } from "../components/ui/parts.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { useNow } from "./common.js";
import { withNodes } from "./standing.js";

// The Settings page's Capabilities section (design 08-settings, 2026-11-13): one list of the skills in the configured
// skill folders, the tool broker's tools and the provider entries, each with whether it is on, the roles that may use
// it and when a stored run last used it. Read only: a tool's roles change through the `tool_grants` setting in the
// settable keys table. Read once when the page opens (it reads stored transcripts), never polled.

const KIND: Record<CapabilityRow["kind"], MessageKey> = {
  skill: "settings.capKind.skill",
  tool: "settings.capKind.tool",
  provider: "settings.capKind.provider",
};

/** The name, then what it is: a skill's folder, a tool's description, a provider's endpoint and its model per class. */
function NameCell({ row }: { row: CapabilityRow }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-xs wrap-anywhere">{row.name}</span>
      {row.detail !== null && <span className="text-xs text-pretty wrap-anywhere text-text-2">{row.detail}</span>}
      {row.models && row.models.length > 0 && (
        <span className="font-mono text-xs wrap-anywhere text-text-2">{row.models.map((m) => t("settings.capModel", { class: m.class, model: m.model })).join(" · ")}</span>
      )}
    </div>
  );
}

export function CapabilitiesSection() {
  const now = useNow();
  const q = useApi<CapabilitiesView>(API.capabilities, false);
  const title = t("settings.capabilities");
  const columns: Column<CapabilityRow>[] = [
    { key: "name", header: t("settings.capColName"), render: (r) => <NameCell row={r} /> },
    { key: "kind", header: t("settings.capColKind"), render: (r) => <span className="whitespace-nowrap">{t(KIND[r.kind])}</span> },
    {
      key: "state",
      header: t("settings.capColState"),
      render: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <StatusBadge size="sm" level={r.enabled ? "ready_to_merge" : undefined}>{r.enabled ? t("settings.capEnabled") : t("settings.capDisabled")}</StatusBadge>
          {r.read_only === false && <span className="text-xs text-text-2">{t("settings.capWrites")}</span>}
        </span>
      ),
    },
    { key: "roles", header: t("settings.capColRoles"), render: (r) => <span className="text-xs text-pretty">{r.roles.length > 0 ? r.roles.join(", ") : t("settings.capNoRole")}</span> },
    {
      key: "last_used",
      header: t("settings.capColLastUsed"),
      render: (r) => <span className="text-xs tabular-nums whitespace-nowrap">{r.last_used ? t("time.ago", { time: ago(r.last_used, now) }) : t("settings.capNever")}</span>,
    },
  ];
  return (
    <Section title={title} count={q.data?.capabilities.length}>
      <p className="mb-2 text-sm text-pretty text-text-2">{withNodes("settings.capabilitiesHint", { key: <code>{"tool_grants"}</code> })}</p>
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading rows={3} />
      ) : (
        <DataTable label={title} columns={columns} rows={q.data.capabilities} rowKey={(r) => r.id} empty={t("settings.capabilitiesEmpty")} />
      )}
    </Section>
  );
}

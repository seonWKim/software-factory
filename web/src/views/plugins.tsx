import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { API, type McpStatus, type PluginsView, postPackApproval, useApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Input } from "../components/ui/input.js";
import { Notice, PageHeader, StatusBadge } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Tabs } from "../components/ui/tabs.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { useNow } from "./common.js";
import { withNodes } from "./standing.js";

// The Plugins page (design 09-dashboard-app, 2026-11-15): what the agents can use, in three tabs (MCP, Skills, Tools),
// read from GET /api/v1/plugins, the rows `factory plugins list` prints. "Plugins" here are agent capabilities, never
// the factory's implementation plugins. The selected tab is the `tab` query parameter. Each tab has a search box over
// name and description, and an empty state that says how to add one. An MCP server's Approve or Revoke is POST
// /api/v1/packs/approvals, the same path as `factory pack approve|revoke`. Read once when the page opens (it reads
// stored transcripts for "last used"), and again after an approval; never polled.

type Tab = "mcp" | "skills" | "tools";
const TABS: readonly { id: Tab; label: MessageKey }[] = [
  { id: "mcp", label: "plugins.tabMcp" },
  { id: "skills", label: "plugins.tabSkills" },
  { id: "tools", label: "plugins.tabTools" },
];

/** The `tab` query parameter, MCP when it names no tab. */
const urlTab = (): Tab => {
  const v = new URLSearchParams(location.search).get("tab");
  return TABS.some((x) => x.id === v) ? (v as Tab) : "mcp";
};

/** The selected tab, read from the URL on load and written to it (in place, no new history entry) on change. */
function useTabParam(): [Tab, (tab: Tab) => void] {
  const [tab, setTab] = useState(urlTab);
  const choose = (next: Tab) => {
    const url = new URL(location.href);
    url.searchParams.set("tab", next);
    history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    setTab(next);
  };
  return [tab, choose];
}

/** Rows whose name or description holds every word of the search, any case. */
function matching<Row extends { name: string; description: string | null }>(rows: readonly Row[], query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  return rows.filter((r) => {
    const text = `${r.name}\n${r.description ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/** A name in mono, with its description under it. */
function NameCell({ name, description }: { name: string; description: string | null }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="font-mono text-xs wrap-anywhere">{name}</span>
      {description && <span className="text-xs text-pretty wrap-anywhere text-text-2">{description}</span>}
    </div>
  );
}

const Roles = ({ roles }: { roles: readonly string[] }) => <span className="text-xs text-pretty">{roles.length > 0 ? roles.join(", ") : t("plugins.noRole")}</span>;

function LastUsed({ at, now }: { at: string | null; now: number }) {
  return <span className="text-xs tabular-nums whitespace-nowrap">{at ? t("time.ago", { time: ago(at, now) }) : t("plugins.never")}</span>;
}

const STATUS: Record<McpStatus, { label: MessageKey; level: string | undefined }> = {
  approved: { label: "plugins.statusApproved", level: "ready_to_merge" },
  waiting: { label: "plugins.statusWaiting", level: "needs_approval" },
  off: { label: "plugins.statusOff", level: undefined },
};

type McpRow = PluginsView["mcp"][number];

function McpTab({ view, query }: { view: PluginsView; query: string }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const token = view.csrf_token;
  const change = async (row: McpRow) => {
    if (token === null) return;
    const action = row.status === "approved" ? "revoke" : "approve";
    setBusy(row.name);
    setOutcome(null);
    const r = await postPackApproval(token, action, row.name);
    setBusy(null);
    setOutcome(r.ok ? { ok: true, text: r.line } : { ok: false, text: r.error });
    if (r.ok) await client.invalidateQueries({ queryKey: [API.plugins] });
  };
  const columns: Column<McpRow>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "source", header: t("plugins.colSource"), render: () => <span className="text-xs whitespace-nowrap">{t("plugins.sourcePack")}</span> },
    { key: "status", header: t("plugins.colStatus"), render: (r) => <StatusBadge size="sm" level={STATUS[r.status].level}>{t(STATUS[r.status].label)}</StatusBadge> },
    {
      key: "action",
      header: t("plugins.colAction"),
      render: (r) => (
        <Button
          size="sm"
          variant={r.status === "approved" ? "danger" : "secondary"}
          disabled={token === null || busy !== null}
          title={token === null ? t("plugins.approveFromCli", { name: r.name }) : undefined}
          onClick={() => void change(r)}
        >
          {r.status === "approved" ? t("plugins.revoke") : t("plugins.approve")}
        </Button>
      ),
    },
  ];
  return (
    <>
      {outcome && <Notice tone={outcome.ok ? "ok" : "bad"}>{outcome.text}</Notice>}
      {token === null && view.mcp.length > 0 && <p className="text-sm text-pretty text-text-2">{withNodes("plugins.cliOnly", { command: <code>{"factory pack approve mcp_server <name>"}</code> })}</p>}
      <DataTable label={t("plugins.tabMcp")} columns={columns} rows={matching(view.mcp, query)} rowKey={(r) => r.name} empty={empty(query, "plugins.emptyMcp", { command: <code>{"factory pack add <path>"}</code> })} />
    </>
  );
}

function SkillsTab({ view, query, now }: { view: PluginsView; query: string; now: number }) {
  type Row = PluginsView["skills"][number];
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "folder", header: t("plugins.colFolder"), render: (r) => <span className="font-mono text-xs wrap-anywhere">{r.folder}</span> },
    { key: "roles", header: t("plugins.colRoles"), render: (r) => <Roles roles={r.roles} /> },
    { key: "last_used", header: t("plugins.colLastUsed"), render: (r) => <LastUsed at={r.last_used} now={now} /> },
  ];
  return (
    <DataTable
      label={t("plugins.tabSkills")}
      columns={columns}
      rows={matching(view.skills, query)}
      rowKey={(r) => `${r.folder}\n${r.name}`}
      empty={empty(query, "plugins.emptySkills", { key: <code>{"capabilities.skill_folders"}</code> })}
    />
  );
}

function ToolsTab({ view, query, now }: { view: PluginsView; query: string; now: number }) {
  type Row = PluginsView["tools"][number];
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "origin", header: t("plugins.colOrigin"), render: (r) => <span className="text-xs whitespace-nowrap">{t(r.origin === "pack" ? "plugins.originPack" : "plugins.originBroker")}</span> },
    { key: "read_only", header: t("plugins.colReadOnly"), render: (r) => <span className="text-xs text-pretty">{r.read_only ? t("plugins.readOnly") : t("plugins.writes")}</span> },
    { key: "roles", header: t("plugins.colRoles"), render: (r) => <Roles roles={r.roles} /> },
    { key: "last_used", header: t("plugins.colLastUsed"), render: (r) => <LastUsed at={r.last_used} now={now} /> },
  ];
  return (
    <DataTable
      label={t("plugins.tabTools")}
      columns={columns}
      rows={matching(view.tools, query)}
      rowKey={(r) => r.name}
      empty={empty(query, "plugins.emptyTools", { command: <code>{"factory pack add <path>"}</code> })}
    />
  );
}

/** A search that matched nothing says so; an empty list says how to add one. */
function empty(query: string, how: MessageKey, nodes: Record<string, ReactNode>): ReactNode {
  return query.trim() !== "" ? t("plugins.noMatch", { query: query.trim() }) : withNodes(how, nodes);
}

export function PluginsPage() {
  const now = useNow();
  const [tab, setTab] = useTabParam();
  const [query, setQuery] = useState("");
  const q = useApi<PluginsView>(API.plugins, false);
  const choose = (next: Tab) => {
    setQuery("");
    setTab(next);
  };
  return (
    <>
      <PageHeader title={t("page.plugins")} description={t("plugins.intro")} />
      <div className="flex flex-col gap-3">
        <Tabs label={t("plugins.tabs")} options={TABS.map((x) => ({ id: x.id, label: t(x.label) }))} value={tab} onChange={choose} />
        <Input type="search" aria-label={t("plugins.search")} placeholder={t("plugins.search")} className="w-full sm:max-w-sm" value={query} onChange={(e) => setQuery(e.target.value)} />
        {q.isError ? (
          <ErrorNote error={q.error} />
        ) : !q.data ? (
          <Loading rows={3} />
        ) : tab === "mcp" ? (
          <McpTab view={q.data} query={query} />
        ) : tab === "skills" ? (
          <SkillsTab view={q.data} query={query} now={now} />
        ) : (
          <ToolsTab view={q.data} query={query} now={now} />
        )}
      </div>
    </>
  );
}

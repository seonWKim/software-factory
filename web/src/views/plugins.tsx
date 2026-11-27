import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useRef, useState } from "react";
import {
  API, type ImportItem, type ImportResult, type ItemDetail, type McpStatus, type PluginsView,
  getPluginsImport, postPackAdd, postPackApproval, postPluginsImport, postSettings, useApi,
} from "../api.js";
import { Clamp } from "../components/ui/clamp.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { CopyButton } from "../components/ui/copy.js";
import { Dialog, ModalPanel, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Tooltip } from "../components/ui/menu.js";
import { EMPTY_BOX, Notice, PageHeader, PageToolbar } from "../components/ui/notice.js";
import { cn } from "../lib/cn.js";
import { ErrorNote, Loading, type StoredFlags, useRefetchWhile } from "../components/ui/parts.js";
import { Tabs } from "../components/ui/tabs.js";
import { useUrlParam } from "../lib/url-param.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { When, useNow } from "./common.js";
import { ModelsTab } from "./plugins-models.js";
import { skillName } from "./evals.js";
import { EvalsCard } from "./plugins-evals.js";
import { MergeButton } from "./merge-button.js";
import { withNodes } from "./standing.js";
import { Badge } from "../components/ui/badge.js";
import { useEvalSuites } from "../api/evals.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Link } from "../nav.js";
import { BASE } from "../pages.js";
import { Card, SUB_TITLE } from "../components/ui/card.js";

// The Plugins page (design 09-dashboard-app, 2026-11-16): what the agents can use, in four tabs (MCP, Skills, Tools, Models),
// read from GET /api/v1/plugins, the rows `factory plugins list` prints. "Plugins" here are agent capabilities, never
// the factory's implementation plugins. The selected tab is the `tab` query parameter. Each tab has a search box over
// name and description, and Import and Add: above the list, or in the empty state when the tab has nothing.
// - Approve or Revoke, on every MCP server and pack tool row: POST /api/v1/packs/approvals, as `factory pack approve|revoke`.
// - Import (design 11-plugin-import): a dialog that lists, from GET /api/v1/plugins/import, the skills (Skills tab) or
//   MCP servers (MCP and Tools tabs: tools come from MCP servers) of the user-level Claude Code and Codex configs, each
//   with a checkbox; one already stored shows as imported and one a scan refuses shows its rules, neither selectable.
//   Import posts the checked ones to POST /api/v1/plugins/import, as `factory plugins import`. While it runs the confirm
//   button says "Importing…" and is off; then the dialog stays open and lists each item's result (stored, already
//   added, refused with its rules) until the owner closes it, and the stored rows show on the tab at once, marked New.
// - The Skills tab lists the skill folders' skills and the imported ones, each with its source (Folder, Claude Code,
//   Codex); an imported one shows its SKILL.md path and, when its file is missing or changed, that state. A row with a
//   SKILL.md path has Evals, which opens the Evals content (plugins-evals.tsx) for that path in a modal panel; closing it
//   returns focus to that row's button. The table has no Folder column: Path shows the SKILL.md path (else the folder) on
//   one line, cut in the middle, with the full value in a tooltip and a Copy button. Empty Roles and Last used show a
//   muted dash with a tooltip on this tab.
// - An action's notice (approve, revoke, add, import, skill folder edit) shows on the tab it came from, in plain words;
//   changing tab clears it and the New marks, and the next action replaces both.
// - Add on MCP and Tools: a pack folder or one descriptor file (`add`), as `factory pack add`. Add on Skills, and
//   Remove on a skill folder: the skill folder list (`capabilities.skill_folders`) through the config file writer
//   (POST /api/v1/settings `edit-file`), which puts the change on a local branch; the page shows that item's Merge button.
// - The Tools tab also lists the tools of each approved imported MCP server, origin MCP (design 11-plugin-import,
//   phase 3): the read asks a worker to list them, so they appear on a later read; the page starts no server.
// - The Models tab (plugins-models.tsx) lists the provider entries: each agent runner or model provider with its model
//   per class, the roles it serves and its last use, read from GET /api/v1/settings/capabilities. It has no search box,
//   Import or Add.
// Buttons are off when the server cannot write from the page. Read once when the page opens (it reads stored
// transcripts for "last used"), and again after a write; never polled.

/** The tabs that list rows of the plugins read; Models has its own read (plugins-models.tsx). */
type ListTab = "mcp" | "skills" | "tools";
type Tab = ListTab | "models";
const TABS: readonly { id: Tab; label: MessageKey }[] = [
  { id: "mcp", label: "plugins.tabMcp" },
  { id: "skills", label: "plugins.tabSkills" },
  { id: "tools", label: "plugins.tabTools" },
  { id: "models", label: "plugins.tabModels" },
];

/** The config file key of the skill folder list (src/ui/plugins-api.ts SKILL_FOLDERS_KEY). */
const SKILL_FOLDERS_KEY = "capabilities.skill_folders";

/** The selected tab: the `tab` query parameter, MCP when it names no tab. */
function useTabParam(): [Tab, (tab: Tab) => void] {
  const [tab, choose] = useUrlParam("tab", (v) => TABS.some((x) => x.id === v));
  return [(tab ?? "mcp") as Tab, choose];
}

/** Rows whose name or description holds every word of the search, any case. */
function matching<Row extends { name: string; description: string | null }>(rows: readonly Row[], query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter((w) => w !== "");
  return rows.filter((r) => {
    const text = `${r.name}\n${r.description ?? ""}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * What the last write said: its lines, for a skill folder edit the filed item and its branch, and for an import the
 * keys of the rows it stored (freshKey), which the tab marks New.
 */
interface Report {
  ok: boolean;
  lines: string[];
  filed?: { item: string; branch: string };
  fresh?: ReadonlySet<string>;
}
type Reporter = (r: Report) => void;

/** After a write: the outcome on the tab it came from, and the list read again. */
function useReporter(tab: Tab, setReport: (r: { tab: Tab; report: Report } | null) => void): Reporter {
  const client = useQueryClient();
  return (r) => {
    setReport({ tab, report: r });
    if (r.ok) void client.invalidateQueries({ queryKey: [API.plugins] });
  };
}

/** The key a stored import marks a row with: an MCP server by name, a skill by its source and name. */
const freshKey = (kind: ImportItem["kind"], name: string, source?: string): string => (kind === "skill" ? `skill\n${source ?? ""}\n${name}` : `mcp_server\n${name}`);

/** A name in mono, with its description under it; `fresh`: a row the last import stored, marked New. */
function NameCell({ name, description, fresh = false, href }: { name: string; description: string | null; fresh?: boolean; href?: string | undefined }) {
  return (
    <div data-new={fresh ? "" : undefined} className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
        {href === undefined ? <span className="text-xs wrap-anywhere">{name}</span> : <Link href={href} className={cn(LINK_CLASS, "text-xs wrap-anywhere")}>{name}</Link>}
        {fresh && <Badge level="running">{t("plugins.new")}</Badge>}
      </span>
      {description && <Clamp className="text-xs text-text-2">{description}</Clamp>}
    </div>
  );
}

/** An empty value as a muted dash that says why in its tooltip (and its accessible name). */
const EmptyDash = ({ why }: { why: string }) => (
  <Tooltip text={why}>
    <span tabIndex={0} aria-label={why} className="text-xs text-text-2">—</span>
  </Tooltip>
);

/** `dash`: an empty list is the muted dash, not a sentence (the Skills tab, where the columns stay narrow). */
const Roles = ({ roles, dash = false }: { roles: readonly string[]; dash?: boolean }) =>
  roles.length === 0 && dash ? <EmptyDash why={t("plugins.noRole")} /> : <span className="text-xs text-pretty">{roles.length > 0 ? roles.join(", ") : t("plugins.noRole")}</span>;

function LastUsed({ at, now, dash = false }: { at: string | null; now: number; dash?: boolean }) {
  if (!at && dash) return <EmptyDash why={t("plugins.never")} />;
  return <span className="text-xs tabular-nums whitespace-nowrap">{at ? <When at={at} now={now} /> : t("plugins.never")}</span>;
}

const PATH_KEEP = { head: 14, tail: 26 } as const;

/** A path cut in the middle when long; the full value in a tooltip, with a Copy button beside it. From `sm` up it is
 *  one line; below it (a card) the path wraps anywhere, so Copy stays inside the card. A screen reader (and the row's
 *  text) gets the full path; the cut text is for the eye only. */
function PathText({ value }: { value: string }) {
  const long = value.length > PATH_KEEP.head + PATH_KEEP.tail + 1;
  const shown = long ? `${value.slice(0, PATH_KEEP.head)}…${value.slice(-PATH_KEEP.tail)}` : value;
  return (
    <span className="flex min-w-0 items-start sm:items-center sm:whitespace-nowrap">
      <Tooltip text={value} align="start" className="min-w-0">
        <span tabIndex={0} className="min-w-0 font-mono text-xs break-all">
          {long ? <><span aria-hidden="true">{shown}</span><span className="sr-only">{value}</span></> : value}
        </span>
      </Tooltip>
      <CopyButton value={value} what={t("plugins.colPath")} />
    </span>
  );
}

const STATUS: Record<McpStatus, { label: MessageKey; level: string | undefined }> = {
  approved: { label: "plugins.statusApproved", level: "ready_to_merge" },
  waiting: { label: "plugins.statusWaiting", level: "needs_approval" },
  off: { label: "plugins.statusOff", level: undefined },
  missing: { label: "plugins.statusMissing", level: "stuck" },
};

const Status = ({ status }: { status: McpStatus }) => <Badge level={STATUS[status].level}>{t(STATUS[status].label)}</Badge>;

/** Approve, or Revoke once approved: one stored MCP server or pack tool. Off when the page cannot write. */
function ApproveButton({ token, kind, name, status, report }: { token: string | null; kind: "mcp_server" | "tool"; name: string; status: McpStatus; report: Reporter }) {
  const [busy, setBusy] = useState(false);
  const approved = status === "approved";
  const change = async () => {
    if (token === null) return;
    setBusy(true);
    const r = await postPackApproval(token, approved ? "revoke" : "approve", name, kind);
    setBusy(false);
    report(r.ok ? { ok: true, lines: [r.line] } : { ok: false, lines: [r.error] });
  };
  return (
    <Button size="sm" variant={approved ? "danger" : "secondary"} disabled={token === null || busy} title={token === null ? t("plugins.cannotWrite") : undefined} onClick={() => void change()}>
      {approved ? t("plugins.revoke") : t("plugins.approve")}
    </Button>
  );
}

/** A skill folder edit through the config file writer: the whole new list, on a new local branch. */
async function editFolders(token: string, folders: readonly string[], report: Reporter): Promise<string | null> {
  const r = await postSettings(token, { action: "edit-file", key: SKILL_FOLDERS_KEY, value: JSON.stringify(folders), confirm: false });
  if (!r.ok) return r.error;
  report({ ok: true, lines: r.lines, ...(r.filed ? { filed: r.filed } : {}) });
  return null;
}

/** The skill folder a picked path names: a folder as typed; for a skill file, the folder it is listed from. */
export function skillFolderOf(path: string): string {
  const p = path.trim().replace(/(.)\/+$/, "$1");
  if (!/\.md$/i.test(p) || !p.includes("/")) return p;
  const parent = p.slice(0, p.lastIndexOf("/")) || "/";
  // <folder>/<name>/SKILL.md is the skill <name> of <folder>; <folder>/<name>.md is listed from <folder> itself.
  return /\/SKILL\.md$/.test(p) && parent.includes("/") ? parent.slice(0, parent.lastIndexOf("/")) || "/" : parent;
}

/** Which dialog a tab's Import opens: the kind of item it lists and what importing does. */
const IMPORT_OF: Record<ListTab, { kind: ImportItem["kind"]; title: MessageKey; consequence: MessageKey }> = {
  mcp: { kind: "mcp_server", title: "plugins.importTitleMcp", consequence: "plugins.importConsequenceMcp" },
  skills: { kind: "skill", title: "plugins.importTitleSkills", consequence: "plugins.importConsequenceSkills" },
  tools: { kind: "mcp_server", title: "plugins.importTitleMcp", consequence: "plugins.importConsequenceTools" },
};

const SOURCE: Record<ImportItem["source"], MessageKey> = { claude: "plugins.sourceClaude", codex: "plugins.sourceCodex" };
const itemKey = (i: Pick<ImportItem, "kind" | "source" | "name">) => `${i.kind}\n${i.source}\n${i.name}`;

/** One import result in plain words: stored, already added, refused with its rules, or not found. */
function resultText(r: ImportResult): string {
  if (r.outcome === "stored") return t("plugins.resultStored");
  if (r.outcome === "already_added") return t("plugins.resultAlready");
  if (r.outcome === "refused") return t("plugins.resultRefused", { rules: r.rules.join(", ") });
  return t("plugins.resultNotFound");
}

/** The last Import's result per item, in the dialog until it closes. */
function ImportResults({ results }: { results: readonly ImportResult[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className={SUB_TITLE}>{t("plugins.importResults")}</h3>
      <ul aria-label={t("plugins.importResults")} className="flex flex-col gap-1">
        {results.map((r) => {
          const ok = r.outcome === "stored" || r.outcome === "already_added";
          return (
            <li key={itemKey(r)} data-import-result={r.outcome} className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-xs">
              <span className="wrap-anywhere">{r.name}</span>
              <span className="text-text-2">{t(SOURCE[r.source])}</span>
              <span className={ok ? "text-pretty" : "text-pretty wrap-anywhere text-pill-bad-fg"}>{resultText(r)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * The Import dialog: the found items of one kind, each with a checkbox; Import stores the checked ones. It stays open
 * after Import with each item's result, and reports the stored rows to the tab (marked New) and a summary notice.
 */
function ImportDialog({ tab, token, report, onClose }: { tab: ListTab; token: string; report: Reporter; onClose: () => void }) {
  const client = useQueryClient();
  const of = IMPORT_OF[tab];
  // Read each time the dialog opens: the configs can change between opens.
  const q = useQuery({ queryKey: [API.pluginsImport], queryFn: () => getPluginsImport(token), staleTime: 0, gcTime: 0 });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<readonly ImportResult[] | null>(null);
  const items = (q.data?.items ?? []).filter((i) => i.kind === of.kind);
  const toggle = (key: string) => {
    const next = new Set(checked);
    if (!next.delete(key)) next.add(key);
    setChecked(next);
  };
  const confirm = async () => {
    setBusy(true);
    setError(null);
    const r = await postPluginsImport(token, items.filter((i) => checked.has(itemKey(i))));
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setResults(r.results);
    setChecked(new Set());
    const stored = r.results.filter((x) => x.outcome === "stored");
    const failed = r.results.some((x) => x.outcome === "refused" || x.outcome === "not_found");
    const summary = t("plugins.importDone", { stored: stored.length, skipped: r.results.filter((x) => x.outcome === "already_added").length });
    report({ ok: !failed, lines: [summary], fresh: new Set(stored.map((x) => freshKey(x.kind, x.name, x.source))) });
    announceStatus(summary);
    await Promise.all([client.invalidateQueries({ queryKey: [API.plugins] }), q.refetch()]);
  };
  return (
    <Dialog
      title={t(of.title)}
      consequence={t(of.consequence)}
      confirmLabel={busy ? t("plugins.importing") : t("plugins.importConfirm", { count: checked.size })}
      confirmDisabled={busy || checked.size === 0}
      {...(results === null ? {} : { cancelLabel: t("plugins.close") })}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      {results && <ImportResults results={results} />}
      <p className="text-sm text-pretty text-text-2">{t("plugins.importIntro")}</p>
      {q.data?.errors.map((e) => (
        <Notice key={e.source} tone="warn">
          {e.message}
        </Notice>
      ))}
      {q.isError ? (
        <ErrorNote error={q.error} />
      ) : !q.data ? (
        <Loading rows={2} label="loading.pluginsImport" onRetry={() => void q.refetch()} />
      ) : items.length === 0 ? (
        <p className="text-sm text-pretty">{t("plugins.importNone")}</p>
      ) : (
        <ul aria-label={t(of.title)} className="max-h-72 divide-y divide-border overflow-y-auto rounded-control border border-border">
          {items.map((i) => {
            const key = itemKey(i);
            const locked = i.imported || i.refused.length > 0;
            const on = i.imported || checked.has(key);
            return (
              <li key={key} data-import-item={i.name} className="flex items-start gap-3 px-3 py-2">
                <Checkbox
                  checked={on}
                  aria-label={t("plugins.importSelect", { name: i.name, source: t(SOURCE[i.source]) })}
                  disabled={busy || locked}
                  onChange={() => toggle(key)}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-xs wrap-anywhere">{i.name}</span>
                  <span className="text-xs text-pretty wrap-anywhere text-text-2">{i.path ?? t(SOURCE[i.source])}</span>
                  {i.env_keys.length > 0 && <span className="text-xs text-pretty wrap-anywhere text-text-2">{t("plugins.importEnvKeys", { keys: i.env_keys.join(", ") })}</span>}
                  {i.refused.length > 0 && <span className="text-xs text-pretty wrap-anywhere text-pill-bad-fg">{t("plugins.importRefused", { rules: i.refused.join(", ") })}</span>}
                </div>
                {i.imported && (
                  <Badge level="ready_to_merge">
                    {t("plugins.imported")}
                  </Badge>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}

/** Add: a path to a file or folder. On Skills it becomes a skill folder; on MCP and Tools it is a pack or one descriptor file. */
function AddDialog({ view, skills, report, onClose }: { view: PluginsView; skills: boolean; report: Reporter; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (path.trim() === "") return setError(t("plugins.pathEmpty"));
    setBusy(true);
    setError(null);
    let failed: string | null = null;
    if (skills) {
      const folder = skillFolderOf(path);
      const folders = view.skill_folders ?? [];
      failed = folders.includes(folder) ? t("plugins.folderListed", { folder }) : await editFolders(view.settings_token!, [...folders, folder], report);
    } else {
      const r = await postPackAdd(view.csrf_token!, path.trim());
      if (r.ok) report({ ok: !r.refused, lines: r.lines });
      else failed = r.error;
    }
    setBusy(false);
    if (failed !== null) return setError(failed);
    onClose();
  };
  return (
    <Dialog
      title={t(skills ? "plugins.addSkillTitle" : "plugins.addTitle")}
      consequence={t(skills ? "plugins.addSkillConsequence" : "plugins.addConsequence")}
      confirmLabel={t("plugins.add")}
      confirmDisabled={busy}
      error={error}
      onConfirm={() => void confirm()}
      onClose={onClose}
    >
      <Field label={t("plugins.path")} htmlFor="plugins-add-path">
        <Input id="plugins-add-path" className="w-full font-mono" value={path} onChange={(e) => setPath(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** Import and Add for one tab, each opening its dialog. Off when the page cannot write what it would. */
function Actions({ view, tab, report }: { view: PluginsView; tab: ListTab; report: Reporter }) {
  const [open, setOpen] = useState<"import" | "add" | null>(null);
  const skills = tab === "skills";
  const canImport = view.csrf_token !== null;
  const canAdd = skills ? (view.settings_token ?? null) !== null : view.csrf_token !== null;
  const off = t("plugins.cannotWrite");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={!canImport} onClick={() => setOpen("import")}>{t("plugins.import")}</Button>
      <Button variant="secondary" disabled={!canAdd} title={canAdd ? undefined : off} onClick={() => setOpen("add")}>{t("plugins.add")}</Button>
      {!canImport && <div className="basis-full"><Notice tone="info">{t("plugins.importFromCli")}</Notice></div>}
      {open === "import" && view.csrf_token !== null && <ImportDialog tab={tab} token={view.csrf_token} report={report} onClose={() => setOpen(null)} />}
      {open === "add" && <AddDialog view={view} skills={skills} report={report} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * A tab's list: Import and Add above it, or, with nothing to list, in its empty state; a search that matched nothing
 * says so. Actions keeps one place in the tree either way, so an open Import dialog stays open when its import fills
 * an empty tab.
 */
function TabList<Row extends { name: string; description: string | null }>(
  { view, tab, report, query, rows, how, table }: { view: PluginsView; tab: ListTab; report: Reporter; query: string; rows: readonly Row[]; how: MessageKey; table: (rows: Row[], empty: ReactNode) => ReactNode },
) {
  const empty = rows.length === 0;
  return (
    <Card>
      <div data-tab-head className={empty ? cn(EMPTY_BOX, "gap-3") : "mb-4"}>
        {empty && <p className="text-sm text-pretty text-text-2">{t(how)}</p>}
        <Actions view={view} tab={tab} report={report} />
      </div>
      {!empty && table(matching(rows, query), t("plugins.noMatch", { query: query.trim() }))}
    </Card>
  );
}

type McpRow = PluginsView["mcp"][number];

/** The rows the last import on this tab stored (freshKey); none after a tab change or another action. */
type Fresh = ReadonlySet<string> | undefined;

function McpTab({ view, query, report, fresh }: { view: PluginsView; query: string; report: Reporter; fresh: Fresh }) {
  const columns: Column<McpRow>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} fresh={fresh?.has(freshKey("mcp_server", r.name)) ?? false} /> },
    { key: "source", header: t("plugins.colSource"), render: () => <span className="text-xs whitespace-nowrap">{t("plugins.sourcePack")}</span> },
    { key: "status", header: t("plugins.colStatus"), render: (r) => <Status status={r.status} /> },
    { key: "action", header: t("plugins.colAction"), render: (r) => <ApproveButton token={view.csrf_token} kind="mcp_server" name={r.name} status={r.status} report={report} /> },
  ];
  return (
    <TabList view={view} tab="mcp" report={report} query={query} rows={view.mcp} how="plugins.emptyMcp"
      table={(rows, empty) => <DataTable label={t("plugins.tabMcp")} columns={columns} rows={rows} rowKey={(r) => r.name} empty={empty} />} />
  );
}

/** The configured skill folders, each with Remove; an empty list when none is configured. */
function SkillFolders({ view, report }: { view: PluginsView; report: Reporter }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const folders = view.skill_folders ?? [];
  const token = view.settings_token ?? null;
  const remove = async (folder: string) => {
    if (token === null) return;
    setBusy(folder);
    setError(null);
    setError(await editFolders(token, folders.filter((f) => f !== folder), report));
    setBusy(null);
  };
  return (
    <Card title={t("plugins.skillFolders")}>
      <ul aria-label={t("plugins.skillFolders")} className="flex flex-col gap-1">
        {folders.map((f) => (
          <li key={f} className="flex min-w-0 items-center justify-between gap-2">
            <span className="min-w-0 font-mono text-xs wrap-anywhere">{f}</span>
            <Button size="sm" variant="danger" disabled={token === null || busy !== null} title={token === null ? t("plugins.cannotWrite") : undefined} aria-label={t("plugins.removeFolderLabel", { folder: f })} onClick={() => void remove(f)}>
              {t("plugins.removeFolder")}
            </Button>
          </li>
        ))}
      </ul>
      {folders.length === 0 && <p className="text-sm text-text-2">{t("plugins.noSkillFolder")}</p>}
      {error && <p role="alert" className="mt-2 text-xs text-pretty break-words text-pill-bad-fg">{error}</p>}
    </Card>
  );
}

/** An imported skill's state when it is not offered to agents: its file is missing or changed since import. */
const SKILL_STATE: Record<"missing" | "changed", MessageKey> = { missing: "plugins.stateMissing", changed: "plugins.stateChanged" };

function SkillsTab({ view, query, now, report, fresh }: { view: PluginsView; query: string; now: number; report: Reporter; fresh: Fresh }) {
  type Row = PluginsView["skills"][number];
  const suites = new Set(useEvalSuites().data?.skills ?? []);
  // The SKILL.md path whose Evals panel is open; none at first. `opener` is the row button that opened it, which gets focus back.
  const [evals, setEvals] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  /** The eval page of a row whose folder joined with its name is a suite's skill_ref. */
  const evalHref = (r: Row): string | undefined => {
    const key = `${r.folder}/${r.name}`;
    return suites.has(key) ? `${BASE}evals/${encodeURIComponent(key)}` : undefined;
  };
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} href={evalHref(r)} fresh={r.source !== undefined && (fresh?.has(freshKey("skill", r.name, r.source)) ?? false)} /> },
    { key: "source", header: t("plugins.colSource"), render: (r) => <span className="text-xs whitespace-nowrap">{t(r.source ? SOURCE[r.source] : "plugins.sourceFolder")}</span> },
    {
      key: "path",
      header: t("plugins.colPath"),
      render: (r) => (
        <div className="flex min-w-0 flex-col items-start gap-0.5">
          <PathText value={r.path ?? r.folder} />
          {(r.state === "missing" || r.state === "changed") && <Badge level="needs_you">{t(SKILL_STATE[r.state])}</Badge>}
        </div>
      ),
    },
    { key: "roles", header: t("plugins.colRoles"), render: (r) => <Roles roles={r.roles} dash /> },
    { key: "last_used", header: t("plugins.colLastUsed"), render: (r) => <LastUsed at={r.last_used} now={now} dash /> },
    {
      key: "evals",
      header: t("evals.open"),
      render: (r) => (
        <Button size="sm" disabled={r.path === undefined} title={r.path === undefined ? t("evals.noPath") : undefined} aria-label={t("evals.openLabel", { name: r.name })} data-capture-open="evals" onClick={(e) => {
          if (r.path === undefined) return;
          opener.current = e.currentTarget;
          setEvals(r.path);
        }}>
          {t("evals.open")}
        </Button>
      ),
    },
  ];
  return (
    <>
      <TabList view={view} tab="skills" report={report} query={query} rows={view.skills} how="plugins.emptySkills"
        table={(rows, empty) => <DataTable label={t("plugins.tabSkills")} columns={columns} rows={rows} rowKey={(r) => `${r.source ?? "folder"}\n${r.folder}\n${r.name}`} empty={empty} />} />
      {evals !== null && (
        <ModalPanel key={evals} title={t("evals.cardTitle", { name: skillName(evals) })} returnFocusTo={opener} onClose={() => setEvals(null)}>
          <EvalsCard path={evals} />
        </ModalPanel>
      )}
      <SkillFolders view={view} report={report} />
    </>
  );
}

/**
 * A tool row's origin label. `mcp`: a tool an approved imported MCP server listed (design 11-plugin-import, phase 3),
 * or that server's own row while it has none; its description names the server. No approve or revoke here.
 */
const ORIGIN: Record<string, MessageKey> = { broker: "plugins.originBroker", pack: "plugins.originPack", mcp: "plugins.tabMcp" };

function ToolsTab({ view, query, now, report }: { view: PluginsView; query: string; now: number; report: Reporter }) {
  type Row = PluginsView["tools"][number];
  const status = (r: Row): McpStatus | undefined => (r.origin === "pack" ? (view.tool_status?.[r.name] ?? "waiting") : undefined);
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "origin", header: t("plugins.colOrigin"), render: (r) => <span className="text-xs whitespace-nowrap">{t(ORIGIN[r.origin] ?? "plugins.originBroker")}</span> },
    { key: "read_only", header: t("plugins.colReadOnly"), render: (r) => <span className="text-xs text-pretty">{r.read_only ? t("plugins.readOnly") : t("plugins.writes")}</span> },
    { key: "roles", header: t("plugins.colRoles"), render: (r) => <Roles roles={r.roles} /> },
    { key: "last_used", header: t("plugins.colLastUsed"), render: (r) => <LastUsed at={r.last_used} now={now} /> },
    { key: "status", header: t("plugins.colStatus"), render: (r) => { const s = status(r); return s ? <Status status={s} /> : null; } },
    {
      key: "action",
      header: t("plugins.colAction"),
      render: (r) => { const s = status(r); return s ? <ApproveButton token={view.csrf_token} kind="tool" name={r.name.replace(/^pack:tool:/, "")} status={s} report={report} /> : null; },
    },
  ];
  return (
    <TabList view={view} tab="tools" report={report} query={query} rows={view.tools} how="plugins.emptyTools"
      table={(rows, empty) => <DataTable label={t("plugins.tabTools")} columns={columns} rows={rows} rowKey={(r) => r.name} empty={empty} />} />
  );
}

/** A skill folder edit's filed item: its branch and its Merge button (the item API's merge readiness; a local merge). */
function Filed({ item, branch }: { item: string; branch: string }) {
  const detail = useApi<ItemDetail>(API.item(item));
  const merge = detail.data?.item.merge ?? { enabled: false, reason: t("settings.file.checking") };
  return (
    <div data-filed={item} className="flex flex-wrap items-center gap-2 text-xs text-text-2">
      <span className="text-pretty break-words">{withNodes("settings.file.filed", { branch: <code className="font-mono">{branch}</code> })}</span>
      <MergeButton id={item} source="local" merge={merge} />
    </div>
  );
}

export function PluginsPage() {
  const now = useNow();
  const [tab, setTab] = useTabParam();
  const [query, setQuery] = useState("");
  // The last action's notice, with the tab it came from: shown only there, and cleared by a tab change.
  const [last, setLast] = useState<{ tab: Tab; report: Report } | null>(null);
  const report = useReporter(tab, setLast);
  const outcome = last?.tab === tab ? last.report : null;
  const fresh = outcome?.fresh;
  // The server answers from its stored listing (design 09-dashboard-settings, 2026-11-19): pending before the first
  // listing ends, failed with none good, refreshing while a newer one runs; the page reads again each second meanwhile.
  const q = useApi<PluginsView & StoredFlags>(API.plugins, false);
  useRefetchWhile(Boolean(q.data?.pending || q.data?.refreshing), q.refetch);
  const listed = q.data && !q.data.pending && !q.data.failed ? q.data : null;
  const choose = (next: Tab) => {
    setQuery("");
    setLast(null);
    setTab(next);
  };
  return (
    <>
      <PageHeader title={t("page.plugins")} description={t("plugins.intro")} />
      <PageToolbar tabs={<Tabs label={t("plugins.tabs")} options={TABS.map((x) => ({ id: x.id, label: t(x.label) }))} value={tab} onChange={choose} />}>
        {tab !== "models" && <Input type="search" aria-label={t("plugins.search")} placeholder={t("plugins.search")} className="w-full sm:max-w-sm" value={query} onChange={(e) => setQuery(e.target.value)} />}
      </PageToolbar>
      <div className="flex flex-col gap-3">
        {outcome && (
          <Notice tone={outcome.ok ? "ok" : "bad"}>
            {outcome.lines.map((l, i) => <span key={i} className="block break-words">{l}</span>)}
          </Notice>
        )}
        {outcome?.filed && <Filed item={outcome.filed.item} branch={outcome.filed.branch} />}
        {tab === "models" ? (
          <ModelsTab />
        ) : q.isError ? (
          <ErrorNote error={q.error} onRetry={() => void q.refetch()} />
        ) : q.data?.failed ? (
          <ErrorNote error={new Error(t("loading.listFailed", { label: t("loading.plugins") }))} onRetry={() => void q.refetch()} />
        ) : !listed ? (
          <Loading rows={3} label="loading.plugins" onRetry={() => void q.refetch()} />
        ) : (
          <>
            <p className="text-xs text-text-2"><When at={listed.as_of} now={now} label="plugins.asOf" /></p>
            {tab === "mcp" ? (
              <McpTab view={listed} query={query} report={report} fresh={fresh} />
            ) : tab === "skills" ? (
              <SkillsTab view={listed} query={query} now={now} report={report} fresh={fresh} />
            ) : (
              <ToolsTab view={listed} query={query} now={now} report={report} />
            )}
          </>
        )}
      </div>
    </>
  );
}

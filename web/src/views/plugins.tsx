import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import {
  API, type FoundPlugin, type ItemDetail, type McpStatus, type PluginsView,
  postPackApproval, postPackWrite, postPluginScan, postSettings, useApi,
} from "../api.js";
import { Button } from "../components/ui/button.js";
import { type Column, DataTable } from "../components/ui/data-table.js";
import { Dialog } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Notice, PageHeader, StatusBadge } from "../components/ui/notice.js";
import { ErrorNote, Loading } from "../components/ui/parts.js";
import { Switch } from "../components/ui/switch.js";
import { Tabs } from "../components/ui/tabs.js";
import { useUrlParam } from "../lib/url-param.js";
import type { MessageKey } from "../i18n/en.js";
import { t } from "../i18n/index.js";
import { ago } from "../lib/format.js";
import { useNow } from "./common.js";
import { MergeButton } from "./item-commands.js";
import { withNodes } from "./standing.js";

// The Plugins page (design 09-dashboard-app, 2026-11-16): what the agents can use, in three tabs (MCP, Skills, Tools),
// read from GET /api/v1/plugins, the rows `factory plugins list` prints. "Plugins" here are agent capabilities, never
// the factory's implementation plugins. The selected tab is the `tab` query parameter. Each tab has a search box over
// name and description, and Import and Add: above the list, or in the empty state when the tab has nothing.
// - Approve or Revoke, on every MCP server and pack tool row: POST /api/v1/packs/approvals, as `factory pack approve|revoke`.
// - Import: a dialog that scans the user-level Claude Code and Codex configs, lets the owner pick items, and imports
//   the picked ones (the same route, `scan` then `import`), as `factory plugins import`.
// - Add on MCP and Tools: a pack folder or one descriptor file (`add`), as `factory pack add`. Add on Skills, and
//   Remove on a skill folder: the skill folder list (`capabilities.skill_folders`) through the config file writer
//   (POST /api/v1/settings `edit-file`), which puts the change on a local branch; the page shows that item's Merge button.
// Buttons are off when the server cannot write from the page. Read once when the page opens (it reads stored
// transcripts for "last used"), and again after a write; never polled.

type Tab = "mcp" | "skills" | "tools";
const TABS: readonly { id: Tab; label: MessageKey }[] = [
  { id: "mcp", label: "plugins.tabMcp" },
  { id: "skills", label: "plugins.tabSkills" },
  { id: "tools", label: "plugins.tabTools" },
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

/** What the last write said: its lines, and for a skill folder edit the filed item and its branch. */
interface Report {
  ok: boolean;
  lines: string[];
  filed?: { item: string; branch: string };
}
type Reporter = (r: Report) => void;

/** After a write: the outcome, and the list read again. */
function useReporter(setReport: (r: Report | null) => void): Reporter {
  const client = useQueryClient();
  return (r) => {
    setReport(r);
    if (r.ok) void client.invalidateQueries({ queryKey: [API.plugins] });
  };
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

const Status = ({ status }: { status: McpStatus }) => <StatusBadge size="sm" level={STATUS[status].level}>{t(STATUS[status].label)}</StatusBadge>;

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

const pickKey = (f: FoundPlugin) => JSON.stringify([f.kind, f.source, f.name]);

/** Import: scans when it opens, lists what it found with a switch each (all on), and imports the picked ones. */
function ImportDialog({ token, report, onClose }: { token: string; report: Reporter; onClose: () => void }) {
  const [found, setFound] = useState<FoundPlugin[] | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [off, setOff] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void postPluginScan(token).then((r) => {
      if (!live) return;
      if (r.ok) {
        setFound(r.found);
        setErrors(r.errors);
      } else {
        setFound([]);
        setError(r.error);
      }
    });
    return () => {
      live = false;
    };
  }, [token]);
  const picked = (found ?? []).filter((f) => !off.has(pickKey(f)));
  const toggle = (f: FoundPlugin, on: boolean) => {
    const next = new Set(off);
    if (on) next.delete(pickKey(f));
    else next.add(pickKey(f));
    setOff(next);
  };
  const confirm = async () => {
    if (picked.length === 0) return setError(t("plugins.pickNone"));
    setBusy(true);
    setError(null);
    const r = await postPackWrite(token, { action: "import", items: picked });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    report({ ok: !r.refused, lines: r.lines });
    onClose();
  };
  return (
    <Dialog title={t("plugins.importTitle")} consequence={t("plugins.importConsequence")} confirmLabel={t("plugins.import")} confirmDisabled={busy || found === null || found.length === 0} error={error} onConfirm={() => void confirm()} onClose={onClose}>
      {found === null ? (
        <p role="status" className="text-sm text-text-2">{t("plugins.scanning")}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {errors.map((e) => <p key={e} role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{e}</p>)}
          {found.length === 0 && error === null && <p className="text-sm text-pretty text-text-2">{t("plugins.nothingFound")}</p>}
          {found.length > 0 && (
            <ul aria-label={t("plugins.importTitle")} className="flex max-h-72 flex-col gap-2 overflow-auto">
              {found.map((f) => {
                const kind = t(f.kind === "skill" ? "plugins.kindSkill" : "plugins.kindMcp");
                return (
                  <li key={pickKey(f)} className="flex min-w-0 items-center gap-2 text-xs">
                    <Switch checked={!off.has(pickKey(f))} onCheckedChange={(on) => toggle(f, on)} aria-label={t("plugins.pick", { kind, name: f.name, source: f.source })} />
                    <span className="min-w-0 font-mono wrap-anywhere">{f.name}</span>
                    <span className="text-text-2 whitespace-nowrap">{kind} · {f.source}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
      const r = await postPackWrite(view.csrf_token!, { action: "add", path: path.trim() });
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
function Actions({ view, tab, report }: { view: PluginsView; tab: Tab; report: Reporter }) {
  const [open, setOpen] = useState<"import" | "add" | null>(null);
  const skills = tab === "skills";
  const canImport = view.csrf_token !== null;
  const canAdd = skills ? (view.settings_token ?? null) !== null : view.csrf_token !== null;
  const off = t("plugins.cannotWrite");
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={!canImport} title={canImport ? undefined : off} onClick={() => setOpen("import")}>{t("plugins.import")}</Button>
      <Button variant="secondary" disabled={!canAdd} title={canAdd ? undefined : off} onClick={() => setOpen("add")}>{t("plugins.add")}</Button>
      {open === "import" && view.csrf_token !== null && <ImportDialog token={view.csrf_token} report={report} onClose={() => setOpen(null)} />}
      {open === "add" && <AddDialog view={view} skills={skills} report={report} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** A tab's list: Import and Add above it, or, with nothing to list, in its empty state; a search that matched nothing says so. */
function TabList<Row extends { name: string; description: string | null }>(
  { view, tab, report, query, rows, how, table }: { view: PluginsView; tab: Tab; report: Reporter; query: string; rows: readonly Row[]; how: MessageKey; table: (rows: Row[], empty: ReactNode) => ReactNode },
) {
  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-control border border-dashed border-border-strong px-4 py-6">
        <p className="text-sm text-pretty text-text-2">{t(how)}</p>
        <Actions view={view} tab={tab} report={report} />
      </div>
    );
  }
  return (
    <>
      <Actions view={view} tab={tab} report={report} />
      {table(matching(rows, query), t("plugins.noMatch", { query: query.trim() }))}
    </>
  );
}

type McpRow = PluginsView["mcp"][number];

function McpTab({ view, query, report }: { view: PluginsView; query: string; report: Reporter }) {
  const columns: Column<McpRow>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{t("plugins.skillFolders")}</h2>
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
      {folders.length === 0 && <p className="text-xs text-text-2">{t("plugins.noSkillFolder")}</p>}
      {error && <p role="alert" className="text-xs text-pretty break-words text-pill-bad-fg">{error}</p>}
    </section>
  );
}

function SkillsTab({ view, query, now, report }: { view: PluginsView; query: string; now: number; report: Reporter }) {
  type Row = PluginsView["skills"][number];
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "folder", header: t("plugins.colFolder"), render: (r) => <span className="font-mono text-xs wrap-anywhere">{r.folder}</span> },
    { key: "roles", header: t("plugins.colRoles"), render: (r) => <Roles roles={r.roles} /> },
    { key: "last_used", header: t("plugins.colLastUsed"), render: (r) => <LastUsed at={r.last_used} now={now} /> },
  ];
  return (
    <>
      <TabList view={view} tab="skills" report={report} query={query} rows={view.skills} how="plugins.emptySkills"
        table={(rows, empty) => <DataTable label={t("plugins.tabSkills")} columns={columns} rows={rows} rowKey={(r) => `${r.folder}\n${r.name}`} empty={empty} />} />
      <SkillFolders view={view} report={report} />
    </>
  );
}

function ToolsTab({ view, query, now, report }: { view: PluginsView; query: string; now: number; report: Reporter }) {
  type Row = PluginsView["tools"][number];
  const status = (r: Row): McpStatus | undefined => (r.origin === "pack" ? (view.tool_status?.[r.name] ?? "waiting") : undefined);
  const columns: Column<Row>[] = [
    { key: "name", header: t("plugins.colName"), render: (r) => <NameCell name={r.name} description={r.description} /> },
    { key: "origin", header: t("plugins.colOrigin"), render: (r) => <span className="text-xs whitespace-nowrap">{t(r.origin === "pack" ? "plugins.originPack" : "plugins.originBroker")}</span> },
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
  const [outcome, setOutcome] = useState<Report | null>(null);
  const report = useReporter(setOutcome);
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
        {outcome && (
          <Notice tone={outcome.ok ? "ok" : "bad"}>
            {outcome.lines.map((l, i) => <span key={i} className="block break-words">{l}</span>)}
          </Notice>
        )}
        {outcome?.filed && <Filed item={outcome.filed.item} branch={outcome.filed.branch} />}
        {q.isError ? (
          <ErrorNote error={q.error} />
        ) : !q.data ? (
          <Loading rows={3} />
        ) : tab === "mcp" ? (
          <McpTab view={q.data} query={query} report={report} />
        ) : tab === "skills" ? (
          <SkillsTab view={q.data} query={query} now={now} report={report} />
        ) : (
          <ToolsTab view={q.data} query={query} now={now} report={report} />
        )}
      </div>
    </>
  );
}

import { Fragment, useEffect, useId, useRef, useState } from "react";
import { API, type Session, type SettingRow, type SettingsView, type SettingsWrite, useApi } from "../../api.js";
import { Button } from "../../components/ui/button.js";
import { ButtonRow } from "../../components/ui/button-row.js";
import { DataTable } from "../../components/ui/data-table.js";
import { Field } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { LINK_CLASS } from "../../components/ui/link-style.js";
import { KeyValue } from "../../components/ui/key-value.js";
import { Table, Td, Tr } from "../../components/ui/parts.js";
import type { MessageKey } from "../../i18n/en.js";
import { t } from "../../i18n/index.js";
import { SETTINGS_INTRO } from "./rows.js";
import { duration } from "../../lib/format.js";
import { Link } from "../../nav.js";
import { BASE } from "../../pages.js";
import { keyHelp, keyLabel } from "../../lib/key-label.js";
import { When, useNow } from "../common.js";
import { FileKeysSection, KeyNameDetails, Outcome, editableKeys, useWrite } from "../settings-file-keys.js";
import { Description, SettingsRow } from "../settings-row.js";
import { withNodes } from "../standing.js";
import { Editor } from "./editor.js";
import { ADVANCED_GROUPS, appliesKey, groupOf, keyRank } from "./advanced-groups.js";
import { SHORT_OBJECT, asObject, entries, modelSummary, stringOf, summaryOf } from "./values.js";
import { Disclosure } from "../../components/ui/disclosure.js";
import { Card } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { EmptyState } from "../../components/ui/notice.js";

const PR_ONLY_TITLE = t("settings.prOnlyTitle");
const SOURCE_TONE: Record<string, string> = { override: "needs_approval", file: "", default: "" };

/**
 * A setting value: a JSON object as one `key → value` line per entry (behind a summary of its keys when it has more
 * than SHORT_OBJECT entries, so a long value never makes its row tall), anything else as its text.
 */
function JsonValue({ text }: { text: string }) {
  const obj = asObject(text);
  if (obj === null || Object.keys(obj).length === 0) return <span className="text-xs wrap-anywhere">{text}</span>;
  const list = <KeyValue data-entries items={entries(obj).map(([k, v]) => ({ key: k, term: k, value: v, code: true }))} className="gap-x-2" />;
  if (entries(obj).length <= SHORT_OBJECT) return list;
  return (
    <Disclosure summary={summaryOf(obj)}>
      <div className="mt-1">{list}</div>
    </Disclosure>
  );
}

/** The Reset button; its owner holds the write, so the outcome outlives the button (it unmounts once the key stops being an override). */
function ResetButton({ label, busy, onReset, learned = false }: { label: string; busy: boolean; onReset: () => void; learned?: boolean }) {
  return (
    <Button variant="secondary" disabled={busy} aria-label={t(learned ? "settings.resetLearnedLabel" : "settings.resetLabel", { label })} onClick={onReset}>
      {learned ? t("settings.resetLearned") : t("settings.reset")}
    </Button>
  );
}

/** A millisecond key's value as a duration with its unit ("1h 30m"), under its field; nothing for other keys. */
function Duration({ settingKey, value }: { settingKey: string; value: string }) {
  if (!settingKey.endsWith("_ms") || !/^\d+$/.test(value.trim())) return null;
  return <p data-duration className="mt-1 text-xs tabular-nums text-text-2">{duration(Number(value))}</p>;
}

/** A file value or default as text: a millisecond key as its duration ("30m"), a blank or empty-string value as "empty". */
function shownValue(settingKey: string, text: string): string {
  if (stringOf(text).trim() === "") return t("settings.empty");
  return settingKey.endsWith("_ms") && /^\d+$/.test(text.trim()) ? duration(Number(text)) : text;
}

/** A learned value as GET /api/v1/settings returns it; `source` is the layer in force for its project ("learned" while it is). */
interface LearnedValue {
  project: string;
  value: string;
  source: string;
  evidence_run_ids: string[];
  set_at: string;
}

/** The configured project's learned value of a key: in force or not, its evidence runs and when it was set, and its reset. */
function LearnedLayer({ row, learned, view }: { row: SettingRow; learned: LearnedValue; view: SettingsView }) {
  const now = useNow();
  const label = t("settings.keyFor", { key: keyLabel(row.key), project: view.repo });
  const runs = learned.evidence_run_ids;
  const { busy, error, done, write } = useWrite(view.csrf_token);
  // A learned reset is POST { ..., learned: true }: the server runs `factory settings reset --learned`.
  const reset = () => void write({ action: "reset", key: row.key, project: view.repo, learned: true } as SettingsWrite);
  return (
    <div data-learned className="mt-2 flex flex-wrap items-start gap-2">
      <div className="min-w-0 text-xs text-text-2">
        <p className="text-pretty">
          {t("settings.learned")} <span className="font-mono">{learned.value}</span>{" "}
          <Badge level={learned.source === "learned" ? "needs_approval" : undefined}>{learned.source === "learned" ? t("settings.inForce") : t("settings.ignoredTighter", { source: learned.source })}</Badge>{" "}
          <span className="tabular-nums"><When at={learned.set_at} now={now} label="settings.setAgo" /></span>
        </p>
        {runs.length > 0 && (
          <Disclosure summary={t(runs.length === 1 ? "settings.fromRunOne" : "settings.fromRunMany", { count: runs.length })}>
            <ul className="mt-1 font-mono break-all">
              {runs.map((id) => (
                <li key={id}>{id}</li>
              ))}
            </ul>
          </Disclosure>
        )}
      </div>
      <div>
        <ResetButton label={label} busy={busy} onReset={reset} learned />
        <Outcome error={error} done={done} />
      </div>
    </div>
  );
}

/** The keys a section of their own edits (Notices, Calendar); their table rows point there instead of a generic editor that does not fit. */
const SECTION_KEYS: Readonly<Record<string, MessageKey>> = { notice_kinds: "settings.editUnderNotices", quiet_hours: "settings.editUnderNotices", calendar: "settings.editUnderCalendar" };

/** One row's Details: the key name, where its value comes from, the file's value and when a change applies. */
function KeyDetails({ row }: { row: SettingRow }) {
  return (
    <Disclosure data-details data-raw summary={t("settings.details")}>
      <KeyValue
        className="mt-2"
        items={[
          { key: "key", term: t("settings.detailKey"), value: <span className="font-mono">{row.key}</span> },
          { key: "source", term: t("settings.colSource"), value: <Badge level={SOURCE_TONE[row.source] || undefined}>{row.source}</Badge> },
          {
            key: "file",
            term: t("settings.colFileValue"),
            value:
              row.file_value !== null ? (
                <JsonValue text={shownValue(row.key, row.file_value)} />
              ) : (
                <span className="text-text-3">{withNodes("settings.default", { value: <JsonValue text={shownValue(row.key, row.default_value)} /> })}</span>
              ),
          },
          { key: "applies", term: t("settings.colAppliesAt"), value: <span className="text-text-2">{t(appliesKey(row.applies_at))}</span> },
        ]}
      />
    </Disclosure>
  );
}

/** One group's keys as table rows: one shared settings row per key; the Value cell holds the editors, the per-project layer and the learned value. */
function KeyRows({ rows, view, resets }: { rows: readonly SettingRow[]; view: SettingsView; resets: boolean }) {
  return rows.map((row) => <KeyRow key={row.key} row={row} view={view} resets={resets} />);
}

/** One key's row. It holds the global and the per-project reset writes, so a reset's confirmation shows in the value cell after the Reset button is gone. */
function KeyRow({ row, view, resets }: { row: SettingRow; view: SettingsView; resets: boolean }) {
  const global = useWrite(view.csrf_token);
  const project = useWrite(view.csrf_token);
  return (
    <SettingsRow
      attrs={{ "data-key": row.key }}
      name={keyLabel(row.key)}
      description={keyHelp(row.key, row.description)}
      control={
        <>
          <ValueCell row={row} view={view} projectReset={project} />
          <Outcome error={global.error} done={global.done} />
        </>
      }
      details={<KeyDetails row={row} />}
      trailing={resets ? row.source === "override" && <ResetButton label={keyLabel(row.key)} busy={global.busy} onReset={() => void global.write({ action: "reset", key: row.key })} /> : undefined}
    />
  );
}

/**
 * The settable keys in groups (design 09-dashboard-settings): Retries, Limits, Models and Notices as rows of one table,
 * each group opened by a heading row, then For developers as a collapsed table of its own.
 */
function KeysTable({ view, query }: { view: SettingsView; query: string }) {
  if (view.keys.length === 0) return <EmptyState title={t("settings.noKeys")} />;
  // The Reset column shows only while some key has an override to reset.
  const resets = view.keys.some((row) => row.source === "override");
  const head = [t("settings.colKey"), t("settings.colValue"), t("settings.details"), ...(resets ? [t("settings.colReset")] : [])];
  // The search matches a key's name, its label and its help text; while it is on, For developers joins the table.
  const needle = query.trim().toLowerCase();
  const matches = (row: SettingRow) => needle === "" || [row.key, keyLabel(row.key), keyHelp(row.key, row.description)].some((s) => s.toLowerCase().includes(needle));
  const inGroup = (id: string) => view.keys.filter((row) => groupOf(row.key) === id && matches(row)).sort((a, b) => keyRank(a.key) - keyRank(b.key));
  const groups = ADVANCED_GROUPS.map((g) => ({ ...g, rows: inGroup(g.id) }));
  const developers = groups.find((g) => g.id === "developers")!;
  const shown = groups.filter((g) => (needle !== "" || g.id !== "developers") && g.rows.length > 0);
  return (
    <>
      {shown.length === 0 && <p data-no-match className="text-sm text-text-2">{t("settings.noMatch", { query: query.trim() })}</p>}
      {shown.length > 0 && <Table label={t("settings.settableKeys")} head={head}>
        {shown.map((g) => (
          <Fragment key={g.id}>
            <Tr data-group={g.id}>
              <Td className="bg-bg text-xs font-semibold text-text-2">{t(g.title)}</Td>
            </Tr>
            <KeyRows rows={g.rows} view={view} resets={resets} />
          </Fragment>
        ))}
      </Table>}
      {needle === "" && developers.rows.length > 0 && (
        <Disclosure data-group="developers" className="mt-3" summary={t(developers.title)}>
          <div className="mt-2">
            <Table label={t(developers.title)} head={head}>
              <KeyRows rows={developers.rows} view={view} resets={resets} />
            </Table>
          </div>
        </Disclosure>
      )}
    </>
  );
}

/** The model row's plain line: which class plans and which builds, and from which try the build moves up. */
function ModelSummary({ value }: { value: string }) {
  const text = modelSummary(value);
  return text === null ? null : <p data-model-summary className="mb-1 text-xs text-pretty text-text-2">{text}</p>;
}

function ValueCell({ row, view, projectReset }: { row: SettingRow; view: SettingsView; projectReset: ReturnType<typeof useWrite> }) {
  const own = view.project === null ? undefined : row.projects.find((p) => p.project === view.project);
  const learned = view.project === null ? undefined : ((row as SettingRow & { learned?: LearnedValue[] }).learned ?? []).find((l) => l.project === view.project);
  const label = keyLabel(row.key);
  const projectLabel = t("settings.keyFor", { key: label, project: view.repo });
  return (
    <>
      {row.key === "model_by" && <ModelSummary value={row.value} />}
      {SECTION_KEYS[row.key] ? (
        <p className="text-xs text-pretty text-text-2">
          <span data-raw className="font-mono wrap-anywhere">{row.value}</span> · {t(SECTION_KEYS[row.key]!)}
        </p>
      ) : (
        <Editor row={row} label={label} value={row.value} token={view.csrf_token} />
      )}
      <Duration settingKey={row.key} value={row.value} />
      {row.key === "workers" && row.max !== undefined && (
        <p className="mt-1 text-xs text-text-2">
          {withNodes(row.capped_at ? "settings.workersRangeCapped" : "settings.workersRange", { key: <code>{"max_workers"}</code> }, { max: row.max, capped: row.capped_at ?? "" })}
        </p>
      )}
      {row.project_settable && (
        <div className="mt-2 border-t border-border pt-2">
          <p className="mb-1 text-xs text-text-2">
            {t("settings.forValue", { value: own ? `${own.value} (${own.source})` : t("settings.globalValue") })}
            {view.project === null && ` · ${t("settings.noProjectLabel")}`}
          </p>
          <div className="flex flex-wrap items-start gap-2">
            <Editor row={row} label={projectLabel} value={own?.value ?? row.value} token={view.csrf_token} project={view.repo} />
            {own?.source === "override" && <ResetButton label={projectLabel} busy={projectReset.busy} onReset={() => void projectReset.write({ action: "reset", key: row.key, project: view.repo })} />}
          </div>
          <Outcome error={projectReset.error} done={projectReset.done} />
          <Duration settingKey={row.key} value={own?.value ?? row.value} />
          {learned && <LearnedLayer row={row} learned={learned} view={view} />}
        </div>
      )}
    </>
  );
}

/**
 * The configured repo's project label (design 08-settings): the stored label, an Input and Save. Save sends the
 * `project-label` write, which the server refuses when the label is empty, holds whitespace, does not end with
 * `/owner/name` of the repo, or no project key is stored; the refusal shows under the field.
 */
function ProjectLabel({ view }: { view: SettingsView }) {
  const { busy, error, done, write } = useWrite(view.csrf_token);
  const [draft, setDraft] = useState<string | null>(null);
  const id = useId();
  const shown = draft ?? view.project ?? "";
  const save = async () => {
    if (await write({ action: "project-label", value: shown })) setDraft(null);
  };
  return (
    <form data-project-label className="mb-3 flex max-w-xl flex-col items-start gap-2" onSubmit={(e) => (e.preventDefault(), void save())}>
      <Field label={t("settings.projectLabel")} htmlFor={id} help={t("settings.projectLabelHint", { repo: view.repo })} className="w-full">
        <Input id={id} aria-label={t("settings.projectLabelFor", { repo: view.repo })} className="w-full font-mono text-xs" value={shown} onChange={(e) => setDraft(e.target.value)} />
      </Field>
      <ButtonRow>
        <Button type="submit" variant="secondary" disabled={busy || draft === null} aria-label={t("settings.saveLabel", { label: t("settings.projectLabelFor", { repo: view.repo }) })}>
          {t("settings.save")}
        </Button>
      </ButtonRow>
      <Outcome error={error} done={done} />
    </form>
  );
}

/** Who the page's item commands act as (design 09): the item page's "Commands are off" notice links here (#page-commands). */
function PageCommands() {
  const session = useApi<Session>(API.session, false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (window.location.hash === "#page-commands") ref.current?.scrollIntoView();
  }, []);
  const s = session.data;
  return (
    <div id="page-commands" ref={ref}>
      <Card title={t("settings.commandsTitle")}>
        <p className="text-sm text-pretty text-text-2">
          {s?.actor ? (
            withNodes("settings.cmdActsAs", { actor: <code>{s.actor}</code> }, { source: t(s.actor_source === "config" ? "settings.sourceConfig" : "settings.sourceEnvironment") })
          ) : (
            t("settings.cmdOff")
          )}
        </p>
      </Card>
    </div>
  );
}

/**
 * The search over the settable keys (name, label, help text). A page filter, so Settings renders it in its PageToolbar's
 * second row while the Advanced tab is open and passes the text to AdvancedTab.
 */
export function SettingsSearch({ value, onChange }: { value: string; onChange: (query: string) => void }) {
  return <Input type="search" aria-label={t("settings.search")} placeholder={t("settings.search")} className="w-full sm:max-w-sm" value={value} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * The Advanced tab: the settable keys (narrowed by `query`, the toolbar's search), the file keys, the PR-only keys, the
 * history, Commands and the ignored overrides.
 */
export function AdvancedTab({ view: v, query }: { view: SettingsView; query: string }) {
  const now = useNow();
  // The keys the typed form edits leave the PR-only table; the remaining keys change only by a reviewed PR.
  const editable = editableKeys(v);
  const prOnly = v.pr_only.filter((p) => !editable.has(p.key));
  // A column of blocks at gap-6; `*:mt-0` drops each Card's own top margin here, so the gap is not doubled.
  return (
    <div className="flex flex-col gap-6 *:mt-0">
      <p className="text-sm text-text-2">
        {t("settings.devTools")}{" "}
        <Link href={`${BASE}data`} className={LINK_CLASS}>{t("page.data")}</Link>
      </p>
      <Card title={t("settings.settableKeys")} count={v.keys.length}>
        <p className={SETTINGS_INTRO}>{t("settings.settableIntro")}</p>
        <ProjectLabel view={v} />
        <KeysTable view={v} query={query} />
      </Card>
      <FileKeysSection view={v} />
      <Card title={PR_ONLY_TITLE} count={prOnly.length}>
        <p className={SETTINGS_INTRO}>
          {withNodes("settings.prOnlyIntro", { file: <code>{"factory.config.json"}</code> })}
        </p>
        <DataTable
          label={PR_ONLY_TITLE}
          columns={[
            {
              key: "key",
              header: t("settings.colKey"),
              render: (p: SettingsView["pr_only"][number]) => (
                <>
                  <span className="text-sm font-medium text-pretty">{keyLabel(p.key)}</span>
                  <Description text={p.description} />
                  <KeyNameDetails name={p.key} />
                </>
              ),
            },
          ]}
          rows={prOnly}
          rowKey={(p) => p.key}
          empty={t("settings.noKeys")}
          dataKey
        />
      </Card>
      <Card title={t("settings.history")} count={v.history.length}>
        <DataTable
          label={t("settings.history")}
          columns={[
            { key: "at", header: t("col.when"), className: "tabular-nums whitespace-nowrap", render: (c) => <When at={c.at} now={now} /> },
            { key: "actor", header: t("settings.colWho"), className: "font-mono text-xs" },
            { key: "key", header: t("settings.colKey"), className: "text-sm", render: (c) => `${keyLabel(c.key)}${c.project ? t("settings.forProject", { project: c.project }) : ""}` },
            {
              key: "change",
              header: t("settings.colChange"),
              className: "font-mono text-xs break-all",
              render: (c) => (c.new_value === null ? t("settings.resetWas", { old: String(c.old_value) }) : t("settings.changed", { old: c.old_value ?? t("settings.noOverride"), new: c.new_value })),
            },
          ]}
          rows={v.history}
          rowKey={(c) => String(c.seq)}
          empty={t("settings.noHistory")}
        />
      </Card>
      <PageCommands />
      {v.ignored.length > 0 && (
        <Card title={t("settings.ignoredOverrides")} count={v.ignored.length}>
          <ul className="space-y-1 text-sm">
            {v.ignored.map((i, n) => (
              <li key={n} className="text-pretty break-words">
                {keyLabel(i.key)}
                {i.project ? t("settings.forProject", { project: i.project }) : ""} = <code>{i.value}</code>: {i.reason}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

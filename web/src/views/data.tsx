import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { API, type DataAskResult, type DataAutonomy, type DataCell, type DataPageBody, type DataTableInfo, type DataTables, postDataAsk, useManualApi } from "../api.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Notice, PageHeader } from "../components/ui/notice.js";
import { Empty, ErrorNote, Loading, Section } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { Select } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// The Data page (design §9, issue #239): one Autonomy line (design §6), the Ask box, then every store table on the
// left with its row count, owner and one-line description, and one page of the chosen table's rows on the right,
// newest first, under the table's description and column meanings. The tables are read-only. It reads only when a
// table, page or filter is chosen and when the top bar's Refresh is pressed: no polling. Values arrive already
// withheld or hidden by the API; long values are cut here, not in the API, so "Show all" needs no second read. The
// Ask box (design 09-dashboard-app) shows only when the server has the Ask route: a question in plain words goes to
// POST /api/v1/data/ask, and its query is shown, then its result (and a one-line answer for one value).

/** Cells longer than this are cut on display. */
export const CELL_MAX = 300;

export function DataPage() {
  const tables = useManualApi<DataTables>(API.dataTables);
  const [table, setTable] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState<{ column: string; value: string } | null>(null);

  const choose = (name: string) => {
    setTable(name);
    setPage(1);
    setFilter(null);
  };

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader title={t("page.data")} />
      <AutonomyLine />
      {tables.data?.csrf_token ? <AskBox token={tables.data.csrf_token} /> : null}
      <div className="flex min-w-0 gap-4 max-md:flex-col">
        <nav aria-label={t("data.tables")} className="w-56 shrink-0 max-md:w-full">
          {tables.isError ? <ErrorNote error={tables.error} /> : !tables.data ? <Loading rows={6} /> : (
            <ul className="space-y-0.5 text-sm">
              {tables.data.tables.map((tb) => (
                <li key={tb.name}>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-pressed={tb.name === table}
                    onClick={() => choose(tb.name)}
                    className="w-full text-left"
                  >
                    <span className="min-w-0 truncate font-mono">{tb.name}</span>
                    <span className="ml-auto text-text-3 tabular-nums">{tb.rows}</span>
                  </Button>
                  <p className="truncate px-2 pb-1 text-xs text-text-3" title={tb.description ?? undefined} data-testid="data-table-doc">
                    {tb.owner ? `${tb.owner} · ` : ""}{tb.description ?? t("data.noDescription")}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="min-w-0 flex-1">
          {table === null ? (
            <Empty>{t("data.choose")}</Empty>
          ) : (
            <TableRows key={`${table}|${page}|${filter?.column ?? ""}|${filter?.value ?? ""}`} table={table} info={tables.data?.tables.find((x) => x.name === table) ?? null} page={page} setPage={setPage} filter={filter} setFilter={(f) => { setFilter(f); setPage(1); }} />
          )}
        </div>
      </div>
    </div>
  );
}

/** One line above the tables: merged factory items with no person's push, from /api/v1/data/autonomy. */
function AutonomyLine() {
  const q = useManualApi<DataAutonomy>(API.dataAutonomy);
  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={1} />;
  const a = q.data;
  return (
    <p className="text-sm" data-testid="data-autonomy">
      <span className="font-medium">{t("data.autonomy")}</span>{" "}
      {a.autonomy === null ? (
        <span className="text-text-3">{t("data.notEnough")}</span>
      ) : (
        <span className="tabular-nums">
          {a.autonomy.toFixed(2)}{" "}
          <span className="text-text-3">
            {t("data.autonomyDetail", { count: a.merged - a.with_push, merged: a.merged })}
          </span>
        </span>
      )}
    </p>
  );
}

function TableRows({
  table, info, page, setPage, filter, setFilter,
}: {
  table: string;
  info: DataTableInfo | null;
  page: number;
  setPage: (n: number) => void;
  filter: { column: string; value: string } | null;
  setFilter: (f: { column: string; value: string } | null) => void;
}) {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (filter) {
    params.set("col", filter.column);
    params.set("val", filter.value);
  }
  const q = useManualApi<DataPageBody>(API.dataTable(table, params));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [copied, setCopied] = useState<number | null>(null);

  if (q.isError) return <ErrorNote error={q.error} />;
  if (!q.data) return <Loading rows={8} />;
  const d = q.data;
  const pages = Math.max(1, Math.ceil(d.total / d.limit));
  const first = d.total === 0 ? 0 : (d.page - 1) * d.limit + 1;
  const last = Math.min(d.total, d.page * d.limit);
  const copy = (i: number, row: Record<string, DataCell>) => {
    // The values as the API gave them: hidden and withheld markers, never a raw value.
    void navigator.clipboard?.writeText(JSON.stringify(row, null, 2)).then(() => setCopied(i));
  };

  return (
    <section aria-label={t("data.table", { name: d.table })}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold">{d.table}</h2>
        <span className="text-sm text-text-3 tabular-nums" data-testid="data-range">
          {t("data.range", { first, last, total: d.total })}
        </span>
        <FilterForm columns={d.columns.filter((c) => !d.hidden.includes(c))} filter={filter} setFilter={setFilter} />
        <ButtonRow className="ml-auto">
          <Button size="sm" disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>
            {t("data.previous")}
          </Button>
          <span className="text-xs text-text-3 tabular-nums">
            {t("data.page", { page: d.page, pages })}
          </span>
          <Button size="sm" disabled={d.page >= pages} onClick={() => setPage(d.page + 1)}>
            {t("data.next")}
          </Button>
        </ButtonRow>
      </div>
      <TableInfo info={info} />
      {d.rows.length === 0 ? (
        <Empty>{filter ? t("data.noMatch") : t("data.empty")}</Empty>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-control border border-border">
          <table aria-label={d.table} className="text-left text-xs">
            <thead>
              <tr>
                <th scope="col" className="sticky top-0 z-10 bg-bg px-2 py-2">
                  <span className="sr-only">{t("data.copyColumn")}</span>
                </th>
                {d.columns.map((c) => (
                  <th key={c} scope="col" title={info?.column_docs?.[c]} className="sticky top-0 z-10 bg-bg px-2 py-2 font-mono font-medium whitespace-nowrap text-text-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {d.rows.map((row, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 align-top">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("data.copyRow")}
                      title={copied === i ? t("copy.done") : t("data.copyRow")}
                      onClick={() => copy(i, row)}
                      className="text-text-3"
                    >
                      <Copy aria-hidden className="size-3.5" />
                    </Button>
                  </td>
                  {d.columns.map((c) => {
                    const key = `${i}:${c}`;
                    return (
                      <td key={c} className="max-w-md px-2 py-1 align-top font-mono break-words whitespace-pre-wrap">
                        <CellView
                          value={row[c] ?? null}
                          runItems={d.run_items}
                          open={expanded.has(key)}
                          onOpen={() => setExpanded(new Set([...expanded, key]))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A table's card head: its one-line description, its owning component, and the meaning of the columns a line explains. */
function TableInfo({ info }: { info: DataTableInfo | null }) {
  const meanings = Object.entries(info?.column_docs ?? {});
  return (
    <div className="mb-2 space-y-1 text-sm" data-testid="data-table-info">
      <p>
        {info?.description ?? t("data.noDescription")}
        {info?.owner ? <span className="ml-2 text-text-3">{t("data.owner", { owner: info.owner })}</span> : null}
      </p>
      {meanings.length > 0 && (
        <dl aria-label={t("data.columnMeanings")} className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs max-sm:grid-cols-1">
          {meanings.map(([column, meaning]) => (
            <div key={column} className="contents">
              <dt className="font-mono text-text-2">{column}</dt>
              <dd className="text-text-3 max-sm:mb-1">{meaning}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

/**
 * The Ask box: one question in plain words (1 to 1000 characters). The answer shows the query first, then the result
 * table, with a one-line answer for one value; a refused query shows its reason under the query, and a message alone
 * (no model, a model error) shows where the result would be.
 */
function AskBox({ token }: { token: string }) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DataAskResult | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!question.trim() || busy) return;
    setBusy(true);
    try {
      setResult(await postDataAsk(token, question));
    } catch (err) {
      setResult({ ok: false, sql: null, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t("data.ask.title")}>
      <form onSubmit={(e) => void submit(e)} className="space-y-2">
        <Field label={t("data.ask.question")} htmlFor="data-ask-question" help={t("data.ask.help")}>
          <Textarea
            id="data-ask-question"
            rows={2}
            maxLength={1000}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={t("data.ask.placeholder")}
            className="w-full"
          />
        </Field>
        <ButtonRow>
          <Button type="submit" variant="primary" size="sm" disabled={busy || !question.trim()}>
            {busy ? t("data.ask.asking") : t("data.ask.submit")}
          </Button>
        </ButtonRow>
      </form>
      {result && <AskAnswer result={result} />}
    </Section>
  );
}

function AskAnswer({ result }: { result: DataAskResult }) {
  return (
    <div className="mt-3 min-w-0 space-y-2" data-testid="data-ask-answer">
      {result.sql !== null && (
        <div>
          <h3 className="text-xs font-medium text-text-2">{t("data.ask.query")}</h3>
          <pre className="mt-1 overflow-x-auto rounded-control border border-border bg-surface-2 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words" data-testid="data-ask-sql">
            {result.sql}
          </pre>
        </div>
      )}
      {!result.ok ? (
        result.sql !== null ? <Notice tone="warn" title={t("data.ask.refused")}>{result.error}</Notice> : <Notice tone="bad">{result.error}</Notice>
      ) : (
        <>
          {result.answer !== null && <p className="text-sm font-medium" data-testid="data-ask-line">{result.answer}</p>}
          {result.truncated && <Notice>{t("data.ask.truncated", { count: result.rows.length })}</Notice>}
          {result.rows.length === 0 ? <Empty>{t("data.ask.noRows")}</Empty> : <ResultTable columns={result.columns} rows={result.rows} />}
        </>
      )}
    </div>
  );
}

/** The Ask's result: its columns in order (two may share a name), each cell shown as on a table page. */
function ResultTable({ columns, rows }: { columns: string[]; rows: DataCell[][] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  return (
    <div className="max-h-[60vh] overflow-auto rounded-control border border-border">
      <table aria-label={t("data.ask.result")} className="text-left text-xs">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} scope="col" className="sticky top-0 z-10 bg-bg px-2 py-2 font-mono font-medium whitespace-nowrap text-text-2">{c}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, r) => (
            <tr key={r}>
              {columns.map((_, i) => (
                <td key={i} className="max-w-md px-2 py-1 align-top font-mono break-words whitespace-pre-wrap">
                  <CellView value={row[i] ?? null} runItems={{}} open={expanded.has(`${r}:${i}`)} onOpen={() => setExpanded(new Set([...expanded, `${r}:${i}`]))} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FilterForm({
  columns, filter, setFilter,
}: {
  columns: string[];
  filter: { column: string; value: string } | null;
  setFilter: (f: { column: string; value: string } | null) => void;
}) {
  const [column, setColumn] = useState(filter?.column ?? columns[0] ?? "");
  const [value, setValue] = useState(filter?.value ?? "");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (column) setFilter({ column, value });
  };
  return (
    <form role="search" aria-label={t("data.filterRows")} onSubmit={submit} className="flex flex-wrap items-center gap-2">
      <Select aria-label={t("data.filterColumn")} value={column} onChange={(e) => setColumn(e.target.value)} className="font-mono">
        {columns.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </Select>
      <Input aria-label={t("data.filterValue")} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t("data.equals")} className="w-40" />
      <ButtonRow>
        {filter && (
          <Button size="sm" onClick={() => setFilter(null)}>{t("data.clear")}</Button>
        )}
        <Button type="submit" size="sm">{t("data.filter")}</Button>
      </ButtonRow>
    </form>
  );
}

/** One cell: NULL muted, markers emphasised, item and run ids linked, long text cut with "Show all". */
function CellView({ value, runItems, open, onOpen }: { value: DataCell; runItems: Record<string, string>; open: boolean; onOpen: () => void }) {
  if (value === null) return <span className="text-text-3">{t("data.null")}</span>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  if (value === "[hidden]" || value.startsWith("[withheld: ")) return <em className="text-pill-warn-fg">{value}</em>;
  if (/^wi_[A-Za-z0-9]+$/.test(value)) return <Link href={itemPath(value)} className={LINK_CLASS}>{value}</Link>;
  const owner = /^run_[A-Za-z0-9]+$/.test(value) ? runItems[value] : undefined;
  if (owner) return <Link href={itemPath(owner)} title={t("data.runOf", { owner })} className={LINK_CLASS}>{value}</Link>;
  if (value.length <= CELL_MAX || open) return <>{value}</>;
  return (
    <>
      {value.slice(0, CELL_MAX)}…{" "}
      <Button variant="ghost" size="sm" onClick={onOpen} className={cn("font-sans", LINK_CLASS)}>
        {t("data.showAll", { count: value.length })}
      </Button>
    </>
  );
}

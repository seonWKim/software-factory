import { Copy } from "lucide-react";
import { type FormEvent, useState } from "react";
import { API, type DataCell, type DataPageBody, type DataTables, useManualApi } from "../api.js";
import { Empty, ErrorNote, Loading } from "../components/ui/parts.js";
import { LINK_CLASS } from "../components/ui/link-style.js";
import { cn } from "../lib/cn.js";
import { Link } from "../nav.js";
import { itemPath } from "../pages.js";

// The Data page (design §9, issue #239): every store table on the left with its row count, one page of the
// chosen table's rows on the right, newest first. Read-only. It reads only when a table, page or filter is
// chosen and when the top bar's Refresh is pressed: no polling. Values arrive already withheld or hidden by the
// API; long values are cut here, not in the API, so "Show all" needs no second read.

/** Cells longer than this are cut on display. */
export const CELL_MAX = 300;

const tab = "rounded-md border px-2 py-1 text-xs";
const tabOff = "border-zinc-300 hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800";

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
    <div className="flex min-w-0 gap-4 max-md:flex-col">
      <nav aria-label="Tables" className="w-56 shrink-0 max-md:w-full">
        {tables.isError ? <ErrorNote error={tables.error} /> : !tables.data ? <Loading rows={6} /> : (
          <ul className="space-y-0.5 text-sm">
            {tables.data.tables.map((t) => (
              <li key={t.name}>
                <button
                  type="button"
                  aria-pressed={t.name === table}
                  onClick={() => choose(t.name)}
                  className={cn(
                    "flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800",
                    t.name === table && "bg-zinc-100 font-medium dark:bg-zinc-800",
                  )}
                >
                  <span className="min-w-0 truncate font-mono text-xs">{t.name}</span>
                  <span className="ml-auto text-xs text-zinc-500 tabular-nums">{t.rows}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <div className="min-w-0 flex-1">
        {table === null ? (
          <Empty>Choose a table to see its rows, newest first.</Empty>
        ) : (
          <TableRows key={`${table}|${page}|${filter?.column ?? ""}|${filter?.value ?? ""}`} table={table} page={page} setPage={setPage} filter={filter} setFilter={(f) => { setFilter(f); setPage(1); }} />
        )}
      </div>
    </div>
  );
}

function TableRows({
  table, page, setPage, filter, setFilter,
}: {
  table: string;
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
    <section aria-label={`Table ${d.table}`}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="font-mono text-sm font-semibold">{d.table}</h2>
        <span className="text-sm text-zinc-500 tabular-nums" data-testid="data-range">
          {first}–{last} of {d.total}
        </span>
        <FilterForm columns={d.columns.filter((c) => !d.hidden.includes(c))} filter={filter} setFilter={setFilter} />
        <div className="ml-auto flex items-center gap-1">
          <button type="button" className={cn(tab, tabOff)} disabled={d.page <= 1} onClick={() => setPage(d.page - 1)}>
            Previous
          </button>
          <span className="text-xs text-zinc-500 tabular-nums">
            Page {d.page} of {pages}
          </span>
          <button type="button" className={cn(tab, tabOff)} disabled={d.page >= pages} onClick={() => setPage(d.page + 1)}>
            Next
          </button>
        </div>
      </div>
      {d.rows.length === 0 ? (
        <Empty>{filter ? "No row matches this filter." : "This table is empty."}</Empty>
      ) : (
        <div className="max-h-[75vh] overflow-auto rounded-md border border-zinc-200 dark:border-zinc-800">
          <table aria-label={d.table} className="text-left text-xs">
            <thead>
              <tr>
                <th scope="col" className="sticky top-0 z-10 bg-zinc-50 px-2 py-2 dark:bg-zinc-900">
                  <span className="sr-only">Copy</span>
                </th>
                {d.columns.map((c) => (
                  <th key={c} scope="col" className="sticky top-0 z-10 bg-zinc-50 px-2 py-2 font-mono font-medium whitespace-nowrap text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {d.rows.map((row, i) => (
                <tr key={i}>
                  <td className="px-2 py-1 align-top">
                    <button
                      type="button"
                      aria-label="Copy row as JSON"
                      title={copied === i ? "Copied" : "Copy row as JSON"}
                      onClick={() => copy(i, row)}
                      className="rounded p-1 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      <Copy aria-hidden className="size-3.5" />
                    </button>
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
    <form role="search" aria-label="Filter rows" onSubmit={submit} className="flex items-center gap-1">
      <select aria-label="Filter column" value={column} onChange={(e) => setColumn(e.target.value)} className="rounded-md border border-zinc-300 bg-transparent px-1 py-1 font-mono text-xs dark:border-zinc-700">
        {columns.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
      </select>
      <input
        aria-label="Filter value"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="equals…"
        className="w-40 rounded-md border border-zinc-300 bg-transparent px-2 py-1 text-xs dark:border-zinc-700"
      />
      <button type="submit" className={cn(tab, tabOff)}>Filter</button>
      {filter && (
        <button type="button" className={cn(tab, tabOff)} onClick={() => setFilter(null)}>Clear</button>
      )}
    </form>
  );
}

/** One cell: NULL muted, markers emphasised, item and run ids linked, long text cut with "Show all". */
function CellView({ value, runItems, open, onOpen }: { value: DataCell; runItems: Record<string, string>; open: boolean; onOpen: () => void }) {
  if (value === null) return <span className="text-zinc-400">NULL</span>;
  if (typeof value === "number") return <span className="tabular-nums">{value}</span>;
  if (value === "[hidden]" || value.startsWith("[withheld: ")) return <em className="text-amber-700 dark:text-amber-400">{value}</em>;
  if (/^wi_[A-Za-z0-9]+$/.test(value)) return <Link href={itemPath(value)} className={LINK_CLASS}>{value}</Link>;
  const owner = /^run_[A-Za-z0-9]+$/.test(value) ? runItems[value] : undefined;
  if (owner) return <Link href={itemPath(owner)} title={`Run of ${owner}`} className={LINK_CLASS}>{value}</Link>;
  if (value.length <= CELL_MAX || open) return <>{value}</>;
  return (
    <>
      {value.slice(0, CELL_MAX)}…{" "}
      <button type="button" onClick={onOpen} className={cn("font-sans", LINK_CLASS)}>
        Show all ({value.length} characters)
      </button>
    </>
  );
}

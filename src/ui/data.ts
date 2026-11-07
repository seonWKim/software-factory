// The Data page's read API (design §9, issue #239): every table of the store, read raw, one page at a time.
// Table and column names are checked against the store's own catalog (listTables) before any row is read, so
// a name the schema does not have is a 404 and never reaches SQL; a filter value is a bound parameter in the
// store. Hidden columns (fencing tokens, the link-code hash; listed once, in HIDDEN_COLUMNS) leave only as
// "[hidden]" and cannot be filtered on. Every text cell passes the Withholder the rest of the API uses.

import type { RunId } from "../core/types.js";
import { type FactoryStore, type StoreTable, TABLE_PAGE_DEFAULT, TABLE_PAGE_MAX, type TableCell } from "../interfaces/factory-store.js";

/** Columns whose values never leave the server: fencing tokens and the stored link-code hash. */
export const HIDDEN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  runs: ["lease_token"],
  listener_leases: ["token"],
  sync_leases: ["token"],
  run_attempts: ["lease_token"],
  link_codes: ["code_hash"],
};

/** What a hidden cell shows. */
export const HIDDEN = "[hidden]";

export function isHidden(table: string, column: string): boolean {
  return HIDDEN_COLUMNS[table]?.includes(column) ?? false;
}

/** What data.ts needs from the API: the store, the API's Withholder text function, and now. */
export interface DataCtx {
  store: FactoryStore;
  /** The API's Withholder: the value, or `[withheld: <rule>]`. */
  text(value: string): Promise<string | null>;
  now: Date;
}

export type DataResult = { status: number; value: unknown } | { status: number; error: string };

function hiddenOf(t: StoreTable): string[] {
  return t.columns.filter((c) => isHidden(t.name, c));
}

/** GET /api/v1/data/tables: each table's name, row count and columns (and which of them are hidden). */
export async function dataTables(c: DataCtx): Promise<DataResult> {
  const tables = (await c.store.listTables()).map((t) => ({ name: t.name, rows: t.rows, columns: t.columns, hidden: hiddenOf(t) }));
  return { status: 200, value: { as_of: c.now.toISOString(), tables } };
}

const POSITIVE = /^[1-9][0-9]{0,8}$/;

/**
 * GET /api/v1/data/tables/:name?page=&limit=&col=&val=: one page of rows (1-based `page`), newest first, with
 * the total, the page and the limit applied. 404 for a table or column the schema lacks, or a hidden column;
 * 400 for a bad page or limit, or `col` without `val` (or the reverse). Run ids in the page map to their item
 * in `run_items`, so the page can link a run to the item that owns it.
 */
export async function dataTable(c: DataCtx, name: string, params: URLSearchParams): Promise<DataResult> {
  const pageText = params.get("page");
  const limitText = params.get("limit");
  if (pageText !== null && !POSITIVE.test(pageText)) return { status: 400, error: "page must be a positive integer." };
  if (limitText !== null && !POSITIVE.test(limitText)) return { status: 400, error: "limit must be a positive integer." };
  const col = params.get("col");
  const val = params.get("val");
  if ((col === null) !== (val === null)) return { status: 400, error: "col and val go together." };

  // A hidden column is refused before anything is read, the same 404 as a column the table lacks.
  if (col !== null && isHidden(name, col)) return { status: 404, error: "No such column." };
  // The allow-list: the store's own catalog. No row is read for a name it does not list.
  const table = (await c.store.listTables()).find((t) => t.name === name);
  if (!table) return { status: 404, error: "No such table." };
  if (col !== null && !table.columns.includes(col)) return { status: 404, error: "No such column." };

  const limit = limitText === null ? TABLE_PAGE_DEFAULT : Math.min(TABLE_PAGE_MAX, Number(limitText));
  const pageNo = pageText === null ? 1 : Number(pageText);
  const page = await c.store.listTableRows({
    table: table.name,
    limit,
    offset: (pageNo - 1) * limit,
    ...(col !== null ? { filter: { column: col, value: val! } } : {}),
  });
  if (!page) return { status: 404, error: "No such table." };

  const rows: Record<string, TableCell>[] = [];
  const runIds = new Set<string>();
  for (const r of page.rows) {
    const out: Record<string, TableCell> = {};
    for (const column of table.columns) {
      if (isHidden(table.name, column)) {
        out[column] = HIDDEN;
        continue;
      }
      const v = r[column] ?? null;
      const shown = typeof v === "string" ? await c.text(v) : v;
      out[column] = shown;
      if (typeof shown === "string" && shown === v && /^run_[A-Za-z0-9]+$/.test(shown)) runIds.add(shown);
    }
    rows.push(out);
  }
  const run_items: Record<string, string> = {};
  for (const id of runIds) {
    const run = await c.store.getRun(id as RunId);
    if (run) run_items[id] = run.work_item_id;
  }
  return {
    status: 200,
    value: {
      as_of: c.now.toISOString(),
      table: table.name,
      columns: table.columns,
      hidden: hiddenOf(table),
      order_by: table.order_by,
      filter: col === null ? null : { column: col, value: await c.text(val!) },
      total: page.total,
      page: pageNo,
      limit: page.limit,
      rows,
      run_items,
    },
  };
}

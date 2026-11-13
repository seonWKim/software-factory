// The Data page's read API (design §9, issue #239): every table of the store, read raw, one page at a time.
// Table and column names are checked against the store's own catalog (listTables) before any row is read, so
// a name the schema does not have is a 404 and never reaches SQL; a filter value is a bound parameter in the
// store. Hidden columns (fencing tokens, the link-code hash; listed once, in HIDDEN_COLUMNS) leave only as
// "[hidden]" and cannot be filtered on. Every text cell passes the Withholder the rest of the API uses.
// Each table's line, owner and column meanings come from the table-docs.ts beside its component's migrations
// (TABLE_DOCS here gathers them); the Ask box (data-ask.ts) sends the same lines to the model.

import { TOPIC_TABLE_DOCS, TABLE_DOCS as BUS } from "../bus/table-docs.js";
import { TABLE_DOCS as CALENDAR } from "../calendar/table-docs.js";
import { TABLE_DOCS as CONTROLLER } from "../controller/table-docs.js";
import { collectAutonomy } from "../core/stats.js";
import type { RunId } from "../core/types.js";
import { TABLE_DOCS as IDENTITY } from "../identity/table-docs.js";
import { TABLE_DOCS as INBOUND } from "../inbound/table-docs.js";
import { type FactoryStore, type StoreTable, TABLE_PAGE_DEFAULT, TABLE_PAGE_MAX, type TableCell } from "../interfaces/factory-store.js";
import { TABLE_DOCS as OUTBOUND } from "../outbound/table-docs.js";
import { TABLE_DOCS as RUNTIME } from "../runtime/table-docs.js";
import { TABLE_DOCS as STATE } from "../state/table-docs.js";
import { TABLE_DOCS as WORKER } from "../worker/table-docs.js";

/** Each owning component's table lines (key `table`) and column meanings (key `table.column`). */
export const TABLE_DOCS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  bus: BUS, calendar: CALENDAR, controller: CONTROLLER, identity: IDENTITY, inbound: INBOUND, outbound: OUTBOUND, runtime: RUNTIME, state: STATE, worker: WORKER,
};

/** What a table holds: its owning component, one line, and the meaning of the columns whose name does not say. */
export interface TableDoc {
  owner: string;
  description: string;
  columns: Record<string, string>;
}

/** `table`'s doc; a bus topic's table (made at run time) by its suffix; null when no component describes it. */
export function tableDoc(table: string): TableDoc | null {
  for (const [owner, docs] of Object.entries(TABLE_DOCS)) {
    const description = docs[table];
    if (description === undefined) continue;
    const prefix = `${table}.`;
    const columns = Object.entries(docs).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k.slice(prefix.length), v] as const);
    return { owner, description, columns: Object.fromEntries(columns) };
  }
  const topic = table.startsWith("bus_") ? TOPIC_TABLE_DOCS.find(([suffix]) => table.endsWith(suffix)) : undefined;
  return topic ? { owner: "bus", description: topic[1], columns: {} } : null;
}

/** Columns whose values never leave the server: fencing tokens and the stored link-code hash. */
/** Each table appears twice until the contract migration: the legacy copy keeps its old name (RFC 0015 §12). */
export const HIDDEN_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  worker_runs: ["lease_token"],
  inbound_listener_leases: ["token"],
  worker_run_attempts: ["lease_token"],
  identity_link_codes: ["code_hash"],
  legacy_runs: ["lease_token"],
  legacy_listener_leases: ["token"],
  legacy_run_attempts: ["lease_token"],
  legacy_link_codes: ["code_hash"],
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
  /** The write token the Ask box sends (POST /api/v1/data/ask); null when this server has no Ask route. */
  askToken: string | null;
}

export type DataResult = { status: number; value: unknown } | { status: number; error: string };

function hiddenOf(t: StoreTable): string[] {
  return t.columns.filter((c) => isHidden(t.name, c));
}

/**
 * GET /api/v1/data/tables: each table's name, row count and columns (and which of them are hidden), with its line,
 * owner and column meanings (null and {} for a table no component describes; hidden columns get none), and the
 * Ask box's write token.
 */
export async function dataTables(c: DataCtx): Promise<DataResult> {
  const tables = (await c.store.listTables()).map((t) => {
    const doc = tableDoc(t.name);
    const hidden = hiddenOf(t);
    const column_docs = Object.fromEntries(Object.entries(doc?.columns ?? {}).filter(([col]) => !hidden.includes(col)));
    return { name: t.name, rows: t.rows, columns: t.columns, hidden, description: doc?.description ?? null, owner: doc?.owner ?? null, column_docs };
  });
  return { status: 200, value: { as_of: c.now.toISOString(), tables, csrf_token: c.askToken } };
}

/** GET /api/v1/data/autonomy: Autonomy (design §6), the same numbers as `factory stats --json`. One store read. */
export async function dataAutonomy(c: DataCtx): Promise<DataResult> {
  return { status: 200, value: { as_of: c.now.toISOString(), ...(await collectAutonomy(c.store)) } };
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

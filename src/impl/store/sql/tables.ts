// Raw table reads (design §9 Data page, issue #239), kept out of sql-factory-store.ts so that file stays within its
// line budget. Names come only from the database's catalog; see ident().

import type { StoreTable, TableCell, TablePage, TablePageInput } from "../../../interfaces/factory-store.js";
import { TABLE_PAGE_DEFAULT, TABLE_PAGE_MAX } from "../../../interfaces/factory-store.js";
import type { SqlDriver, SqlValue } from "../../../state/index.js";

export async function listTables(db: SqlDriver): Promise<StoreTable[]> {
  const out: StoreTable[] = [];
  for (const t of await catalog(db)) {
    const [row] = await db.all(`SELECT COUNT(*) AS n FROM ${ident(t.name)}`);
    out.push({ ...t, rows: Number(row?.n ?? 0) });
  }
  return out;
}

export async function listTableRows(db: SqlDriver, input: TablePageInput): Promise<TablePage | null> {
  const t = (await catalog(db)).find((c) => c.name === input.table);
  if (!t) return null;
  if (input.filter && !t.columns.includes(input.filter.column)) return null;
  const limit = pageLimit(input.limit);
  const offset = Number.isFinite(input.offset) ? Math.max(0, Math.floor(input.offset!)) : 0;
  const where = input.filter ? ` WHERE ${ident(input.filter.column)} = ?` : "";
  const params: SqlValue[] = input.filter ? [input.filter.value] : [];
  const order = t.order_by.length ? ` ORDER BY ${t.order_by.map((c) => `${ident(c)} DESC`).join(", ")}` : "";
  const [count] = await db.all(`SELECT COUNT(*) AS n FROM ${ident(t.name)}${where}`, params);
  // limit and offset are integers computed here, inlined as the other paged reads do.
  const rows = await db.all(`SELECT * FROM ${ident(t.name)}${where}${order} LIMIT ${limit} OFFSET ${offset}`, params);
  return {
    rows: rows.map((r) => Object.fromEntries(t.columns.map((c) => [c, toCell(r[c])]))),
    total: Number(count?.n ?? 0),
    limit,
    offset,
  };
}

/** The schema's tables from SQLite's own catalog, without row counts. */
async function catalog(db: SqlDriver): Promise<Omit<StoreTable, "rows">[]> {
  const tables = new Map<string, { columns: string[]; pk: { name: string; pos: number }[] }>();
  const names = await db.all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  );
  for (const n of names) {
    const cols = await db.all("SELECT name, pk FROM pragma_table_info(?) ORDER BY cid", [n.name as string]);
    tables.set(n.name as string, {
      columns: cols.map((c) => c.name as string),
      pk: cols.filter((c) => Number(c.pk) > 0).map((c) => ({ name: c.name as string, pos: Number(c.pk) })),
    });
  }
  const out: Omit<StoreTable, "rows">[] = [];
  for (const [name, t] of [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const primary_key = t.pk.sort((a, b) => a.pos - b.pos).map((p) => p.name);
    const time = TIME_COLUMNS.find((c) => t.columns.includes(c));
    const order_by = [...(time ? [time] : []), ...primary_key.filter((c) => c !== time)];
    out.push({ name, columns: t.columns, primary_key, order_by });
  }
  return out;
}

/** A table's order column is the first of these it has (design §9 Data page). */
const TIME_COLUMNS = ["created_at", "at", "started_at", "updated_at", "woke_at"] as const;

/** A quoted identifier. Only names read from the database's catalog reach here; any other is refused, so no caller text is ever spliced into SQL. */
function ident(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`not a plain identifier: ${JSON.stringify(name)}`);
  return `\`${name}\``;
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return TABLE_PAGE_DEFAULT;
  return Math.min(TABLE_PAGE_MAX, Math.max(1, Math.floor(limit)));
}

/** A driver value as a TableCell: dates as ISO text, big integers as numbers when exact, else text. */
function toCell(v: unknown): TableCell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return String(v);
}

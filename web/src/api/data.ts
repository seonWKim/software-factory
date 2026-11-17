// The Data page: GET /api/v1/data/tables, /api/v1/data/tables/:name and /api/v1/data/autonomy; POST /api/v1/data/ask (postDataAsk).

import { t } from "../i18n/index.js";
import { postJson } from "./client.js";
import { API } from "./routes.js";

/** One store table: its line, owning component and column meanings (null and {} when no component describes it). */
export interface DataTableInfo {
  name: string;
  rows: number;
  columns: string[];
  hidden: string[];
  /** Absent from a server older than the table docs. */
  description?: string | null;
  owner?: string | null;
  column_docs?: Record<string, string>;
}

/** `/api/v1/data/tables`: every store table (design §9 Data page); `csrf_token` is null when the server has no Ask route. */
export interface DataTables {
  as_of: string;
  tables: DataTableInfo[];
  csrf_token: string | null;
}

/** POST /api/v1/data/ask's answer: the query and its result, the query and why it was refused, or a message alone. */
export type DataAskResult =
  | { ok: true; sql: string; columns: string[]; rows: DataCell[][]; truncated: boolean; answer: string | null }
  | { ok: false; sql: string | null; error: string };

/** `/api/v1/data/autonomy`: merged factory items with no person's push (design §6); `autonomy` null with none merged. */
export interface DataAutonomy {
  as_of: string;
  merged: number;
  with_push: number;
  autonomy: number | null;
}

/** A cell as the API returns it: hidden columns are "[hidden]", withheld text "[withheld: <rule>]". */
export type DataCell = string | number | null;

/** `/api/v1/data/tables/:name`: one page of a table's rows, newest first. */
export interface DataPageBody {
  as_of: string;
  table: string;
  columns: string[];
  hidden: string[];
  order_by: string[];
  filter: { column: string; value: string | null } | null;
  total: number;
  page: number;
  limit: number;
  rows: Record<string, DataCell>[];
  /** Run id → the work item that owns it, for the run ids in this page. */
  run_items: Record<string, string>;
}

/** POST /api/v1/data/ask: one plain-text question (design 09-dashboard-app, Data page Ask). */
export async function postDataAsk(token: string, question: string): Promise<DataAskResult> {
  const r = await postJson<{ error?: string; sql?: string; columns?: string[]; rows?: DataCell[][]; truncated?: boolean; answer?: string | null }>(API.dataAsk, token, { question });
  const v = r.value;
  if (r.ok) return { ok: true, sql: v.sql ?? "", columns: v.columns ?? [], rows: v.rows ?? [], truncated: v.truncated === true, answer: v.answer ?? null };
  return { ok: false, sql: v.sql ?? null, error: v.error ?? t("api.http", { status: r.status }) };
}

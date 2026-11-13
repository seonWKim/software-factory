// The Data page's Ask box (design 09-dashboard-app): POST /api/v1/data/ask with {question}, owner only. The UI process
// asks the Model plugin (LLMProvider) for one read-only SQLite query, then runs it through the store's read-only
// query (FactoryStore.readOnlyQuery: the statement checks, its own read-only connection, 500 rows, 5 seconds).
//
// - Guards: server.ts runs Host, Origin, Content-Type, the CSRF token and the body size first; here the owner check
//   comes before anything else, so nobody else causes a model call.
// - The model sees the instruction, the question, today's UTC date and every table's and column's name with its line
//   from the table docs (data.ts tableDoc). Hidden columns are left out, and no row value or row count is sent. The
//   request passes the egress scan first; a flagged request is never sent.
// - A query that names a hidden column is refused here, before it runs; a result column with a hidden column's name
//   shows `[hidden]` (its reads also give NULL in the query). Every other text cell passes the Withholder.
// - One value (one row, one column) also gets a one-line answer, `<column>: <value>`, built here: no second model call.
// - Each model call's usage is recorded as one `data ask: model call` log record with its tokens and cost.
// - No model (none built), a model error or no query: a message, and no query runs. A store with no read-only query
//   (not SQLite) answers 409.

import { errorText, type Logger } from "../core/log.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "../interfaces/llm-provider.js";
import type { TableCell } from "../interfaces/factory-store.js";
import { sqlWords } from "../impl/store/sqlite/readonly-query.js";
import { type ApiResult, type ApiDeps, apiError } from "./api.js";
import { HIDDEN, HIDDEN_COLUMNS, tableDoc } from "./data.js";
import { ownerOf } from "./rules-api.js";
import { Withholder } from "./withhold.js";

export const DATA_ASK_PATH = "/api/v1/data/ask";
/** The longest question, in characters. */
export const QUESTION_MAX = 1000;

/** What the Ask route needs beyond the API's dependencies. */
export interface UiAsk {
  /** The configured Model plugin (one provider or the fallback chain); null when none could be built. */
  llm: LLMProvider | null;
  /** Where each model call's cost record goes. */
  log: Logger;
}

declare module "./settings-api.js" {
  interface UiSettings {
    /** The Data page's Ask (data-ask.ts). Absent: POST /api/v1/data/ask is a 405 and the page shows no Ask box. */
    ask?: UiAsk;
  }
}

export const ASK_SYSTEM = [
  "You write one read-only SQLite query that answers the owner's question about the data in their software factory's store.",
  "Rules: exactly one SELECT statement (WITH … SELECT is fine); never INSERT, UPDATE, DELETE, CREATE, DROP, ATTACH or PRAGMA;",
  "use only the tables and columns listed; times are ISO 8601 text in UTC, so 'today' is the UTC day given, and a day is",
  "compared with substr(<column>, 1, 10); give each result column a short readable name.",
  'Answer with JSON only: {"sql": "<the query>"}.',
].join(" ");

const ASK_SCHEMA = { type: "object", properties: { sql: { type: "string" } }, required: ["sql"], additionalProperties: false };
const ASK_MAX_TOKENS = 1024;
const ASK_TIMEOUT_MS = 60_000;

/** Every hidden column's name, upper-cased as sqlWords gives words. */
const HIDDEN_NAMES = new Set(Object.values(HIDDEN_COLUMNS).flat().map((c) => c.toUpperCase()));

/** The model's request: the instruction, then the question, today's UTC date and the schema with its lines. Never a row. */
export async function askRequest(d: Pick<ApiDeps, "store">, question: string, now: Date): Promise<LLMRequest> {
  const lines: string[] = [`Today (UTC): ${now.toISOString().slice(0, 10)}`, `Question: ${question}`, "", "Tables (name: what it holds), each with its columns (meaning where given):"];
  for (const t of await d.store.listTables()) {
    const doc = tableDoc(t.name);
    const shown = t.columns.filter((c) => !(HIDDEN_COLUMNS[t.name] ?? []).includes(c));
    lines.push(`${t.name}: ${doc?.description ?? "(no description)"}`, `  ${shown.map((c) => (doc?.columns[c] ? `${c} (${doc.columns[c]})` : c)).join(", ")}`);
  }
  return {
    model_class: "standard",
    system: ASK_SYSTEM,
    messages: [{ role: "user", content: lines.join("\n") }],
    max_tokens: ASK_MAX_TOKENS,
    output_schema: ASK_SCHEMA,
    data_env: "test",
    signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
  };
}

/** The query's problem with hidden columns: the first hidden column it names, as a refusal; null when it names none. */
export function hiddenProblem(sql: string): string | null {
  const word = sqlWords(sql).find((w) => HIDDEN_NAMES.has(w));
  return word === undefined ? null : `The query names ${word.toLowerCase()}, a hidden column: its values never leave the server.`;
}

/** The query the model answered with, or null. */
function sqlOf(res: LLMResponse): string | null {
  let out = res.parsed;
  if (out === undefined) {
    try {
      out = JSON.parse(res.text);
    } catch {
      return null;
    }
  }
  const sql = (out as { sql?: unknown } | null)?.sql;
  return typeof sql === "string" && sql.trim() !== "" ? sql.trim() : null;
}

/** POST /api/v1/data/ask, after server.ts's guards: the owner check, the question, the model, the checks, the query. */
export async function askData(d: ApiDeps, ask: UiAsk, body: unknown): Promise<ApiResult> {
  const who = d.pauses ? await ownerOf(d, d.pauses, "asks the data") : { error: "The page has no owner check: Ask is off." };
  if ("error" in who) return apiError(403, who.error);
  const question = (body as { question?: unknown } | null)?.question;
  if (typeof question !== "string" || question.trim().length === 0 || question.length > QUESTION_MAX) {
    return apiError(400, `question must be text of 1 to ${QUESTION_MAX} characters.`);
  }
  const query = d.store.readOnlyQuery;
  if (!query) return apiError(409, "Ask runs on the SQLite store only: this store has no read-only query.");
  if (!ask.llm) return apiError(503, "No model is configured: Ask needs the Model plugin (plugins.llm). The tables still show.");

  const w = new Withholder(d.scanner);
  const now = d.clock.now();
  const req = await askRequest(d, question.trim(), now);
  const scan = await d.scanner.scan("log", `${req.system}\n${req.messages[0]!.content}`);
  if (!scan.clean) return apiError(400, `The question was not sent: it matches ${[...new Set(scan.findings.map((f) => f.rule))].join(", ")}.`);
  let res: LLMResponse;
  try {
    res = await ask.llm.complete(req);
  } catch (err) {
    return apiError(502, `The model failed, so no query ran: ${(await w.plain(errorText(err))).text}`);
  }
  ask.log.info("data ask: model call", {
    model_class: req.model_class, served_by: res.served_by ?? null, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens, cost_usd: res.usage.cost_usd,
  });
  const sql = res.stop_reason === "end" ? sqlOf(res) : null;
  if (sql === null) return apiError(502, `The model gave no query (${res.stop_reason}), so no query ran.`);

  const shownSql = (await w.plain(sql)).text;
  const refusal = (reason: string): ApiResult => ({ status: 422, value: { error: reason, sql: shownSql, refused: reason } });
  const hidden = hiddenProblem(sql);
  if (hidden !== null) return refusal(hidden);
  const r = await query(sql, { ignore: HIDDEN_COLUMNS });
  if ("refused" in r) return refusal(r.refused);

  const hiddenAt = new Set(r.columns.flatMap((c, i) => (HIDDEN_NAMES.has(c.toUpperCase()) ? [i] : [])));
  const rows: TableCell[][] = [];
  for (const row of r.rows) {
    rows.push(await Promise.all(row.map(async (v, i) => (hiddenAt.has(i) ? HIDDEN : typeof v === "string" ? (await w.plain(v)).text : v))));
  }
  const one = rows.length === 1 && r.columns.length === 1 ? `${(await w.plain(r.columns[0]!)).text}: ${rows[0]![0] ?? "NULL"}` : null;
  const columns = await Promise.all(r.columns.map(async (c) => (await w.plain(c)).text));
  return { status: 200, value: { as_of: now.toISOString(), sql: shownSql, columns, rows, truncated: r.truncated, answer: one } };
}

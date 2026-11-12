// The text edit of factory.config.json that keeps the file's own layout: it changes only the value it sets or
// removes, so every other byte of the file stays as it was written. Pure: text in, text out. Used by the file-only
// key writer (design 08-settings) and by `factory setup` (src/cli/handlers/setup/config-edit.ts).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

export const isJsonObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

interface Member {
  key: string;
  /** Index of the key's opening quote. */
  start: number;
  valueStart: number;
  /** Index just past the value. */
  end: number;
}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i]!)) i++;
  return i;
}

function skipString(t: string, i: number): number {
  for (i++; i < t.length; i++) {
    if (t[i] === "\\") i++;
    else if (t[i] === '"') return i + 1;
  }
  throw new Error("factory.config.json: unterminated string");
}

function skipValue(t: string, i: number): number {
  if (t[i] === '"') return skipString(t, i);
  if (t[i] !== "{" && t[i] !== "[") {
    while (i < t.length && !/[\s,}\]]/.test(t[i]!)) i++;
    return i;
  }
  let depth = 0;
  for (; i < t.length; i++) {
    const ch = t[i]!;
    if (ch === '"') i = skipString(t, i) - 1;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  throw new Error("factory.config.json: unbalanced brackets");
}

/** The members of the JSON object text starting at `from` (its `{`, after whitespace), in order, with their positions. */
function members(t: string, from = 0): { members: Member[]; close: number } {
  let i = skipWs(t, from);
  if (t[i] !== "{") throw new Error("factory.config.json: not a JSON object");
  const out: Member[] = [];
  i = skipWs(t, i + 1);
  while (t[i] !== "}") {
    const start = i;
    i = skipString(t, i);
    const key = JSON.parse(t.slice(start, i)) as string;
    i = skipWs(t, i);
    if (t[i] !== ":") throw new Error(`factory.config.json: expected ":" after "${key}"`);
    const valueStart = skipWs(t, i + 1);
    const end = skipValue(t, valueStart);
    out.push({ key, start, valueStart, end });
    i = skipWs(t, end);
    if (t[i] === ",") i = skipWs(t, i + 1);
  }
  return { members: out, close: i };
}

/** One line when short (`{ "a": 1 }`), else one member per line, each member's value on one line. */
export function formatValue(v: Json, indent = "  "): string {
  const one = compact(v);
  if (one.length <= 100 || !isJsonObject(v)) return one;
  return `{\n${Object.entries(v).map(([k, x]) => `${indent}  ${JSON.stringify(k)}: ${compact(x)}`).join(",\n")}\n${indent}}`;
}

function compact(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(compact).join(", ")}]`;
  if (isJsonObject(v)) {
    const e = Object.entries(v);
    return e.length === 0 ? "{}" : `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${compact(x)}`).join(", ")} }`;
  }
  return JSON.stringify(v);
}

/**
 * `text` with the member at `path` (`["repo", "test_command"]`) set to `value`: only that value's text changes,
 * every other byte stays. A missing member is added last in its object; a missing parent object is added with it.
 * Throws when a parent on the path is not an object.
 */
export function setConfigKey(text: string, path: readonly string[], value: Json): string {
  let from = 0;
  let indent = "  ";
  for (const [depth, key] of path.entries()) {
    const { members: ms, close } = members(text, from);
    const m = ms.find((x) => x.key === key);
    const rest = path.slice(depth + 1);
    if (m && rest.length === 0) return text.slice(0, m.valueStart) + formatValue(value, indent) + text.slice(m.end);
    if (m) {
      if (text[skipWs(text, m.valueStart)] !== "{") throw new Error(`factory.config.json: ${path.slice(0, depth + 1).join(".")} is not an object`);
      from = m.valueStart;
      indent += "  ";
      continue;
    }
    // Missing here: the member, with any missing parents as one nested value, goes last in this object.
    const nested = rest.reduceRight<Json>((v, k) => ({ [k]: v }), value);
    const entry = `${JSON.stringify(key)}: ${formatValue(nested, indent)}`;
    const last = ms[ms.length - 1];
    const pad = indent.slice(2);
    return last
      ? `${text.slice(0, last.end)},\n${indent}${entry}${text.slice(last.end)}`
      : `${text.slice(0, close)}\n${indent}${entry}\n${pad}${text.slice(close)}`;
  }
  throw new Error("factory.config.json: an empty key path");
}

/** `text` without the top-level member `key` and the separator before it (or after it, when it is the first). */
export function removeConfigKey(text: string, key: string): string {
  const { members: ms } = members(text);
  const at = ms.findIndex((m) => m.key === key);
  const m = ms[at];
  if (!m) return text;
  return at > 0 ? text.slice(0, ms[at - 1]!.end) + text.slice(m.end) : text.slice(0, m.start) + text.slice(ms[1] ? ms[1].start : m.end);
}

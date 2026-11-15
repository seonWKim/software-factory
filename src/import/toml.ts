// A small TOML reader for the Codex user config (design 11-plugin-import): tables, arrays of tables, dotted and
// quoted keys, strings (basic, literal, multi-line), numbers, booleans, arrays and inline tables. Dates stay text.
// An error names the line only, never the text there: a config line can hold a secret value.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable {
  [key: string]: TomlValue;
}

export class TomlError extends Error {
  constructor(readonly line: number) {
    super(`not valid TOML at line ${line}`);
  }
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const BARE_VALUE = /[A-Za-z0-9_:.+-]/;
const ESCAPES: Readonly<Record<string, string>> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

const isTable = (v: TomlValue | undefined): v is TomlTable => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseToml(text: string): TomlTable {
  let i = 0;
  const root: TomlTable = {};
  let current = root;
  /** Tables a header or a dotted key made, which a later header may not open again. */
  const defined = new Set<TomlTable>();

  const fail = (): never => {
    throw new TomlError(text.slice(0, i).split("\n").length);
  };
  const peek = (s: string) => text.startsWith(s, i);
  const skipSpace = () => {
    while (text[i] === " " || text[i] === "\t") i++;
  };
  /** Spaces, newlines and comments, as between array items. */
  const skipBlank = () => {
    for (;;) {
      skipSpace();
      if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
      if (text[i] === "\n" || text[i] === "\r") i++;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpace();
    if (text[i] === "#") while (i < text.length && text[i] !== "\n") i++;
    if (text[i] === "\r") i++;
    if (i < text.length && text[i] !== "\n") fail();
  };

  function basicString(multi: boolean): string {
    const close = multi ? '"""' : '"';
    let out = "";
    if (multi && text[i] === "\n") i++;
    for (;;) {
      if (i >= text.length || (!multi && text[i] === "\n")) fail();
      if (peek(close)) {
        i += close.length;
        return out;
      }
      const c = text[i++]!;
      if (c !== "\\") {
        out += c;
        continue;
      }
      const e = text[i++]!;
      if (e in ESCAPES) out += ESCAPES[e];
      else if (e === "u" || e === "U") {
        const n = e === "u" ? 4 : 8;
        const hex = text.slice(i, i + n);
        if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== n) fail();
        out += String.fromCodePoint(parseInt(hex, 16));
        i += n;
      } else if (multi && /[\s]/.test(e)) {
        while (/[\s]/.test(text[i] ?? "")) i++;
      } else fail();
    }
  }

  function literalString(multi: boolean): string {
    const close = multi ? "'''" : "'";
    if (multi && text[i] === "\n") i++;
    const end = text.indexOf(close, i);
    if (end < 0 || (!multi && text.slice(i, end).includes("\n"))) fail();
    const out = text.slice(i, end);
    i = end + close.length;
    return out;
  }

  function key(): string[] {
    const parts: string[] = [];
    for (;;) {
      skipSpace();
      if (text[i] === '"') {
        i++;
        parts.push(basicString(false));
      } else if (text[i] === "'") {
        i++;
        parts.push(literalString(false));
      } else {
        const start = i;
        while (i < text.length && BARE_KEY.test(text[i]!)) i++;
        if (i === start) fail();
        parts.push(text.slice(start, i));
      }
      skipSpace();
      if (text[i] !== ".") return parts;
      i++;
    }
  }

  function value(): TomlValue {
    if (peek('"""')) return (i += 3), basicString(true);
    if (peek("'''")) return (i += 3), literalString(true);
    if (text[i] === '"') return i++, basicString(false);
    if (text[i] === "'") return i++, literalString(false);
    if (text[i] === "[") {
      i++;
      const out: TomlValue[] = [];
      for (;;) {
        skipBlank();
        if (text[i] === "]") return i++, out;
        out.push(value());
        skipBlank();
        if (text[i] === ",") i++;
        else if (text[i] !== "]") fail();
      }
    }
    if (text[i] === "{") {
      i++;
      const out: TomlTable = {};
      skipSpace();
      if (text[i] === "}") return i++, out;
      for (;;) {
        assign(out, key());
        skipSpace();
        if (text[i] === "}") return i++, out;
        if (text[i] !== ",") fail();
        i++;
      }
    }
    const start = i;
    while (i < text.length && BARE_VALUE.test(text[i]!)) i++;
    const word = text.slice(start, i);
    if (word === "true" || word === "false") return word === "true";
    const plain = word.replace(/_/g, "");
    if (/^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(plain)) return Number(plain);
    if (/^0x[0-9A-Fa-f]+$|^0o[0-7]+$|^0b[01]+$/.test(plain)) return Number(plain);
    if (/^[+-]?(inf|nan)$/.test(word)) return word.includes("nan") ? NaN : word.startsWith("-") ? -Infinity : Infinity;
    if (/^\d{4}-\d{2}-\d{2}/.test(word) || /^\d{2}:\d{2}/.test(word)) {
      // A date with a time after a space: "1979-05-27 07:32:00Z".
      if (text[i] === " " && /^\d{2}:\d{2}/.test(text.slice(i + 1))) {
        i++;
        while (i < text.length && BARE_VALUE.test(text[i]!)) i++;
      }
      return text.slice(start, i);
    }
    return fail();
  }

  /** `path = value` into `table`: dotted parts open (or make) tables on the way. */
  function assign(table: TomlTable, path: string[]): void {
    let t = table;
    for (const part of path.slice(0, -1)) {
      const next = t[part];
      if (next === undefined) t = t[part] = {};
      else if (isTable(next)) t = next;
      else fail();
      defined.add(t);
    }
    const last = path[path.length - 1]!;
    if (Object.hasOwn(t, last)) fail();
    skipSpace();
    if (text[i] !== "=") fail();
    i++;
    skipSpace();
    t[last] = value();
  }

  /** The table a `[a.b]` or `[[a.b]]` header names, made on the way. */
  function header(path: string[], many: boolean): TomlTable {
    let t = root;
    for (const [n, part] of path.entries()) {
      const lastPart = n === path.length - 1;
      const next = t[part];
      if (lastPart && many) {
        if (next === undefined) t[part] = [];
        else if (!Array.isArray(next)) fail();
        const fresh: TomlTable = {};
        (t[part] as TomlValue[]).push(fresh);
        return fresh;
      }
      if (next === undefined) t = t[part] = {};
      else if (isTable(next)) {
        if (lastPart && defined.has(next)) fail();
        t = next;
      } else if (Array.isArray(next) && isTable(next[next.length - 1]) && !lastPart) t = next[next.length - 1] as TomlTable;
      else fail();
    }
    defined.add(t);
    return t;
  }

  for (;;) {
    skipBlank();
    if (i >= text.length) return root;
    if (text[i] === "[") {
      const many = peek("[[");
      i += many ? 2 : 1;
      const path = key();
      if (!peek(many ? "]]" : "]")) fail();
      i += many ? 2 : 1;
      current = header(path, many);
    } else assign(current, key());
    endOfLine();
  }
}

// The in-repo schema helper of the API registry (design 09-api-registry): no schema library. One schema value gives
// the input check (parse), the output check that keeps only declared fields and sends every string through the
// caller's text function, the Withholder on a route (render), the JSON Schema for the OpenAPI document (json) and the
// TypeScript type for the generated client (ts). Nested objects may be typed as plain JSON objects (jsonObject).
// Only type imports and pure code, so scripts/gen-api.mjs loads it with Node's type stripping.

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
/** The text a string leaves the server as (a route's Withholder). */
export type TextOut = (value: string) => Promise<string>;
export type JsonSchema = Record<string, unknown>;
/** How a GET query parameter's text becomes the field's value. */
type QueryKind = "string" | "number" | "boolean";

export interface Schema<T> {
  parse(value: unknown, at?: string): Parsed<T>;
  /** The value as it leaves the server: checked like parse, declared fields only, each string through `text`. */
  render(value: unknown, text: TextOut, at?: string): Promise<Parsed<unknown>>;
  json(): JsonSchema;
  ts(): string;
  readonly query?: QueryKind;
  readonly optional?: true;
  /** A leaf's value in words ("a number"), for a nullable's refusal ("a number or null"). */
  readonly what?: string;
}

export type Infer<S> = S extends Schema<infer T> ? T : never;
type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends { optional: true } ? K : never }[keyof S];
type Flat<T> = { [K in keyof T]: T[K] };
export type ObjectOf<S extends Shape> = Flat<{ [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined> }>;

export interface ObjectSchema<T> extends Schema<T> {
  readonly fields: Shape;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (at: string, what: string): Parsed<never> => ({ ok: false, error: `${at} must be ${what}.` });
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A schema whose value is checked by `check` alone; strings go through `text` unless `fixed`. */
function leaf<T>(check: (v: unknown) => v is T, what: string, json: JsonSchema, ts: string, query?: QueryKind, fixed = false): Schema<T> {
  return {
    parse: (v, at = "value") => (check(v) ? ok(v) : fail(at, what)),
    render: async (v, text, at = "value") => (!check(v) ? fail(at, what) : ok(typeof v === "string" && !fixed ? await text(v) : v)),
    json: () => json,
    ts: () => ts,
    what,
    ...(query ? { query } : {}),
  };
}

export const string = (): Schema<string> => leaf((v): v is string => typeof v === "string", "a string", { type: "string" }, "string", "string");
export const integer = (): Schema<number> => leaf((v): v is number => Number.isSafeInteger(v), "an integer", { type: "integer" }, "number", "number");
export const number = (): Schema<number> => leaf((v): v is number => typeof v === "number" && Number.isFinite(v), "a number", { type: "number" }, "number", "number");
export const boolean = (): Schema<boolean> => leaf((v): v is boolean => typeof v === "boolean", "true or false", { type: "boolean" }, "boolean", "boolean");

/** One of fixed words: never withheld, since they are the code's own. */
export function oneOf<const W extends readonly string[]>(words: W): Schema<W[number]> {
  const check = (v: unknown): v is W[number] => typeof v === "string" && words.includes(v);
  return leaf(check, `one of ${words.join(", ")}`, { type: "string", enum: [...words] }, words.map((w) => JSON.stringify(w)).join(" | "), "string", true);
}

/** Every string in a JSON value through `text`, at any depth. */
async function textDeep(v: unknown, text: TextOut): Promise<unknown> {
  if (typeof v === "string") return text(v);
  if (Array.isArray(v)) return Promise.all(v.map((x) => textDeep(x, text)));
  if (isPlainObject(v)) return Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, x]) => [k, await textDeep(x, text)] as const)));
  return v;
}

/** A nested object typed only as a JSON object (owner answer 3): its fields are not checked, its strings still withheld. */
export function jsonObject(): Schema<{ [key: string]: unknown }> {
  return {
    parse: (v, at = "value") => (isPlainObject(v) ? ok(v) : fail(at, "a JSON object")),
    render: async (v, text, at = "value") => (isPlainObject(v) ? ok(await textDeep(v, text)) : fail(at, "a JSON object")),
    json: () => ({ type: "object" }),
    ts: () => "{ [key: string]: unknown }",
  };
}

export function nullable<T>(s: Schema<T>): Schema<T | null> {
  const what = s.what === undefined ? undefined : `${s.what} or null`;
  // A leaf's refusal names null too ("daily_cap_usd must be a number or null."); a nested schema's names its field.
  const orNull = <P>(r: Parsed<P>, at = "value"): Parsed<P> => (r.ok || what === undefined ? r : fail(at, what));
  return {
    parse: (v, at) => (v === null ? ok(null) : orNull(s.parse(v, at), at)),
    render: async (v, text, at) => (v === null ? ok(null) : orNull(await s.render(v, text, at), at)),
    json: () => ({ anyOf: [s.json(), { type: "null" }] }),
    ts: () => `${s.ts()} | null`,
    ...(what === undefined ? {} : { what }),
    ...(s.query ? { query: s.query } : {}),
  };
}

/** A field an object may leave out. */
export function optional<T>(s: Schema<T>): Schema<T | undefined> & { optional: true } {
  return {
    parse: (v, at) => (v === undefined ? ok(undefined) : s.parse(v, at)),
    render: async (v, text, at) => (v === undefined ? ok(undefined) : s.render(v, text, at)),
    json: () => s.json(),
    ts: () => s.ts(),
    ...(s.query ? { query: s.query } : {}),
    optional: true,
  };
}

export function array<T>(s: Schema<T>): Schema<T[]> {
  return {
    parse(v, at = "value") {
      if (!Array.isArray(v)) return fail(at, "an array");
      const out: T[] = [];
      for (const [i, x] of v.entries()) {
        const r = s.parse(x, `${at}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
    async render(v, text, at = "value") {
      if (!Array.isArray(v)) return fail(at, "an array");
      const out: unknown[] = [];
      for (const [i, x] of v.entries()) {
        const r = await s.render(x, text, `${at}[${i}]`);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return ok(out);
    },
    json: () => ({ type: "array", items: s.json() }),
    ts: () => `Array<${s.ts()}>`,
  };
}

/** An object with these fields only: parse refuses another field, render leaves it out. */
export function object<S extends Shape>(fields: S): ObjectSchema<ObjectOf<S>> {
  const entries = Object.entries(fields);
  const field = (at: string, k: string) => (at === "" ? k : `${at}.${k}`);
  return {
    fields,
    parse(v, at = "") {
      if (!isPlainObject(v)) return fail(at || "value", "an object");
      const extra = Object.keys(v).find((k) => !Object.hasOwn(fields, k));
      if (extra !== undefined) return { ok: false, error: `${field(at, extra)} is not a field.` };
      const out: Record<string, unknown> = {};
      for (const [k, s] of entries) {
        const r = s.parse(v[k], field(at, k));
        if (!r.ok) return r;
        if (r.value !== undefined) out[k] = r.value;
      }
      return ok(out as ObjectOf<S>);
    },
    async render(v, text, at = "") {
      if (!isPlainObject(v)) return fail(at || "value", "an object");
      const out: Record<string, unknown> = {};
      for (const [k, s] of entries) {
        const r = await s.render(v[k], text, field(at, k));
        if (!r.ok) return r;
        if (r.value !== undefined) out[k] = r.value;
      }
      return ok(out);
    },
    json: () => ({
      type: "object",
      properties: Object.fromEntries(entries.map(([k, s]) => [k, s.json()])),
      required: entries.filter(([, s]) => !s.optional).map(([k]) => k),
      additionalProperties: false,
    }),
    ts: () => (entries.length === 0 ? "{ [key: string]: never }" : `{ ${entries.map(([k, s]) => `${JSON.stringify(k)}${s.optional ? "?" : ""}: ${s.ts()}`).join("; ")} }`),
  };
}

/** A GET's query parameters as the input object's raw value: declared fields only, each by its query kind. */
export function fromQuery(s: ObjectSchema<unknown>, params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(s.fields)) {
    const raw = params.get(k);
    if (raw === null) continue;
    if (f.query === "number") out[k] = raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else if (f.query === "boolean") out[k] = raw === "true" ? true : raw === "false" ? false : raw;
    else out[k] = raw;
  }
  return out;
}

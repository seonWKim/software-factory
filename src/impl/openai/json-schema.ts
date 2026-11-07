// A small JSON Schema checker for structured answers. It knows six keywords: type, properties, required,
// additionalProperties, items and enum. `title` and `description` are accepted as annotations. Any other
// keyword makes the schema invalid: checkSchema throws naming it, before any value is compared, so a schema
// never silently means less than it says.

export const SCHEMA_KEYWORDS = ["type", "properties", "required", "additionalProperties", "items", "enum"] as const;
export const SCHEMA_ANNOTATIONS = ["title", "description"] as const;
export const SCHEMA_TYPES = ["string", "number", "integer", "boolean", "object", "array", "null"] as const;

export type JsonSchema = {
  type?: (typeof SCHEMA_TYPES)[number] | (typeof SCHEMA_TYPES)[number][];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  enum?: unknown[];
  title?: string;
  description?: string;
};

export interface SchemaMismatch {
  /** Where the value failed: "$" is the root, then ".key" and "[index]". */
  path: string;
  message: string;
}

export type SchemaResult = { ok: true } | { ok: false; mismatches: SchemaMismatch[] };

/** The schema itself is not one this checker supports. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

const ALLOWED: readonly string[] = [...SCHEMA_KEYWORDS, ...SCHEMA_ANNOTATIONS];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Throws a SchemaError for an unsupported keyword or a malformed one; `at` is the schema location. */
export function checkSchema(schema: unknown, at = "#"): asserts schema is JsonSchema {
  if (!isObject(schema)) throw new SchemaError(`schema at ${at} must be an object`);
  for (const k of Object.keys(schema)) {
    if (!ALLOWED.includes(k)) {
      throw new SchemaError(`unsupported schema keyword "${k}" at ${at}; supported: ${ALLOWED.join(", ")}`);
    }
  }
  const { type, properties, required, additionalProperties, items } = schema;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    for (const t of types) {
      if (typeof t !== "string" || !(SCHEMA_TYPES as readonly string[]).includes(t)) {
        throw new SchemaError(`schema at ${at}: "type" ${JSON.stringify(t)} is not one of ${SCHEMA_TYPES.join(", ")}`);
      }
    }
  }
  if (properties !== undefined) {
    if (!isObject(properties)) throw new SchemaError(`schema at ${at}: "properties" must be an object`);
    for (const [k, sub] of Object.entries(properties)) checkSchema(sub, `${at}/properties/${k}`);
  }
  if (required !== undefined && (!Array.isArray(required) || !required.every((r) => typeof r === "string"))) {
    throw new SchemaError(`schema at ${at}: "required" must be a list of strings`);
  }
  if (additionalProperties !== undefined && typeof additionalProperties !== "boolean") {
    checkSchema(additionalProperties, `${at}/additionalProperties`);
  }
  if (items !== undefined) checkSchema(items, `${at}/items`);
  if (schema.enum !== undefined && !Array.isArray(schema.enum)) throw new SchemaError(`schema at ${at}: "enum" must be a list`);
  for (const a of SCHEMA_ANNOTATIONS) {
    if (schema[a] !== undefined && typeof schema[a] !== "string") throw new SchemaError(`schema at ${at}: "${a}" must be a string`);
  }
}

function typeOf(v: unknown): (typeof SCHEMA_TYPES)[number] | "other" {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "string") return "string";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return Number.isFinite(v) ? "number" : "other";
  if (typeof v === "object") return "object";
  return "other";
}

function matchesType(v: unknown, t: (typeof SCHEMA_TYPES)[number]): boolean {
  const actual = typeOf(v);
  if (t === "integer") return actual === "number" && Number.isInteger(v);
  return actual === t;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function keyPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function compare(schema: JsonSchema, value: unknown, path: string, out: SchemaMismatch[]): void {
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      out.push({ path, message: `expected ${types.join(" or ")}, got ${typeOf(value)}` });
      return;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    out.push({ path, message: `expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}` });
  }
  if (isObject(value)) {
    const props = schema.properties ?? {};
    for (const r of schema.required ?? []) {
      if (!Object.hasOwn(value, r)) out.push({ path: keyPath(path, r), message: "required property is missing" });
    }
    for (const [k, v] of Object.entries(value)) {
      const sub = Object.hasOwn(props, k) ? props[k] : undefined;
      if (sub) compare(sub, v, keyPath(path, k), out);
      else if (schema.additionalProperties === false) out.push({ path: keyPath(path, k), message: "property is not allowed" });
      else if (isObject(schema.additionalProperties)) compare(schema.additionalProperties, v, keyPath(path, k), out);
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => compare(schema.items!, v, `${path}[${i}]`, out));
  }
}

/**
 * Checks `value` against `schema`. Throws a SchemaError when the schema is not supported (before any value is
 * compared); otherwise returns ok or every failing path. A mismatch never throws.
 */
export function validateAgainstSchema(schema: unknown, value: unknown): SchemaResult {
  checkSchema(schema);
  const mismatches: SchemaMismatch[] = [];
  compare(schema, value, "$", mismatches);
  return mismatches.length === 0 ? { ok: true } : { ok: false, mismatches };
}

// The check of a final answer against a run's output_schema, for runners that get the answer as plain text
// (openai-compatible). It knows the keywords the factory's own schemas use (src/core/outputs.ts, the canary):
// type, properties, required, additionalProperties, items, enum, const, minItems, maxItems, minLength,
// maxLength, minimum, maximum and pattern; title, description, default and examples are annotations. Any other
// keyword makes the schema unsupported: unsupportedKeyword names it before the run starts, so a schema never
// silently means less than it says.

const KEYWORDS = [
  "type", "properties", "required", "additionalProperties", "items", "enum", "const",
  "minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "pattern",
] as const;
const ANNOTATIONS = ["title", "description", "default", "examples"] as const;
const ALLOWED: readonly string[] = [...KEYWORDS, ...ANNOTATIONS];

type Schema = Record<string, unknown>;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The first unsupported keyword (with its location) in `schema`, or undefined when every keyword is known. */
export function unsupportedKeyword(schema: unknown, at = "#"): string | undefined {
  if (!isObject(schema)) return `schema at ${at} is not an object`;
  for (const k of Object.keys(schema)) {
    if (!ALLOWED.includes(k)) return `unsupported schema keyword "${k}" at ${at}`;
  }
  if (isObject(schema.properties)) {
    for (const [k, sub] of Object.entries(schema.properties)) {
      const bad = unsupportedKeyword(sub, `${at}/properties/${k}`);
      if (bad) return bad;
    }
  }
  if (schema.items !== undefined) {
    const bad = unsupportedKeyword(schema.items, `${at}/items`);
    if (bad) return bad;
  }
  if (isObject(schema.additionalProperties)) {
    const bad = unsupportedKeyword(schema.additionalProperties, `${at}/additionalProperties`);
    if (bad) return bad;
  }
  return undefined;
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function hasType(t: string, v: unknown): boolean {
  if (t === "integer") return typeof v === "number" && Number.isInteger(v);
  if (t === "number") return typeof v === "number" && Number.isFinite(v);
  return typeOf(v) === t;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function compare(schema: Schema, v: unknown, path: string, out: string[]): void {
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => hasType(t, v))) {
      out.push(`${path} should be ${types.join(" or ")}, got ${typeOf(v)}`);
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) {
    out.push(`${path} should be one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(v)) out.push(`${path} should be ${JSON.stringify(schema.const)}`);
  if (typeof v === "string") {
    const min = num(schema.minLength);
    const max = num(schema.maxLength);
    if (min !== undefined && v.length < min) out.push(`${path} is shorter than ${min}`);
    if (max !== undefined && v.length > max) out.push(`${path} is longer than ${max}`);
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) out.push(`${path} does not match ${schema.pattern}`);
  }
  if (typeof v === "number") {
    const min = num(schema.minimum);
    const max = num(schema.maximum);
    if (min !== undefined && v < min) out.push(`${path} is less than ${min}`);
    if (max !== undefined && v > max) out.push(`${path} is more than ${max}`);
  }
  if (Array.isArray(v)) {
    const min = num(schema.minItems);
    const max = num(schema.maxItems);
    if (min !== undefined && v.length < min) out.push(`${path} has fewer than ${min} items`);
    if (max !== undefined && v.length > max) out.push(`${path} has more than ${max} items`);
    if (isObject(schema.items)) v.forEach((item, i) => compare(schema.items as Schema, item, `${path}[${i}]`, out));
  }
  if (isObject(v)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const k of schema.required as string[]) if (!(k in v)) out.push(`${path}.${k} is required`);
    }
    for (const [k, value] of Object.entries(v)) {
      const sub = props[k];
      if (isObject(sub)) compare(sub, value, `${path}.${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${path}.${k} is not allowed`);
      else if (isObject(schema.additionalProperties)) compare(schema.additionalProperties, value, `${path}.${k}`, out);
    }
  }
}

/** Every place `value` fails `schema` ("$" is the root); empty when it matches. Call unsupportedKeyword first. */
export function schemaMismatches(schema: Record<string, unknown>, value: unknown): string[] {
  const out: string[] = [];
  compare(schema, value, "$", out);
  return out;
}

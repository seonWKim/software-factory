import { describe, expect, it } from "vitest";
import { SchemaError, checkSchema, validateAgainstSchema } from "../src/impl/openai/json-schema.js";

const ok = (schema: unknown, value: unknown) => expect(validateAgainstSchema(schema, value)).toEqual({ ok: true });
const paths = (schema: unknown, value: unknown) => {
  const r = validateAgainstSchema(schema, value);
  if (r.ok) throw new Error("expected a mismatch");
  return r.mismatches.map((m) => m.path);
};

describe("json schema: keywords", () => {
  it("type", () => {
    ok({ type: "string" }, "a");
    ok({ type: "number" }, 1.5);
    ok({ type: "integer" }, 2);
    ok({ type: "boolean" }, false);
    ok({ type: "null" }, null);
    ok({ type: "object" }, {});
    ok({ type: "array" }, []);
    ok({ type: ["string", "null"] }, null);
    expect(paths({ type: "string" }, 1)).toEqual(["$"]);
    expect(paths({ type: "integer" }, 1.5)).toEqual(["$"]);
    expect(paths({ type: "object" }, [])).toEqual(["$"]);
    expect(paths({ type: "array" }, {})).toEqual(["$"]);
    expect(paths({ type: "number" }, "1")).toEqual(["$"]);
    expect(paths({ type: ["string", "null"] }, 0)).toEqual(["$"]);
  });

  it("properties", () => {
    const s = { type: "object", properties: { a: { type: "string" }, b: { type: "integer" } } };
    ok(s, { a: "x", b: 1 });
    ok(s, {});
    expect(paths(s, { a: 1, b: "y" })).toEqual(["$.a", "$.b"]);
  });

  it("required", () => {
    const s = { type: "object", properties: { a: { type: "string" } }, required: ["a", "b"] };
    ok(s, { a: "x", b: null });
    expect(paths(s, {})).toEqual(["$.a", "$.b"]);
  });

  it("additionalProperties: false rejects extra keys; absent or true allows them; a schema checks them", () => {
    const props = { a: { type: "string" } };
    expect(paths({ type: "object", properties: props, additionalProperties: false }, { a: "x", extra: 1 })).toEqual(["$.extra"]);
    ok({ type: "object", properties: props, additionalProperties: false }, { a: "x" });
    ok({ type: "object", properties: props }, { a: "x", extra: 1 });
    ok({ type: "object", properties: props, additionalProperties: true }, { a: "x", extra: 1 });
    expect(paths({ type: "object", additionalProperties: { type: "number" } }, { n: 1, s: "x" })).toEqual(["$.s"]);
  });

  it("items", () => {
    const s = { type: "array", items: { type: "string" } };
    ok(s, ["a", "b"]);
    expect(paths(s, ["a", 1, "c", false])).toEqual(["$[1]", "$[3]"]);
  });

  it("enum", () => {
    const s = { enum: ["approve", "revise", 3, null, { a: 1 }] };
    ok(s, "approve");
    ok(s, 3);
    ok(s, null);
    ok(s, { a: 1 });
    expect(paths(s, "reject")).toEqual(["$"]);
    expect(paths(s, { a: 2 })).toEqual(["$"]);
  });

  it("title and description are accepted as annotations", () => {
    ok({ title: "Verdict", description: "The reviewer's verdict", type: "string" }, "x");
  });
});

describe("json schema: mismatches", () => {
  it("a nested mismatch lists every failing path and does not throw", () => {
    const schema = {
      type: "object",
      required: ["verdict", "findings"],
      additionalProperties: false,
      properties: {
        verdict: { enum: ["approve", "revise"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            required: ["file", "severity"],
            properties: { file: { type: "string" }, severity: { type: "string" }, line: { type: "integer" } },
          },
        },
      },
    };
    const value = { verdict: "maybe", findings: [{ file: "a.ts", severity: "high" }, { file: 3, line: 1.5 }], extra: true };
    const r = validateAgainstSchema(schema, value);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.mismatches.map((m) => m.path).sort()).toEqual(
      ["$.verdict", "$.findings[1].severity", "$.findings[1].file", "$.findings[1].line", "$.extra"].sort(),
    );
    for (const m of r.mismatches) expect(m.message).not.toBe("");
  });
});

describe("json schema: unsupported keywords throw before comparing", () => {
  it.each(["minLength", "pattern", "$ref", "oneOf", "anyOf", "allOf", "format", "minimum", "const", "default"])(
    "%s throws naming the keyword",
    (kw) => {
      expect(() => validateAgainstSchema({ type: "string", [kw]: 1 }, "anything")).toThrow(SchemaError);
      expect(() => validateAgainstSchema({ type: "string", [kw]: 1 }, "anything")).toThrow(`"${kw}"`);
    },
  );

  it("a nested unsupported keyword throws even when the value would not reach it", () => {
    const schema = { type: "object", properties: { a: { type: "array", items: { type: "string", maxLength: 3 } } } };
    expect(() => validateAgainstSchema(schema, {})).toThrow('"maxLength"');
    // and when the top-level value mismatches: the schema is checked first.
    expect(() => validateAgainstSchema(schema, 42)).toThrow('"maxLength"');
    expect(() => checkSchema(schema)).toThrow(SchemaError);
  });

  it("a malformed keyword value throws", () => {
    expect(() => checkSchema({ type: "text" })).toThrow(SchemaError);
    expect(() => checkSchema({ required: "a" })).toThrow(SchemaError);
    expect(() => checkSchema({ enum: "a" })).toThrow(SchemaError);
    expect(() => checkSchema("string")).toThrow(SchemaError);
  });
});

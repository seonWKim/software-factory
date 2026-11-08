import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { envelope, envelopeProblems } from "../../src/shared/envelope.js";
import { maxRedeliveryMs } from "../../src/shared/topic.js";
import { DESCRIPTOR_PATTERNS, type Registry, findDescriptorFiles, loadRegistry } from "../../src/runtime/registry/registry.js";
import { REPO, SRC, codeOnly, componentOf, read, sourceFiles } from "./lib.js";

// RFC 0015 §9: handler-layout, dispatch-coverage, topic-ownership and envelope-shape, on the real registry.

let registry: Registry;
beforeAll(async () => {
  registry = await loadRegistry(SRC);
});

describe("handler-layout", () => {
  it("handlers and topics sit at their convention paths, each handler with a test beside it", () => {
    const bad: string[] = [];
    for (const file of findDescriptorFiles(SRC, DESCRIPTOR_PATTERNS.handler)) {
      const rel = file.slice(SRC.length + 1);
      const m = /^([a-z]+)\/handlers\/([a-z0-9-]+)\/([a-z0-9-]+)\.handler\.ts$/.exec(rel);
      if (!m || m[2] !== m[3] || !componentOf(rel)) bad.push(`${rel}: expected src/<component>/handlers/<name>/<name>.handler.ts`);
      const test = join(dirname(file), `${basename(file, ".handler.ts")}.test.ts`);
      const testInTests = join(REPO, "tests", rel.replace(/\.handler\.ts$/, ".test.ts"));
      if (!existsSync(test) && !existsSync(testInTests)) bad.push(`${rel}: no test beside it`);
    }
    for (const file of findDescriptorFiles(SRC, DESCRIPTOR_PATTERNS.topic)) {
      const rel = file.slice(SRC.length + 1);
      if (!/^[a-z]+\/topics\/[a-z0-9-]+\.topic\.ts$/.test(rel) || !componentOf(rel)) bad.push(`${rel}: expected src/<component>/topics/<name>.topic.ts`);
    }
    expect(bad).toEqual([]);
  });

  it("no central file imports a handler, and no core code switches on message type", () => {
    const bad: string[] = [];
    for (const file of sourceFiles()) {
      if (/\/handlers\//.test(file)) continue;
      const text = read(file);
      if (/from\s+["'][^"']*\/handlers\/[^"']+\.handler\.js["']/.test(text)) bad.push(`${file}: imports a handler`);
      if (componentOf(file) && /switch\s*\(\s*\w+\.type\s*\)/.test(codeOnly(text))) bad.push(`${file}: switch on message type`);
    }
    expect(bad).toEqual([]);
  });
});

describe("dispatch-coverage", () => {
  it("every command has exactly one handler, and every accepted type is on a topic", () => {
    expect(registry.problems()).toEqual([]);
  });
});

describe("topic-ownership", () => {
  it("each topic is owned by the component that declares it", () => {
    const bad = registry.topics.filter((t) => componentOf(t.file) !== t.descriptor.owner).map((t) => `${t.file}: owner ${t.descriptor.owner}`);
    expect(bad).toEqual([]);
  });
});

describe("envelope-shape", () => {
  it("a built envelope is well formed, and long strings or objects in a payload are refused", () => {
    const cause = { id: null, correlation_id: "c1", project_id: "p", passport_id: null, occurred_at: "2026-11-08T00:00:00.000Z" };
    const ok = envelope({ type: "X", subject: "s", idempotency_key: "k", idempotency_key_ttl_ms: null, payload: { a: "id", n: 1 } }, cause, "test", "m1");
    expect(envelopeProblems(ok)).toEqual([]);
    const long = envelope({ type: "X", subject: "s", idempotency_key: "k", idempotency_key_ttl_ms: 10, payload: { body: "x".repeat(201) } }, cause, "test", "m2");
    expect(envelopeProblems(long)).toEqual([expect.stringContaining("store it and send its id")]);
    // MySQL keeps these in VARCHAR(191): a longer one would be cut, and two keys sharing a prefix would dedupe as one.
    const key = (k: string, subject: string, producer: string) =>
      envelopeProblems(envelope({ type: "X", subject, idempotency_key: k, idempotency_key_ttl_ms: null, payload: {} }, cause, producer, "m3"));
    expect(key("k".repeat(191), "s".repeat(191), "p".repeat(191))).toEqual([]);
    expect(key("k".repeat(192), "s", "test")).toEqual(["idempotency_key is longer than 191 chars"]);
    expect(key("k", "s".repeat(192), "test")).toEqual(["subject is longer than 191 chars"]);
    expect(key("k", "s", "p".repeat(192))).toEqual(["producer is longer than 191 chars"]);
  });

  it("a topic's retries end within its maximum redelivery", () => {
    for (const t of registry.topics) expect(maxRedeliveryMs(t.descriptor.backoff)).toBeGreaterThan(0);
  });
});

// The three scans `factory pack add` runs on a tool or MCP server descriptor before it is stored (design 11-packs,
// issue #588). Each returns the names of the rules that failed; an empty list passes.
// - egress: the configured EgressScanner on channel `tool_result`, over the descriptor's canonical JSON.
// - credential-leak: a secret value in the descriptor, or a `credential` that is not an environment variable name.
// - tool-poisoning: instructions to the model hidden in any string field (the description and every other one).

import type { EgressScanner } from "../interfaces/egress-scanner.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Keys whose non-empty string value is a credential itself (any case, any depth). */
const SECRET_KEY = /^(token|secret|password|api_key|apikey|authorization)$/i;
/** What a `credential` field must be: the name of an environment variable, never its value. */
const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/;

const NEAR = "[\\s\\S]{0,40}?";
const POISONING: readonly { rule: string; pattern: RegExp }[] = [
  {
    rule: "override_instructions",
    pattern: new RegExp(`\\b(ignore|disregard|forget)\\b${NEAR}\\b(previous|prior|above|system)\\b${NEAR}\\b(instructions?|rules?|prompts?)\\b`, "i"),
  },
  { rule: "concealment", pattern: new RegExp(`(\\bdo\\s+not\\b|\\bdon['’]t\\b|\\bnever\\b)${NEAR}\\b(tell|inform|mention|reveal)\\b${NEAR}\\busers?\\b`, "i") },
  { rule: "secret_file_access", pattern: /\.ssh\/|id_rsa|(^|[\s/'"`~=:(])\.env\b|\.aws\/credentials|\/etc\/passwd/i },
  // Zero-width characters, the word joiner and invisible operators, the byte order mark, and bidi controls.
  { rule: "invisible_text", pattern: /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/ },
];

/** Every [key, value] pair of the descriptor, at any depth (array items carry their parent's key). */
function* fields(value: Json, key: string | null = null): Generator<[string | null, Json]> {
  if (Array.isArray(value)) {
    for (const v of value) {
      yield [key, v];
      yield* fields(v, key);
    }
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      yield [k, v];
      yield* fields(v, k);
    }
  }
}

/** Every string in the descriptor: each value, and each key (a key can carry invisible text too). */
function strings(value: Json): string[] {
  const out: string[] = typeof value === "string" ? [value] : [];
  for (const [k, v] of fields(value)) {
    if (k !== null) out.push(k);
    if (typeof v === "string") out.push(v);
  }
  return out;
}

async function egressScan(scanner: EgressScanner, canonical: string): Promise<string[]> {
  const r = await scanner.scan("tool_result", canonical);
  return r.clean ? [] : [...new Set(r.findings.map((f) => f.rule))];
}

/** `credential_value`: a secret value under a secret-named key. `credential_name`: a `credential` that is not a name. */
function credentialLeakScan(descriptor: Json): string[] {
  const out = new Set<string>();
  for (const [k, v] of fields(descriptor)) {
    if (k === null) continue;
    if (SECRET_KEY.test(k) && typeof v === "string" && v.trim() !== "") out.add("credential_value");
    if (k === "credential" && !(typeof v === "string" && CREDENTIAL_NAME.test(v))) out.add("credential_name");
  }
  return [...out];
}

function toolPoisoningScan(descriptor: Json): string[] {
  const texts = strings(descriptor);
  return POISONING.filter((p) => texts.some((t) => p.pattern.test(t))).map((p) => p.rule);
}

/** The failed rules of all three scans, egress first; empty when the descriptor passes. */
export async function scanDescriptor(scanner: EgressScanner, descriptor: Json, canonical: string): Promise<string[]> {
  return [...(await egressScan(scanner, canonical)), ...credentialLeakScan(descriptor), ...toolPoisoningScan(descriptor)];
}

// `factory llm-check` and the `doctor --llm` line: two small real calls to the configured LLMProvider.
// Nothing in the factory's own workflow calls this. Every printed line passes the EgressScanner first
// (channel `log`): a provider's error text could carry a credential. A field with a finding is withheld
// whole as `[withheld: <rule>]` (design, withhold-not-mask); its text is never printed.

import type { Plugins } from "./compose.js";
import type { Clock } from "./interfaces/clock.js";
import type { EgressScanner } from "./interfaces/egress-scanner.js";
import type { LLMProvider, LLMRequest, LLMResponse } from "./interfaces/llm-provider.js";

export type ModelClass = LLMRequest["model_class"];

export interface LlmCheckDeps {
  provider: LLMProvider;
  /** The configured `plugins.llm` name. LLMProvider has no name of its own. */
  providerName: string;
  modelClass: ModelClass;
  scanner: EgressScanner;
  clock: Clock;
  /** Receives each line after the scan. Default: nothing printed. */
  print?: (line: string) => void;
}

export interface LlmCheckResult {
  ok: boolean;
  /** One line, scanned: why the check failed, or null when it passed. */
  reason: string | null;
  /** The last line printed: `llm-check ok: ...` or `llm-check FAIL: <reason>`. Reused by `doctor --llm`. */
  summary: string;
  /** Every printed line, in order, as printed (scanned). */
  lines: string[];
}

export const PLAIN_PROMPT = "Reply with the word ok";
export const SCHEMA_PROMPT = "return ok true and n = 2+3";
export const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { ok: { type: "boolean" }, n: { type: "number" } },
  required: ["ok", "n"],
  additionalProperties: false,
};

const CLASSES: readonly ModelClass[] = ["cheap", "standard", "strong"];

/** `[--model cheap|standard|strong]`; default cheap. Anything else is an error with a one-line reason. */
export function parseLlmCheckArgs(args: readonly string[]): { model: ModelClass } | { error: string } {
  let model: ModelClass = "cheap";
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a !== "--model") return { error: `llm-check: unknown argument "${a}"; usage: llm-check [--model cheap|standard|strong]` };
    const v = args[++i];
    if (!CLASSES.includes(v as ModelClass)) {
      return { error: `llm-check: --model must be cheap, standard or strong, got ${v === undefined ? "nothing" : `"${v}"`}` };
    }
    model = v as ModelClass;
  }
  return { model };
}

/** The fixed schema `{ ok: boolean, n: number }`, checked by hand: no extra keys, no missing ones. */
export function matchesSchema(parsed: unknown): parsed is { ok: boolean; n: number } {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const o = parsed as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return keys.length === 2 && keys[0] === "n" && keys[1] === "ok" && typeof o.ok === "boolean" && typeof o.n === "number" && Number.isFinite(o.n);
}

type Outcome = { response: LLMResponse; elapsed_ms: number } | { error: string; elapsed_ms: number };

export async function runLlmCheck(deps: LlmCheckDeps): Promise<LlmCheckResult> {
  const { provider, providerName, modelClass, scanner, clock } = deps;
  const lines: string[] = [];
  const print = async (line: string) => {
    const out = await scanLine(scanner, line);
    lines.push(out);
    deps.print?.(out);
    return out;
  };
  const field = (s: string) => scanField(scanner, s);

  const call = async (req: LLMRequest): Promise<Outcome> => {
    const start = clock.now().getTime();
    try {
      const response = await provider.complete(req);
      return { response, elapsed_ms: clock.now().getTime() - start };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err), elapsed_ms: clock.now().getTime() - start };
    }
  };
  const base = { model_class: modelClass, max_tokens: 64, data_env: "test" as const };
  const plain = await call({ ...base, messages: [{ role: "user", content: PLAIN_PROMPT }] });
  const schema = await call({ ...base, messages: [{ role: "user", content: SCHEMA_PROMPT }], output_schema: OUTPUT_SCHEMA });

  const reasons: string[] = [];
  for (const [label, o] of [["plain", plain], ["schema", schema]] as const) {
    const head = `${label}: provider=${providerName} model=${modelClass}`;
    if ("error" in o) {
      const msg = await field(o.error);
      await print(`${head} stop_reason=none elapsed_ms=${o.elapsed_ms} input_tokens=unknown output_tokens=unknown cost=unknown parsed=n/a error=${msg}`);
      reasons.push(`${label} request threw: ${msg}`);
      continue;
    }
    const r = o.response;
    const parsedState = label === "plain" ? "n/a" : matchesSchema(r.parsed) ? "matches" : "mismatch";
    const cost = r.usage.cost_usd === null ? "unknown" : `$${r.usage.cost_usd}`;
    await print(
      `${head} stop_reason=${r.stop_reason} elapsed_ms=${o.elapsed_ms} input_tokens=${r.usage.input_tokens} ` +
        `output_tokens=${r.usage.output_tokens} cost=${cost} parsed=${parsedState}`,
    );
    if (r.stop_reason !== "end") {
      reasons.push(`${label} request stop_reason ${r.stop_reason}: ${(await field(r.text)) || "(no text)"}`);
    } else if (label === "schema") {
      if (!matchesSchema(r.parsed)) reasons.push("schema request: parsed does not match the schema { ok: boolean, n: number }");
      else if (r.parsed.n !== 5) reasons.push(`schema request: n is ${r.parsed.n}, expected 5`);
    }
  }

  const reason = reasons[0] ?? null;
  const summary = await print(
    reason === null ? `llm-check ok: ${providerName} ${modelClass}, both requests end, n = 5` : `llm-check FAIL: ${reason}`,
  );
  return { ok: reason === null, reason: reason === null ? null : await scanLine(scanner, reason), summary, lines };
}

/**
 * Builds the configured provider, scanner and clock through the registry (Plugins), then runs the check.
 * A provider that fails to build is reported like a failed call: scanned, one line, exit 1.
 */
export async function llmCheckFromPlugins(
  p: Plugins,
  modelClass: ModelClass,
  print?: (line: string) => void,
): Promise<LlmCheckResult> {
  const secrets = await p.secrets();
  const scanner = await p.scanner(secrets);
  const clock = await p.clock();
  const providerName = p.loaded.plugins.llm;
  let provider: LLMProvider;
  try {
    provider = await p.llm(secrets);
  } catch (err) {
    const reason = await scanLine(scanner, `could not build LLM provider "${providerName}": ${err instanceof Error ? err.message : String(err)}`);
    const summary = await scanLine(scanner, `llm-check FAIL: ${reason}`);
    print?.(summary);
    return { ok: false, reason, summary, lines: [summary] };
  }
  return runLlmCheck({ provider, providerName, modelClass, scanner, clock, ...(print ? { print } : {}) });
}

function withheld(findings: readonly { rule: string }[]): string {
  return `[withheld: ${[...new Set(findings.map((f) => f.rule))].join(", ")}]`;
}

/** One untrusted field: itself, or the withheld marker in its place. */
async function scanField(scanner: EgressScanner, s: string): Promise<string> {
  const r = await scanner.scan("log", s);
  return r.clean ? s : withheld(r.findings);
}

/** The whole line, last: a finding anywhere withholds the line, so nothing unscanned is ever printed. */
async function scanLine(scanner: EgressScanner, line: string): Promise<string> {
  const r = await scanner.scan("log", line);
  return r.clean ? line : withheld(r.findings);
}

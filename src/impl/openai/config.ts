// The `openai_compatible` block of factory.config.json: where an OpenAI-style chat completions endpoint lives
// and which model name each class maps to. loadConfig checks it (checkConfigKeys, src/config-keys.ts); no
// plugin reads it yet, so it is validated but not carried into Loaded.

export const OPENAI_COMPATIBLE_KEYS = ["base_url", "models"] as const;
export const OPENAI_COMPATIBLE_MODELS_KEYS = ["cheap", "standard", "strong"] as const;

export interface OpenAICompatibleConfig {
  /** The API root, e.g. "https://api.example.com/v1". `/chat/completions` is appended. */
  base_url: string;
  /** A model name per class. */
  models: { cheap: string; standard: string; strong: string };
}

/** Hosts where plain http is allowed: the request never leaves the machine. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The problem with a base_url, or undefined when it is fine. */
export function baseUrlProblem(value: unknown): string | undefined {
  const at = "openai_compatible.base_url";
  if (value === undefined) return `${at} is required`;
  if (typeof value !== "string" || value.trim() === "") return `${at} must be a non-empty URL string`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${at} is not a valid URL (got ${JSON.stringify(value)})`;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `${at} must use http or https (got ${JSON.stringify(url.protocol.replace(/:$/, ""))})`;
  }
  if (url.protocol === "http:" && !(LOOPBACK_HOSTS as readonly string[]).includes(url.hostname)) {
    return `${at} may use plain http only for ${LOOPBACK_HOSTS.join(", ")}; use https for ${JSON.stringify(url.hostname)}`;
  }
  return undefined;
}

/**
 * Value problems of the `openai_compatible` block, one message each, every message naming its full path.
 * Absent block: none. Unknown keys inside the block are reported by unknownConfigKeys, not here.
 */
export function openaiCompatibleProblems(raw: unknown): string[] {
  if (!isObject(raw) || raw.openai_compatible === undefined) return [];
  const block = raw.openai_compatible;
  if (!isObject(block)) return ["openai_compatible must be an object with base_url and models"];
  const problems: string[] = [];
  const url = baseUrlProblem(block.base_url);
  if (url) problems.push(url);
  const models = block.models;
  if (models === undefined) {
    problems.push("openai_compatible.models is required, with cheap, standard and strong");
  } else if (!isObject(models)) {
    problems.push("openai_compatible.models must be an object with cheap, standard and strong");
  } else {
    for (const k of OPENAI_COMPATIBLE_MODELS_KEYS) {
      const v = models[k];
      if (v === undefined) problems.push(`openai_compatible.models.${k} is required`);
      else if (typeof v !== "string" || v.trim() === "") problems.push(`openai_compatible.models.${k} must be a non-empty model name`);
    }
  }
  return problems;
}

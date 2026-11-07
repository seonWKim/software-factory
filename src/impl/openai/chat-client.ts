// A shared client for an OpenAI-style chat completions endpoint (`POST <base_url>/chat/completions`).
// It uses the platform's global fetch, no vendor SDK. The API key is an argument: this client never reads
// secrets. One request per call: no retries, no streaming, no tool execution. Every failure is returned,
// never thrown, and no returned or thrown text contains the key.

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The request body. Fields beyond model and messages pass through as given (tools, response_format, ...). */
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  temperature?: number;
  max_tokens?: number;
}

export interface ChatUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface ChatSuccess {
  ok: true;
  /** The first choice's message text; "" when the message has no text (tool calls only). */
  text: string;
  /** The first choice's tool calls; [] when there are none. */
  tool_calls: ChatToolCall[];
  usage: ChatUsage;
  /** The model the response reports. */
  model: string;
}

/**
 * - `provider_setup`: a non-2xx whose body's `error.code` (or `error.type`) is one of PROVIDER_SETUP_CODES, at any
 *   HTTP status (a 429 `insufficient_quota` too): the account or config needs a person, waiting does not help.
 * - `rate_limited`: any other HTTP 429. `reset_at` (ISO-8601 UTC) when Retry-After gave seconds or an HTTP date.
 * - `aborted`: the caller's AbortSignal fired.
 * - `http_error`: any other non-2xx status.
 * - `network_error`: no HTTP response (connection refused, reset, DNS).
 * - `bad_response`: a 2xx whose body is not a chat completion.
 */
export type ChatFailureCode = "provider_setup" | "rate_limited" | "aborted" | "http_error" | "network_error" | "bad_response";

/** The provider error codes that need a person to fix the account or the config (design §5 Restarts). */
const PROVIDER_SETUP_CODES: readonly string[] = ["insufficient_quota", "invalid_api_key", "model_not_found"];

export interface ChatFailure {
  ok: false;
  code: ChatFailureCode;
  /** The HTTP status, when there was a response. */
  status?: number;
  reset_at?: string;
  /** What went wrong, for logs, with the provider's own message when its body had one. The API key is redacted from it. */
  message: string;
}

export type ChatResult = ChatSuccess | ChatFailure;

export interface ChatCallOptions {
  /** The configured base_url (openai_compatible.base_url). */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>`. Read by the caller, never by this client. */
  apiKey: string;
  request: ChatRequest;
  signal?: AbortSignal;
  /** Milliseconds since the epoch, for Retry-After in seconds. Absent: Date.now. */
  now?: () => number;
}

/** `<base_url>/chat/completions`, with no double slash whatever the base_url ends with. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/** reset_at from a Retry-After header: seconds from `nowMs`, or an HTTP date. Undefined when absent or unparsable. */
export function retryAfterResetAt(header: string | null, nowMs: number): string | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return new Date(nowMs + Number(value) * 1000).toISOString();
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : new Date(date).toISOString();
}

const MAX_DETAIL = 300;

function redact(text: string, key: string): string {
  return key === "" ? text : text.split(key).join("[redacted]");
}

/** The body's `error` object: its code (or type, as some providers send only that) and message. */
function providerError(bodyText: string): { code: string; message: string } {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return { code: "", message: "" };
  }
  const e = isObject(body) && isObject(body.error) ? body.error : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return { code: str(e.code) || str(e.type), message: str(e.message).trim() };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function parseSuccess(body: unknown): ChatSuccess | string {
  if (!isObject(body)) return "response body is not a JSON object";
  const choices = body.choices;
  if (!Array.isArray(choices) || choices.length === 0 || !isObject(choices[0])) return "response has no choices";
  const message = choices[0].message;
  if (!isObject(message)) return "response choice has no message";
  const rawCalls = message.tool_calls ?? [];
  if (!Array.isArray(rawCalls)) return "response tool_calls is not a list";
  const tool_calls: ChatToolCall[] = [];
  for (const c of rawCalls) {
    if (!isObject(c) || !isObject(c.function) || typeof c.function.name !== "string") return "response has a malformed tool call";
    tool_calls.push({
      id: typeof c.id === "string" ? c.id : "",
      type: "function",
      function: { name: c.function.name, arguments: typeof c.function.arguments === "string" ? c.function.arguments : "" },
    });
  }
  const usage = isObject(body.usage) ? body.usage : {};
  return {
    ok: true,
    text: typeof message.content === "string" ? message.content : "",
    tool_calls,
    usage: { input_tokens: count(usage.prompt_tokens), output_tokens: count(usage.completion_tokens) },
    model: typeof body.model === "string" ? body.model : "",
  };
}

function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  const causeText = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return causeText ? `${err.message}: ${causeText}` : err.message;
}

/** One chat completion. Returns a ChatResult; never throws. */
export async function chatCompletion(opts: ChatCallOptions): Promise<ChatResult> {
  const { apiKey, signal } = opts;
  const now = opts.now ?? Date.now;
  const fail = (code: ChatFailureCode, message: string, extra: Partial<ChatFailure> = {}): ChatFailure => ({
    ok: false,
    code,
    ...extra,
    message: redact(message, apiKey),
  });
  const aborted = () => fail("aborted", "the request was aborted");

  if (signal?.aborted) return aborted();
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(opts.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(opts.request),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) return aborted();
    return fail("network_error", `request failed: ${errorText(err)}`);
  }

  let bodyText: string;
  try {
    bodyText = await res.text();
  } catch (err) {
    if (signal?.aborted) return aborted();
    return fail("network_error", `reading the response failed: ${errorText(err)}`, { status: res.status });
  }

  if (res.status < 200 || res.status > 299) {
    // The key is redacted before the cap, so a cut can never leave part of it.
    const capped = (text: string) => redact(text, apiKey).slice(0, MAX_DETAIL);
    const provider = providerError(bodyText);
    const said = provider.message ? `: ${capped(provider.message)}` : "";
    if (PROVIDER_SETUP_CODES.includes(provider.code)) {
      return fail("provider_setup", `${provider.code} (HTTP ${res.status})${said}`, { status: res.status });
    }
    if (res.status === 429) {
      const reset_at = retryAfterResetAt(res.headers.get("retry-after"), now());
      return fail("rate_limited", `rate limited (HTTP 429)${said}`, { status: 429, ...(reset_at ? { reset_at } : {}) });
    }
    const detail = capped(bodyText.trim());
    return fail("http_error", `HTTP ${res.status}${detail ? `: ${detail}` : ""}`, { status: res.status });
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return fail("bad_response", `HTTP ${res.status} body is not JSON`, { status: res.status });
  }
  const parsed = parseSuccess(body);
  if (typeof parsed === "string") return fail("bad_response", parsed, { status: res.status });
  // The response is the provider's text; scrub the key from it like from any other text this returns.
  return {
    ...parsed,
    text: redact(parsed.text, apiKey),
    model: redact(parsed.model, apiKey),
    tool_calls: parsed.tool_calls.map((c) => ({
      ...c,
      id: redact(c.id, apiKey),
      function: { name: redact(c.function.name, apiKey), arguments: redact(c.function.arguments, apiKey) },
    })),
  };
}

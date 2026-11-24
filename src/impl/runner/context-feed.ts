// The context of each model call, read from the Claude CLI's stream (design 05-restarts, context ceiling). Split
// out of claude-code-runner.ts, which is at its file budget.

/** An unfinished stdout line longer than this is dropped: an assistant event's usage sits near its start, a line that long is a tool result. */
const PARTIAL_LIMIT = 4 * 1024 * 1024;

interface AssistantEvent { type?: unknown; message?: { id?: unknown; usage?: Record<string, unknown> } }

/** One stream event, or null when the line is not a JSON object. */
function parseEvent(line: string): AssistantEvent | null {
  try {
    const v: unknown = JSON.parse(line.trim());
    return v !== null && typeof v === "object" ? (v as AssistantEvent) : null;
  } catch {
    return null;
  }
}

const count =(n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0);

/**
 * A stdout feed that calls `on` once per model call (an `assistant` message id; the CLI prints one event per content
 * block, each with its message's usage) with that call's context: input + cache read + cache write tokens. No `on`: undefined, nothing is read.
 */
export function contextFeed(on: ((tokens: number) => void) | undefined): ((chunk: string) => void) | undefined {
  if (!on) return undefined;
  let partial = "";
  let last: string | null = null;
  return (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    if (partial.length > PARTIAL_LIMIT) partial = "";
    for (const line of lines) {
      // Cheap skip: only assistant events carry a model call's usage.
      if (!line.includes('"assistant"')) continue;
      const event = parseEvent(line);
      const message = event?.type === "assistant" ? event.message : undefined;
      if (typeof message?.id !== "string" || !message.usage || message.id === last) continue;
      last = message.id;
      const u = message.usage;
      on(count(u.input_tokens) + count(u.cache_read_input_tokens) + count(u.cache_creation_input_tokens));
    }
  };
}

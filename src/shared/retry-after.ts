// A Retry-After header read in one place, for every client that honors one (the chat client, the Slack client).

/** reset_at from a Retry-After header: seconds from `nowMs`, or an HTTP date. Undefined when absent or unparsable. */
export function retryAfterResetAt(header: string | null, nowMs: number): string | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;
  if (/^\d+$/.test(value)) return new Date(nowMs + Number(value) * 1000).toISOString();
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : new Date(date).toISOString();
}

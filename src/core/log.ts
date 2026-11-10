/** Fields carry IDs and codes only: never names, secrets or agent output. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

export interface Logger {
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** The text to log for a caught error: an Error gives its message cut to 300 characters; any other value gives "unknown". */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 300) : "unknown";
}

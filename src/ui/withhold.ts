// Free text from the store (titles, reasons, run errors, state-change values) is egress-scanned before it
// reaches the page. EgressScanner reports rules, not spans, so a field with any finding is withheld whole:
// it is replaced by `[withheld: <rule>, ...]` and its text never leaves this module (design §9).

import type { EgressChannel, EgressScanner } from "../interfaces/egress-scanner.js";
import { esc } from "./html.js";

export class Withholder {
  constructor(private readonly scanner: EgressScanner) {}

  /**
   * Escaped HTML for `value` (cut to `max` characters after the scan, so a cut never hides a finding),
   * or the withheld marker naming the scanner's rules. Empty values show `fallback`.
   */
  async text(
    value: string | null | undefined,
    opts: { channel?: EgressChannel; max?: number; fallback?: string } = {},
  ): Promise<string> {
    if (value === null || value === undefined || value === "") {
      return `<span class="muted">${esc(opts.fallback ?? "unknown")}</span>`;
    }
    const r = await this.plain(value, opts);
    return r.withheld ? `<strong>${esc(r.text)}</strong>` : esc(r.text);
  }

  /**
   * Unescaped text for `value` (cut to `max` after the scan), or the withheld marker naming the scanner's
   * rules, with `withheld` saying which. For non-HTML output (JSON); the caller escapes it for HTML.
   */
  async plain(value: string, opts: { channel?: EgressChannel; max?: number } = {}): Promise<{ text: string; withheld: boolean }> {
    const result = await this.scanner.scan(opts.channel ?? "log", value);
    if (!result.clean) {
      const rules = [...new Set(result.findings.map((f) => f.rule))].join(", ");
      return { text: `[withheld: ${rules}]`, withheld: true };
    }
    const max = opts.max ?? Infinity;
    return { text: value.length > max ? `${value.slice(0, max)}…` : value, withheld: false };
  }
}

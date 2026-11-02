import type { EgressChannel, EgressScanner, ScanResult } from "../../interfaces/egress-scanner.js";

const PATTERNS: readonly { rule: string; re: RegExp }[] = [
  { rule: "github_token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/ },
  { rule: "github_pat", re: /\bgithub_pat_[A-Za-z0-9_]{40,}/ },
  { rule: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { rule: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { rule: "private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "factory_canary", re: /sf-canary-[a-z0-9]{8,}/ },
];

const MIN_KNOWN_LENGTH = 8;

const ASSIGNMENT = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=(.*)$/;
/** After `NAME=`: nothing, an empty quoted string, and optionally a ` # comment` after whitespace. */
const BLANK_VALUE = /^(?:\s*(?:""|''))?(?:\s*|\s+#.*)$/;

/**
 * The value check for `.env.example` (architecture §5): the 1-based numbers of the lines that are not blank, not
 * a `#` comment and not a `NAME=` with an empty value. `export NAME=value`, `NAME="value"` and `NAME=#value` are
 * values; any line that is not an assignment is reported too, so a value cannot hide in another syntax. Returns
 * line numbers only, never the text, so a caller can report a finding without echoing a secret.
 */
export function envExampleValueLines(text: string): number[] {
  const bad: number[] = [];
  text.split("\n").forEach((raw, i) => {
    const line = raw.replace(/\r$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const m = ASSIGNMENT.exec(line);
    if (!m || !BLANK_VALUE.test(m[1]!)) bad.push(i + 1);
  });
  return bad;
}

/** G5. Known secret values (exact match) + common secret patterns. Findings never include the matched text. */
export class PatternEgressScanner implements EgressScanner {
  constructor(private readonly knownValues: () => Promise<readonly string[]>) {}

  async scan(channel: EgressChannel, content: string): Promise<ScanResult> {
    const findings: { rule: string; channel: EgressChannel }[] = [];
    for (const value of await this.knownValues()) {
      if (value.length >= MIN_KNOWN_LENGTH && content.includes(value)) {
        findings.push({ rule: "known_secret", channel });
        break;
      }
    }
    for (const { rule, re } of PATTERNS) {
      if (re.test(content)) findings.push({ rule, channel });
    }
    return findings.length === 0 ? { clean: true } : { clean: false, findings };
  }
}

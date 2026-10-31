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

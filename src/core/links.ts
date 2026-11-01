// Pure matchers for revert and fix-forward links (design §6). No store: the controller looks the
// numbers and shas up and decides whether they name a factory item.

export interface RevertRefs {
  /** Shas from `This reverts commit <sha>` anywhere in the message. */
  shas: string[];
  /** Candidate original PR numbers: `#N` in a subject that starts with `Revert`, minus the reverting PR. */
  pr_numbers: number[];
  /** The squash-merge suffix `(#M)` at the end of the subject: the PR that did the revert. */
  reverting_pr: number | null;
}

/** What a base-branch commit message says it reverts. */
export function parseRevert(message: string): RevertRefs {
  const shas = unique([...message.matchAll(/This reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1]!.toLowerCase()));
  const subject = (message.split(/\r?\n/, 1)[0] ?? "").trim();
  const isRevertSubject = /^revert\b/i.test(subject);
  const suffix = /\(#(\d+)\)\s*$/.exec(subject);
  // Only a revert has a reverting PR: a revert subject, or any subject over a `This reverts commit` body.
  const reverting_pr = suffix && (isRevertSubject || shas.length > 0) ? Number(suffix[1]) : null;
  if (!isRevertSubject) return { shas, pr_numbers: [], reverting_pr };
  const named = suffix ? subject.slice(0, suffix.index) : subject;
  const pr_numbers = unique([...named.matchAll(/#(\d+)\b/g)].map((m) => Number(m[1])));
  return { shas, pr_numbers, reverting_pr };
}

/** PR numbers named by `Fixes #N` or `Follow-up to #N` (also `Follow up to`), in order of first mention. */
export function parseFixReferences(text: string): number[] {
  return unique([...text.matchAll(/(?<![\w-])(?:fixes|follow[- ]up to)\s+#(\d+)\b/gi)].map((m) => Number(m[1])));
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

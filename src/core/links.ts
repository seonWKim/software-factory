// The generic shape of revert and fix-forward links (design §6), shared by every forge's `parseLinks`. A forge says
// what one of its change refs looks like; these helpers find the git revert body, the `Revert` subject and the
// `Fixes` / `Follow-up to` keywords around it. No store: the controller looks the shas and refs up.

/** Shas from `This reverts commit <sha>` anywhere in the message (what `git revert` writes), lowercased, in order. */
export function revertedShas(message: string): string[] {
  return unique([...message.matchAll(/This reverts commit ([0-9a-f]{7,40})\b/gi)].map((m) => m[1]!.toLowerCase()));
}

/** The message's first line, trimmed. */
export function subjectOf(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? "").trim();
}

/** Whether a subject says it is a revert: it starts with `Revert`. */
export function isRevertSubject(subject: string): boolean {
  return /^revert\b/i.test(subject);
}

/**
 * The change refs named by `Fixes <ref>` or `Follow-up to <ref>` (also `Follow up to`), case-insensitive, in order of
 * first mention. `ref` is the forge's pattern for one change ref, its first group the ref itself.
 */
export function fixReferences(text: string, ref: RegExp): string[] {
  const re = new RegExp(`(?<![\\w-])(?:fixes|follow[- ]up to)\\s+${ref.source}`, "gi");
  return unique([...text.matchAll(re)].map((m) => m[1]!));
}

export function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

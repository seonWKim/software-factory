// What `factory cleanup` prints (design 08-cleanup): each resource that went (a dry run: would go), with its size
// when it has one, each kept resource with its reason, and each failed removal.

import type { PassResult } from "./sweep.js";

function size(bytes: number | null): string {
  if (bytes === null) return "";
  const mb = bytes / 1_048_576;
  return mb >= 1024 ? ` (${(mb / 1024).toFixed(1)} GB)` : ` (${mb.toFixed(1)} MB)`;
}

export function reportLines(r: PassResult, dryRun: boolean): string[] {
  const lines: string[] = [];
  if (!dryRun && r.removed.length === 0 && r.kept.length === 0 && r.failed.length === 0) return ["cleanup: nothing to remove on this host."];
  lines.push(dryRun ? "Would remove:" : "Removed:");
  for (const x of r.removed) lines.push(`  ${x.resource.label}${size(x.bytes)}`);
  if (r.removed.length === 0) lines.push("  nothing");
  if (r.failed.length > 0) {
    lines.push("Failed (the next sweep tries again):");
    for (const x of r.failed) lines.push(`  ${x.resource.label}: ${x.error}`);
  }
  if (r.kept.length > 0) {
    lines.push("Kept:");
    for (const x of r.kept) lines.push(`  ${x.resource.label}: ${x.reason}`);
  }
  if (!dryRun) {
    const freed = r.removed.reduce((n, x) => n + (x.bytes ?? 0), 0);
    if (freed > 0) lines.push(`Freed${size(freed)}.`);
  } else lines.push("Dry run: nothing was removed.");
  return lines;
}

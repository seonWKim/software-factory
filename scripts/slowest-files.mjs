#!/usr/bin/env node
// Prints the 10 slowest test files from a vitest JSON report (docs/design/05-ci-gate.md, Slowest files).
// Usage: node scripts/slowest-files.mjs <report.json>. A report that is missing or unreadable prints a note and
// exits 0: the report only informs, it never fails the job.
import { readFileSync } from "node:fs";
import { relative } from "node:path";

const TOP = 10;
const file = process.argv[2] ?? "test-report.json";

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.log(`No slowest-files report: cannot read ${file} (${e instanceof Error ? e.message : String(e)}).`);
  process.exit(0);
}

const files = (Array.isArray(report?.testResults) ? report.testResults : [])
  .filter((r) => typeof r?.name === "string" && Number.isFinite(r.startTime) && Number.isFinite(r.endTime))
  .map((r) => ({ name: relative(process.cwd(), r.name), ms: r.endTime - r.startTime }))
  .sort((a, b) => b.ms - a.ms)
  .slice(0, TOP);

if (files.length === 0) {
  console.log(`No slowest-files report: ${file} lists no test files with a duration.`);
  process.exit(0);
}
console.log(`The ${files.length} slowest test files:`);
for (const [i, f] of files.entries()) console.log(`${String(i + 1).padStart(2)}. ${(f.ms / 1000).toFixed(1).padStart(6)} s  ${f.name}`);

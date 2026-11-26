// The project's JDK major for the merge check: read from the merged commit (`.java-version`, else the Gradle toolchain
// `JavaLanguageVersion.of(N)` in the root build.gradle or build.gradle.kts) and compared with the worker's own JDK
// (`$JAVA_HOME/bin/java` when JAVA_HOME is set, else `java` on PATH), probed inside the run folder's sandbox as the
// Node probe is (node-version.ts). A different major, or no JDK at all, fails the run with checks_env naming both, so
// a wrong JDK is an environment failure, not a failing check. No JDK is looked up or installed; a project naming no
// JDK reads none.

import { RunFailure } from "../../support.js";
import type { RunCall } from "../../run-kind.js";
import type { Worker } from "../../runner.js";

type SandboxHandle = NonNullable<RunCall["handle"]>;
/** core/policy.ts CHECKS_ENV, spelled out so this component adds no import from a legacy folder. */
const CHECKS_ENV = "checks_env";

/** Where the project's JDK major came from. */
export interface JdkWant {
  major: string;
  from: ".java-version" | "build.gradle" | "build.gradle.kts";
}

/** The JDK major of `17`, `17.0.2`, `temurin-21.0.1`, `1.8` or `1.8.0_292` (old `1.N` spelling: N); null when none. */
export function jdkMajor(text: string): string | null {
  const m = /(\d+)(?:\.(\d+))?/.exec(text.trim().split("\n")[0]!);
  if (!m) return null;
  return String(Number(m[1] === "1" && m[2] !== undefined ? m[2] : m[1]));
}

/** The major of a `java -version` line (`openjdk version "17.0.2" 2022-01-18`); null when no version is quoted. */
export function javaVersionMajor(line: string): string | null {
  const m = /version "([^"]+)"/.exec(line);
  return m ? jdkMajor(m[1]!) : null;
}

/** The Gradle toolchain's major in a build file (`JavaLanguageVersion.of(17)`); null when none. */
export function gradleToolchainMajor(text: string): string | null {
  const m = /JavaLanguageVersion\s*\.\s*of\s*\(\s*["']?(\d+)["']?\s*\)/.exec(text);
  return m ? String(Number(m[1])) : null;
}

/** A file of the merged commit, or null when it is not there. */
async function readAt(w: Worker, handle: SandboxHandle, sha: string, path: string): Promise<string | null> {
  const r = await w.gitRaw(handle, ["cat-file", "blob", `${sha}:${path}`]);
  return r.exit_code === 0 ? r.stdout : null;
}

/** The project's JDK major: `.java-version` first, then the root Gradle toolchain; null when none names one. */
export async function projectJdk(w: Worker, handle: SandboxHandle, sha: string): Promise<JdkWant | null> {
  const file = await readAt(w, handle, sha, ".java-version");
  const fromFile = file === null ? null : jdkMajor(file);
  if (fromFile) return { major: fromFile, from: ".java-version" };
  for (const from of ["build.gradle", "build.gradle.kts"] as const) {
    const text = await readAt(w, handle, sha, from);
    const major = text === null ? null : gradleToolchainMajor(text);
    if (major) return { major, from };
  }
  return null;
}

/**
 * Prints `current=<the first line of the worker's java -version that quotes a version>` (java writes it to stderr;
 * both are read). The JVM may print `Picked up JAVA_TOOL_OPTIONS: ...` (or `_JAVA_OPTIONS`) first, so the first line
 * is not always the version line.
 */
export const JDK_PROBE = [
  'if [ -n "$JAVA_HOME" ]; then j="$JAVA_HOME/bin/java"; else j=java; fi',
  'echo "current=$("$j" -version 2>&1 | grep -m 1 \'version "\')"',
].join("\n");

/**
 * The worker's JDK major when it is `want.major`. Another major, or no JDK: a checks_env failure naming the major
 * needed and the one found.
 */
export async function checkJdk(w: Worker, handle: SandboxHandle, want: JdkWant): Promise<string> {
  const r = await w.d.sandbox.exec(handle, ["sh", "-c", JDK_PROBE], { env: { ...w.d.toolEnv } });
  const current = `${r.stdout}\n${r.stderr}`.split("\n").find((l) => l.startsWith("current="))?.slice("current=".length).trim() ?? "";
  const found = javaVersionMajor(current);
  if (found === want.major) return found;
  throw new RunFailure(
    CHECKS_ENV,
    `the checks need JDK ${want.major} (from ${want.from}); found ${found ? `JDK ${found}` : "no JDK"} on this worker. Install JDK ${want.major} and point JAVA_HOME at it.`,
  );
}

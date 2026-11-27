import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JDK_PROBE, gradleToolchainMajor, javaVersionMajor, jdkMajor } from "../src/worker/runs/merge-check/jdk-version.js";

describe("jdk-version parsing", () => {
  it("reads the major of a .java-version line, old 1.N spelling included", () => {
    expect(jdkMajor("17\n")).toBe("17");
    expect(jdkMajor("21.0.1")).toBe("21");
    expect(jdkMajor("temurin-17.0.2")).toBe("17");
    expect(jdkMajor("1.8")).toBe("8");
    expect(jdkMajor("system")).toBeNull();
  });

  it("reads the major of a java -version line", () => {
    expect(javaVersionMajor('openjdk version "17.0.2" 2022-01-18')).toBe("17");
    expect(javaVersionMajor('java version "1.8.0_292"')).toBe("8");
    expect(javaVersionMajor('openjdk version "24-ea" 2025-03-18')).toBe("24");
    expect(javaVersionMajor("The operation couldn't be completed. Unable to locate a Java Runtime.")).toBeNull();
    expect(javaVersionMajor("")).toBeNull();
  });

  it("reads the Gradle toolchain in Groovy and Kotlin build files", () => {
    expect(gradleToolchainMajor("languageVersion = JavaLanguageVersion.of(17)")).toBe("17");
    expect(gradleToolchainMajor("languageVersion.set(JavaLanguageVersion.of( 21 ))")).toBe("21");
    expect(gradleToolchainMajor("languageVersion = JavaLanguageVersion.of('11')")).toBe("11");
    expect(gradleToolchainMajor("plugins { id 'java' }")).toBeNull();
  });
});

describe("JDK_PROBE", () => {
  /** Runs the probe against a fake JAVA_HOME whose java prints `lines` to stderr, as the JVM does. */
  function probe(lines: string[]): string {
    const home = mkdtempSync(join(tmpdir(), "jdk-probe-"));
    try {
      mkdirSync(join(home, "bin"));
      const java = join(home, "bin", "java");
      writeFileSync(java, `#!/bin/sh\n${lines.map((l) => `echo '${l}' >&2`).join("\n")}\n`);
      chmodSync(java, 0o755);
      return execFileSync("sh", ["-c", JDK_PROBE], { env: { PATH: process.env.PATH ?? "", JAVA_HOME: home } }).toString();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("keeps the version line when the JVM prints a Picked up JAVA_TOOL_OPTIONS line first", () => {
    const out = probe(["Picked up JAVA_TOOL_OPTIONS: -Dfile.encoding=UTF-8", 'openjdk version "17.0.2" 2022-01-18', "OpenJDK Runtime Environment"]);
    const current = out.split("\n").find((l) => l.startsWith("current="))!.slice("current=".length);
    expect(javaVersionMajor(current)).toBe("17");
  });

  it("reads the first line holding a quoted version", () => {
    const out = probe(['openjdk version "21.0.1" 2023-10-17', "OpenJDK Runtime Environment"]);
    expect(out).toContain('current=openjdk version "21.0.1" 2023-10-17');
  });
});

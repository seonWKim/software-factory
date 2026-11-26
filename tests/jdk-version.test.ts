import { describe, expect, it } from "vitest";
import { gradleToolchainMajor, javaVersionMajor, jdkMajor } from "../src/worker/runs/merge-check/jdk-version.js";

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

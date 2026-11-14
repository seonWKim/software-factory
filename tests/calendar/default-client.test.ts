import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_GOOGLE_CLIENT_ID, DEFAULT_SECRET_MODULE, defaultGoogleClient } from "../../src/calendar/plugins/google-calendar/default-client.js";

// The factory's default Google client (docs/plugins/calendar-source.md, Turn on): its ID is a constant in source, its
// secret comes only from the module the release build writes, which is never tracked. No test calls Google.

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const PLUGIN_DIR = "src/calendar/plugins/google-calendar";
const git = (...args: string[]) => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" });

describe("defaultGoogleClient", () => {
  const injected = (secret: unknown) => async () => ({ DEFAULT_GOOGLE_CLIENT_SECRET: secret });

  it("is the constant ID with the injected secret", async () => {
    expect(await defaultGoogleClient({ id: "id.example", load: injected("s3cr") })).toEqual({ id: "id.example", secret: "s3cr" });
  });

  it("is none when the build injected no secret, an unusable one, or the ID is empty", async () => {
    const missing = async () => {
      throw new Error("Cannot find module");
    };
    for (const load of [missing, injected(undefined), injected(""), injected("has space"), injected(42)]) {
      expect(await defaultGoogleClient({ id: "id.example", load })).toBeNull();
    }
    expect(await defaultGoogleClient({ id: "", load: injected("s3cr") })).toBeNull();
  });

  it("the ID is a named constant, and the default loader reads the injected module beside it", async () => {
    expect(typeof DEFAULT_GOOGLE_CLIENT_ID).toBe("string");
    expect(DEFAULT_SECRET_MODULE).toBe("./default-client-secret.js");
    // With no injected module in this checkout, the default loader finds no client and does not throw.
    if (DEFAULT_GOOGLE_CLIENT_ID === "") expect(await defaultGoogleClient()).toBeNull();
  });
});

describe("no client secret in the repository", () => {
  it("the injected module lives only in the ignored build output, never in the source tree", () => {
    const built = `dist/calendar/plugins/google-calendar/${DEFAULT_SECRET_MODULE.slice(2)}`;
    expect(git("check-ignore", "--no-index", built).trim()).toBe(built);
    expect(git("ls-files", "--", PLUGIN_DIR).split("\n").filter((f) => f.includes("default-client-secret"))).toEqual([]);
  });

  it("no tracked file holds a Google OAuth client secret", () => {
    // Google's client secrets start with this prefix; the pattern is built so this file does not match itself.
    const secret = new RegExp(`${"GOCSPX"}-[A-Za-z0-9_-]{20,}`);
    const flagged = git("ls-files", "-z")
      .split("\0")
      .filter(Boolean)
      .filter((f) => {
        try {
          return secret.test(readFileSync(join(REPO_ROOT, f), "latin1"));
        } catch {
          return false; // a tracked file deleted in the working tree
        }
      });
    expect(flagged).toEqual([]);
  });
});

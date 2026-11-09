import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// Architecture §1: core talks only to interfaces. Core and interfaces may import each other and nothing
// else: no implementations, no vendor packages, no node: I/O. Implementations are picked in src/compose.ts.

const SRC = join(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

function imports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return [...text.matchAll(/^\s*(?:import|export)[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]!);
}

describe("layer boundaries", () => {
  for (const layer of ["core", "interfaces"]) {
    it(`${layer}/ imports only core/ and interfaces/`, () => {
      const violations: string[] = [];
      for (const file of files(join(SRC, layer))) {
        for (const spec of imports(file)) {
          const ok = spec.startsWith(".") && /^(core|interfaces)\//.test(relative(SRC, join(file, "..", spec)));
          if (!ok) violations.push(`${relative(SRC, file)} → ${spec}`);
        }
      }
      expect(violations).toEqual([]);
    });
  }
});

// Core and interfaces are forge-neutral: their comments, messages and agent prompts say "the forge", "the source"
// or "change", never GitHub or "pull request". A line may still match when it names a stored value, a tool ID or a
// code name that must not be renamed: each such token is allowed only in the files listed, with its reason.

const FORGE_WORDS = /github|api\.github\.com|pull request/i;

interface Allowed {
  readonly token: RegExp;
  readonly files: readonly string[];
  readonly reason: string;
}

const ALLOWED: readonly Allowed[] = [
  { token: /\bgithub_issue\b/g, files: ["interfaces/forge.ts"], reason: "stored source type of GitHub items and its `intake:github_issue` cursor name" },
  { token: /\bgithub_rate_limit(?:ed)?\b/g, files: ["core/types.ts", "core/policy.ts", "interfaces/factory-store.ts"], reason: "stored run error code `github_rate_limited` and claim pause name `github_rate_limit`" },
  { token: /\bGITHUB_RATE_LIMIT(?:ED)?\b/g, files: ["core/policy.ts"], reason: "exported constant names of that error code and claim pause" },
  { token: /\bgithubRateLimit(?:Message|Reset)\b/g, files: ["core/policy.ts"], reason: "exported function names the GitHub broker calls" },
  { token: /["`]github\.\w+["`]/g, files: ["interfaces/tool-broker.ts"], reason: "the old tool name `github.preflight`, an alias of `forge.preflight`" },
  { token: /["`]github["`]/g, files: ["core/project.ts", "core/command-inbox.ts", "interfaces/auth-provider.ts"], reason: "stored provider name of identities and project keys" },
  { token: /\(github\|slack\|oidc\)/g, files: ["core/authorize.ts"], reason: "the stored provider names a user ID may carry" },
  { token: /\bgithub:/g, files: ["core/project.ts", "core/command-inbox.ts", "core/authorize.ts"], reason: "prefix of stored values: project keys, comment inbox keys and actors, user IDs, the `github:budget` cursor" },
  { token: /\bgithubProjectKey\b/g, files: ["core/project.ts"], reason: "exported function name" },
  { token: /\b(?:githubCommentKey|githubCommand|GITHUB_KEY|GITHUB_ACTOR)\b/g, files: ["core/command-inbox.ts"], reason: "exported function names and the code names of their key patterns" },
  { token: /\bGitHubBudgetStatus\b/g, files: ["core/controller-deps.ts"], reason: "exported type name of the GitHub call budget" },
  { token: /\b(?:GitHubCredentials|GitHubApi|GitHubAccess)\b/g, files: ["interfaces/github-credentials.ts"], reason: "exported interface names: the credentials, the forge client every plugin shares, and the credential plugin's build of both" },
  { token: /\bGitHubBudgetStatus\b/g, files: ["interfaces/github-credentials.ts"], reason: "the client's budget type, exported by core/controller-deps.ts, as GitHubApi.status returns it" },
  { token: /"GitHub rate limit, calls resume at "/g, files: ["core/policy.ts"], reason: "marker stored in run outcome details; githubRateLimitReset parses it back from runs stored before this change" },
  { token: /"src\/impl\/github\/github(?:-auth-provider\.ts|\.plugin\.ts)"/g, files: ["core/improver.ts", "core/standing.ts"], reason: "gate paths of the moved GitHub auth files (`src/impl/github/github-auth-provider.ts`, `src/impl/github/github.plugin.ts`)" },
  { token: /"src\/impl\/github\/(?:github-tool-broker|broker\.plugin)\.ts"/g, files: ["core/standing.ts"], reason: "gate paths of the default ToolBroker's files (a guard, runtime review H3)" },
];

/** Every line of `sources` (paths relative to src/) that matches FORGE_WORDS once its file's allowed tokens are removed. */
function forgeWordViolations(sources: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    const tokens = ALLOWED.filter((a) => a.files.includes(path)).map((a) => a.token);
    text.split("\n").forEach((line, i) => {
      const rest = tokens.reduce((l, t) => l.replace(t, ""), line);
      if (FORGE_WORDS.test(rest)) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

function layerSources(): { path: string; text: string }[] {
  return ["core", "interfaces"].flatMap((layer) =>
    files(join(SRC, layer)).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") })),
  );
}

describe("forge-neutral wording", () => {
  it("core/ and interfaces/ name GitHub or pull requests only through allow-listed tokens", () => {
    expect(forgeWordViolations(layerSources())).toEqual([]);
  });

  it("fails on a fixture file under src/core that holds github_issue, which is allowed only in its own files", () => {
    const line = 'const type = "github_issue";';
    expect(forgeWordViolations([{ path: "core/fixture.ts", text: line }])).toEqual([`core/fixture.ts:1: ${line}`]);
    expect(forgeWordViolations([{ path: "interfaces/forge.ts", text: line }])).toEqual([]);
  });

  it("fails on GitHub and pull request prose in either layer", () => {
    const text = "// posted on GitHub\n// the pull request\n// the change";
    expect(forgeWordViolations([{ path: "interfaces/forge.ts", text }])).toEqual([
      "interfaces/forge.ts:1: // posted on GitHub",
      "interfaces/forge.ts:2: // the pull request",
    ]);
  });

  it("every allow-list entry has a reason and is still used in each file it lists", () => {
    const sources = new Map(layerSources().map((s) => [s.path, s.text]));
    const unused = ALLOWED.flatMap((a) =>
      a.files.filter((f) => !(sources.get(f) ?? "").match(a.token)).map((f) => `${a.token} in ${f}`),
    );
    expect(unused).toEqual([]);
    expect(ALLOWED.filter((a) => a.reason.trim() === "")).toEqual([]);
  });
});

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
  { token: /["`]github["`]/g, files: ["core/project.ts", "core/command-inbox.ts", "interfaces/auth-provider.ts"], reason: "stored provider name of identities and project keys" },
  { token: /\bgithub:/g, files: ["core/command-inbox.ts"], reason: "prefix of stored values: project keys, comment inbox keys and actors, the `github:budget` cursor" },
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

// GitHub code lives in src/impl/github/ (design 08-plugins). Checked scope: every file under src/ outside it. None
// may import from it or name GitHub's API host, but the files exempted below, each with its reason; core/ and
// interfaces/ have no exemption. Moving each exempt file's GitHub part into src/impl/github/ is a follow-up.

const GITHUB_DIR = "impl/github/";

interface Exempt {
  readonly file: string;
  readonly reason: string;
}

const GITHUB_EXEMPT: readonly Exempt[] = [
  { file: "compose.ts", reason: "composition root: the forge descriptor's resolveProject for the CLI, the RepoRef type, and GitHub's settings checked only when a GitHub plugin is selected" },
  { file: "setup.ts", reason: "`npm run setup` and doctor check GitHub's status labels and errors (follow-up: move into src/impl/github/)" },
  { file: "cli/handlers/ui/ui.command.ts", reason: "the status page names the forge budget's plugin (follow-up: move into src/impl/github/)" },
  { file: "impl/source/slack-source.ts", reason: "the RepoRef type of the configured repo (follow-up: a forge-neutral repo type)" },
  { file: "impl/source/slack-format.ts", reason: "the RepoRef type of the configured repo (follow-up: a forge-neutral repo type)" },
  { file: "impl/network-probe/http-network-probe.ts", reason: "the network probe's GitHub endpoint (follow-up: the forge plugin names it)" },
];

/** Every import of `text` (static, re-export, dynamic, type-only), as written. */
function allImports(text: string): string[] {
  return [...text.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm)].map((m) => m[1]!);
}

/** Each file of `sources` (paths relative to src/) that imports from src/impl/github/ or names api.github.com. */
function githubCodeViolations(sources: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (path.startsWith(GITHUB_DIR) || GITHUB_EXEMPT.some((e) => e.file === path)) continue;
    for (const spec of allImports(text)) {
      if (spec.startsWith(".") && relative(SRC, join(SRC, path, "..", spec)).startsWith(GITHUB_DIR)) out.push(`${path} → ${spec}`);
    }
    if (text.includes("api.github.com")) out.push(`${path}: api.github.com`);
  }
  return out;
}

function srcSources(): { path: string; text: string }[] {
  return files(SRC).map((f) => ({ path: relative(SRC, f), text: readFileSync(f, "utf8") }));
}

describe("GitHub code stays in src/impl/github/", () => {
  it("no file outside it imports from it or names api.github.com, but the exempt ones", () => {
    expect(githubCodeViolations(srcSources())).toEqual([]);
  });

  it("fails on a fixture file that imports from src/impl/github/, statically or lazily, or names api.github.com", () => {
    const fixture = [
      'import { GitHubClient } from "../impl/github/github-client.js";',
      'const m = await import("../impl/github/github-forge.js");',
      'const url = "https://api.github.com/repos";',
      'import { x } from "../impl/source/local-source.js";',
    ].join("\n");
    expect(githubCodeViolations([{ path: "core/fixture.ts", text: fixture }])).toEqual([
      "core/fixture.ts → ../impl/github/github-client.js",
      "core/fixture.ts → ../impl/github/github-forge.js",
      "core/fixture.ts: api.github.com",
    ]);
    expect(githubCodeViolations([{ path: "impl/github/fixture.ts", text: fixture }])).toEqual([]);
  });

  it("every exemption has a reason, is outside core/ and interfaces/, and is still needed", () => {
    const sources = new Map(srcSources().map((s) => [s.path, s.text]));
    const unneeded = GITHUB_EXEMPT.filter((e) => githubCodeViolations([{ path: `${e.file}.check`, text: sources.get(e.file) ?? "" }]).length === 0);
    expect(unneeded.map((e) => e.file)).toEqual([]);
    expect(GITHUB_EXEMPT.filter((e) => e.reason.trim() === "" || /^(core|interfaces)\//.test(e.file))).toEqual([]);
  });
});

// Google code lives in the google-calendar plugin's folder (docs/plugins/calendar-source.md): no other src/ file names
// Google, in code, strings or comments, so the provider stays one plugin the factory can drop.

const GOOGLE_DIR = "calendar/plugins/google-calendar/";

/** Each line of `sources` (paths relative to src/) outside GOOGLE_DIR that names Google. */
function googleWordViolations(sources: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (path.split("\\").join("/").startsWith(GOOGLE_DIR)) continue;
    text.split("\n").forEach((line, i) => {
      if (/google/i.test(line)) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

describe("Google stays in src/calendar/plugins/google-calendar/", () => {
  it("no src/ file outside it names google", () => {
    expect(googleWordViolations(srcSources())).toEqual([]);
  });

  it("fails on a fixture file outside it that names google, and passes the same file inside it", () => {
    const text = 'const url = "https://www.googleapis.com/calendar/v3";\n// reads Google Calendar\nconst ok = 1;';
    for (const path of ["core/fixture.ts", "calendar/fixture.ts", "calendar/plugins/other/fixture.ts", "impl/source/fixture.ts"]) {
      expect(googleWordViolations([{ path, text }])).toEqual([
        `${path}:1: const url = "https://www.googleapis.com/calendar/v3";`,
        `${path}:2: // reads Google Calendar`,
      ]);
    }
    expect(googleWordViolations([{ path: `${GOOGLE_DIR}fixture.ts`, text }])).toEqual([]);
  });
});

// Core, interfaces, the status page server (src/ui/) and the dashboard (web/) have no platform branches and no OS
// paths: platform code lives in a plugin (KeepAwake) or a desktop shell (desktop/, docs/design/09-desktop-app.md).
// Full-line comments may name a path. The exemptions below (decision 2 of issue #573) are the known platform code,
// each with its reason; they sit outside the checked layers today, and an exemption is dropped once its file has
// no platform code left.

const REPO = join(SRC, "..");
const PLATFORM_LAYERS = ["src/core/", "src/interfaces/", "src/ui/", "web/"];

const PLATFORM_CODE: readonly RegExp[] = [
  /\bprocess\.platform\b/,
  /\b(?:os\.)?platform\(\)/,
  /\b(?:homedir|userInfo)\(/,
  /["'`](?:darwin|win32)["'`]/,
  /\/Library\/|Application Support|AppData|%APPDATA%|["'`](?:\/Users|\/home)\/|["'`]~\/|[A-Z]:\\\\|\bXDG_[A-Z_]+/,
];

const PLATFORM_EXEMPT: readonly Exempt[] = [
  { file: "src/impl/awake/", reason: "the KeepAwake plugins: caffeinate is the darwin default, none the default elsewhere" },
  { file: "src/plugins.ts", reason: "the registry picks a plugin's per-platform default from process.platform" },
  { file: "src/impl/secrets/", reason: "the env-file SecretStore finds its file under XDG_CONFIG_HOME or the home folder" },
  { file: "src/setup.ts", reason: "setup opens a URL with `open` or `xdg-open` (follow-up: move it into a plugin)" },
];

/** Each code line of `sources` (repo-relative paths) in a checked layer that holds platform code, but exempt files. */
function platformViolations(sources: readonly { path: string; text: string }[]): string[] {
  const out: string[] = [];
  for (const { path, text } of sources) {
    if (!PLATFORM_LAYERS.some((l) => path.startsWith(l)) || PLATFORM_EXEMPT.some((e) => path.startsWith(e.file))) continue;
    text.split("\n").forEach((line, i) => {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
      if (PLATFORM_CODE.some((p) => p.test(line))) out.push(`${path}:${i + 1}: ${line.trim()}`);
    });
  }
  return out;
}

function codeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (["node_modules", "dist"].includes(e.name) ? [] : codeFiles(join(dir, e.name))) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

const repoSources = (dirs: readonly string[]): { path: string; text: string }[] =>
  dirs.flatMap((d) => codeFiles(join(REPO, d)).map((f) => ({ path: relative(REPO, f), text: readFileSync(f, "utf8") })));

describe("no platform code in core, interfaces, ui and web", () => {
  it("src/core, src/interfaces, src/ui and web/ hold no process.platform and no OS path", () => {
    expect(platformViolations(repoSources(PLATFORM_LAYERS))).toEqual([]);
  });

  it("fails on a fixture with a platform branch or an OS path, and passes it in an exempt file or a comment", () => {
    const fixture = [
      'const mac = process.platform === "darwin";',
      'const dir = join(homedir(), "Library", "Application Support");',
      'const data = "/Users/me/Library/Application Support/x";',
      "// a comment may name ~/.config/software-factory/.env",
    ].join("\n");
    for (const layer of PLATFORM_LAYERS) {
      expect(platformViolations([{ path: `${layer}fixture.ts`, text: fixture }]), layer).toHaveLength(3);
    }
    expect(platformViolations([{ path: "src/impl/awake/fixture.ts", text: fixture }])).toEqual([]);
    expect(platformViolations([{ path: "src/ui/fixture.ts", text: 'const os = "macos"; const p = "/api/v1/overview";' }])).toEqual([]);
  });

  it("every exemption has a reason and still holds platform code", () => {
    const stale = PLATFORM_EXEMPT.filter((e) => {
      const files = e.file.endsWith("/") ? codeFiles(join(REPO, e.file)) : [join(REPO, e.file)];
      return !files.some((f) => readFileSync(f, "utf8").split("\n").some((l) => PLATFORM_CODE.some((p) => p.test(l))));
    });
    expect(stale.map((e) => e.file)).toEqual([]);
    expect(PLATFORM_EXEMPT.filter((e) => e.reason.trim() === "")).toEqual([]);
  });
});

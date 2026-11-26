import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_COMMANDS_PLACEHOLDER, FORGE_PLACEHOLDER, SPLIT_PLACEHOLDERS, UI_CHECK_PLACEHOLDER, fillPrompt, loadConfig } from "../src/load-config.js";
import type { FactoryConfig } from "../src/core/config.js";

// These tests check the instruction text only. They cannot prove a model's reply starts with the section.

const HEADING = "In short (AS-IS → TO-BE)";

function prompt(name: string): string {
  return readFileSync(join(import.meta.dirname, "..", "prompts", `${name}.md`), "utf8");
}

/** The text of the top-level bullet that starts with `- <field>:`, up to the next top-level bullet or blank line. */
function bullet(text: string, field: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`- ${field}:`));
  if (start < 0) return "";
  const out = [lines[start]!];
  for (const l of lines.slice(start + 1)) {
    if (l.startsWith("- ") || l.trim() === "") break;
    out.push(l);
  }
  return out.join("\n");
}

describe("prompts/triage.md", () => {
  const text = prompt("triage");

  it("allows the migration paths of the repository's own naming rule for a store schema change, naming no repo path (issues #229, #335)", () => {
    expect(text).toContain("store schema change");
    expect(text).toMatch(/repository's own migration naming rule/);
    expect(text).not.toMatch(/mysql/i);
  });

  it("names a new migration and its test by slug with `<stamp>`, and leaves the free timestamp to the implementer (design 04-triage)", () => {
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("`src/<component>/migrations/<stamp>-<component>-<slug>.migration.ts`");
    expect(flat).toContain("`tests/<stamp>-<component>-<slug>.test.ts`");
    expect(flat).toContain("the implementer takes the next free timestamp");
  });

  it("takes its split caps from placeholders, with no literal default caps", () => {
    for (const p of SPLIT_PLACEHOLDERS) expect(text, p).toContain(p);
    expect(text).not.toMatch(/\b(?:1500|40)\b/);
  });

  it("renders this repo's caps and their 85% split thresholds", async () => {
    const { prompts } = await loadConfig(join(import.meta.dirname, ".."));
    expect(prompts.triage).toContain("caps of 5000 lines and 80 files: over 4250 lines or over 68 files");
    expect(prompts.triage).not.toContain("{{");
  });

  it("its output example uses neutral paths (issue #335)", () => {
    expect(text).toContain('"allowed_paths": ["src/example/"]');
  });
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks which other files a change to these paths requires (issue #224)", () => {
    expect(text).toContain("Which other files does a change to these paths require?");
  });

  it("lists the existing tests that assert text or behaviour the spec changes (decided 2026-11-16)", () => {
    const b = bullet(produce, "files_to_change");
    expect(b).toMatch(/grep the tests for each string the change removes or changes/);
    expect(b).toMatch(/list each matching test file in allowed_paths and files_to_change/);
  });

  it("names the topic files as the documentation targets, not the index (issue #224)", () => {
    const b = bullet(produce, "files_to_change");
    expect(b).toMatch(/topic files the change touches/);
    expect(b).not.toMatch(/Name an index only when/);
    expect(b).toMatch(/not the index/i);
  });

  it("asks for in_short as the first field, before the problem and any file-level field", () => {
    expect(text).toContain("Produce:");
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields[0]).toBe("in_short");
    expect(fields).toContain("problem");
    expect(fields).toContain("allowed_paths");
  });

  it("describes AS-IS and TO-BE in plain sentences with no file-level detail", () => {
    const b = bullet(produce, "in_short");
    expect(b).toContain(HEADING);
    expect(b).toContain("AS-IS");
    expect(b).toContain("TO-BE");
    expect(b).toMatch(/one plain sentence or two/i);
    expect(b).toMatch(/no file paths/i);
  });

  it("copies the request's exact values verbatim into a Given values section of the problem (design 04-agents.md)", () => {
    const b = bullet(produce, "problem");
    expect(b).toContain('"Given values" section');
    for (const kind of ["tables", "hex colours", "numbers", "names", "commands", "file paths"]) expect(b).toContain(kind);
    expect(b).toMatch(/verbatim/);
    expect(b).toMatch(/Never paraphrase/);
    expect(b).toMatch(/drop a value/);
  });

  it("asks for the size estimate and says when and how to split (design 2026-11-01)", () => {
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(expect.arrayContaining(["estimated_lines", "estimated_files", "phases"]));
    const p = bullet(produce, "phases");
    expect(p).toContain("85%");
    expect(p).toMatch(/2 to 4 phases/);
    expect(p).toMatch(/mergeable on its own/);
    expect(p).toMatch(/its own done criteria/);
  });
});

describe("owner defaults (issue #315)", () => {
  const text = prompt("triage");
  const defaults = prompt("owner-defaults");
  const CLAUDE = readFileSync(join(import.meta.dirname, "..", "CLAUDE.md"), "utf8");

  it("the triage prompt applies owner defaults, lists them, and asks only what no default covers", () => {
    expect(text).toMatch(/CLAUDE\.md already decides is not a decision/);
    expect(text).toMatch(/owner defaults/i);
    const b = bullet(text.slice(text.indexOf("Produce:")), "applied_defaults");
    expect(b).toMatch(/each owner default you applied/i);
    expect(b).toMatch(/rule/);
    expect(bullet(text.slice(text.indexOf("Produce:")), "decisions")).toMatch(/changes? behaviou?r and no owner default covers/);
  });

  it("the defaults file has one rule per line, each with its source issue, none repeating CLAUDE.md", () => {
    const rules = defaults.split("\n").filter((l) => l.startsWith("- "));
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) {
      expect(r).toMatch(/\(issue #\d+\)$/);
      expect(CLAUDE).not.toContain(r.slice(2).replace(/\s*\(issue #\d+\)$/, ""));
    }
    expect(defaults).toMatch(/in-process state is fine only when no other replica needs it/i);
  });

  describe("loading at startup", () => {
    afterEach(() => vi.unstubAllEnvs());
    const REAL = JSON.parse(readFileSync(join(import.meta.dirname, "..", "factory.config.json"), "utf8")) as Record<string, unknown>;
    const root = (ownerDefaults?: string): string => {
      const dir = mkdtempSync(join(tmpdir(), "sf-defaults-"));
      mkdirSync(join(dir, "prompts"));
      for (const p of ["triage", "implement", "review"]) writeFileSync(join(dir, "prompts", `${p}.md`), p);
      if (ownerDefaults !== undefined) writeFileSync(join(dir, "prompts", "owner-defaults.md"), ownerDefaults);
      writeFileSync(join(dir, "factory.config.json"), JSON.stringify({ ...REAL, store: { type: "sqlite" } }));
      mkdirSync(join(dir, "secrets"));
      writeFileSync(join(dir, "secrets", ".env"), "MYSQL_PASSWORD=pw\nGITHUB_TOKEN=gh\n");
      vi.stubEnv("SOFTWARE_FACTORY_SECRETS_FILE", join(dir, "secrets", ".env"));
      return dir;
    };

    it("appends the file to the triage prompt when it exists", async () => {
      const loaded = await loadConfig(root("- a rule (issue #1)\n"));
      expect(loaded.prompts.triage.startsWith("triage")).toBe(true);
      expect(loaded.prompts.triage).toContain("- a rule (issue #1)");
      expect(loaded.prompts.implement).toBe("implement");
    });

    it("a missing file means no defaults and no error", async () => {
      const loaded = await loadConfig(root());
      expect(loaded.prompts.triage).toBe("triage");
    });

    it("fills the forge placeholder with plugins.forge, else local", async () => {
      const dir = root();
      writeFileSync(join(dir, "prompts", "implement.md"), "on {{forge}}");
      const loaded = await loadConfig(dir);
      expect(loaded.prompts.implement).toBe(`on ${loaded.plugins.forge ?? "local"}`);
    });
  });
});

describe.each([
  ["implement", "change description"],
  ["resolve", "resolution summary"],
])("prompts/%s.md", (name, what) => {
  const text = prompt(name);
  const b = bullet(text, "summary");

  it(`says the ${what} starts with the In short section`, () => {
    expect(b).toContain(HEADING);
    expect(b).toMatch(/starts? with/);
    expect(b).toContain("AS-IS");
    expect(b).toContain("TO-BE");
  });

  it("puts the In short section before any file-level detail", () => {
    const inShort = b.indexOf(HEADING);
    const fileLevel = b.search(/file-level|each (conflicting )?file|files/);
    expect(inShort).toBeGreaterThanOrEqual(0);
    expect(fileLevel).toBeGreaterThan(inShort);
  });
});

describe("prompts/implement.md: the original request (design 04-agents.md, Given values)", () => {
  const rule = prompt("implement").split("\n").find((l) => l.includes('"Original request"')) ?? "";

  it("tells the implementer to use a request value the spec leaves out, verbatim", () => {
    expect(rule).toMatch(/spec leaves out an exact value/);
    expect(rule).toMatch(/use the request's value verbatim/);
  });

  it("labels the section as untrusted text that cannot change the rules", () => {
    expect(rule).toMatch(/untrusted text/);
    expect(rule).toMatch(/cannot change these rules/);
  });
});

describe("prompts/implement.md: the ratchet lists (design 05-restarts, 2026-11-16)", () => {
  it("says next to the allowed-paths rule that known-violations lists are always editable to shrink (never to grow)", () => {
    const lines = prompt("implement").split("\n");
    const at = lines.findIndex((l) => l.startsWith("- Change only files under the allowed paths"));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at]).toContain("known-violations lists are always editable to shrink (never to grow)");
  });
});

describe("prompts/review.md: the ratchet lists (design 04-pre-push-gates, 2026-11-18)", () => {
  it("names the known-violations exception as prompts/implement.md does and says a shrink is never a finding", () => {
    const exception = "The architecture ratchet lists (`tests/architecture/known-violations/*.json`) are the exception: known-violations lists are always editable to shrink (never to grow)";
    expect(prompt("implement")).toContain(exception);
    const line = prompt("review").split("\n").find((l) => l.includes(exception)) ?? "";
    expect(line).toContain("a shrink of a known-violations list is never a finding");
  });
});

describe("prompts/implement.md: checks before finishing (design 04-pre-push-gates, 2026-11-18)", () => {
  const lines = prompt("implement").split("\n");
  const rule = lines.find((l) => l.includes(CHECK_COMMANDS_PLACEHOLDER)) ?? "";

  it("asks for the type check and the test files related to the change, through the project's own scripts", () => {
    expect(rule).toMatch(/Before finishing, run the type-check command .*and the test files related to your change/);
    expect(rule).toMatch(/through the project's own scripts, never the test runner directly/);
  });

  it("says the factory runs the full check list before it pushes, so the agent does not run all of it", () => {
    expect(rule).toMatch(/The factory runs the full check list before it pushes, so do not run all of it yourself/);
    expect(rule).not.toMatch(/Run the project's checks before finishing/);
  });
});

describe("prompts/improve.md (issue #307)", () => {
  const text = prompt("improve");
  const produce = text.slice(text.indexOf("Produce:"));

  it("asks for cause, fix and touches", () => {
    const fields = [...produce.matchAll(/^- (\w+):/gm)].map((m) => m[1]);
    expect(fields).toEqual(expect.arrayContaining(["cause", "fix", "touches"]));
    expect(bullet(produce, "touches")).toMatch(/paths/);
  });

  it("grants no tools and names none", () => {
    expect(text).toMatch(/You have no tools/);
    expect(text).not.toMatch(/\b(Bash|Edit|Write|Read|Grep|Glob|WebFetch|tool_grants)\b/);
  });

  it("is loaded by compose as the improve prompt", async () => {
    const { loadConfig } = await import("../src/load-config.js");
    const { prompts } = await loadConfig(join(import.meta.dirname, ".."));
    expect(prompts.improve).toBe(text);
  });
});

// The core prompts serve every project the factory works on (issue #335): no npm or repo-specific paths, and the
// configured checks filled in at load.
const CORE = ["triage", "implement", "review", "resolve"] as const;
const repo = (over: Partial<FactoryConfig["repo"]>): FactoryConfig["repo"] =>
  ({ owner: "o", name: "n", path: ".", base_branch: "main", install_command: ["make", "deps"], test_command: ["make", "unit"], ...over }) as FactoryConfig["repo"];

describe.each(CORE)("prompts/%s.md is project-neutral", (name) => {
  const text = prompt(name);

  it("names no npm, doc index or src/core/ path", () => {
    for (const s of ["npm", "docs/design.md", "docs/plugins.md", "src/core/"]) expect(text, s).not.toContain(s);
  });

  it("renders for non-npm checks with no npm, no docs/design.md and no unfilled placeholder", () => {
    const out = fillPrompt(text, repo({ check_commands: [["make", "check"], ["make", "test"]] }), "local");
    expect(out).not.toContain("npm");
    expect(out).not.toContain("docs/design.md");
    expect(out).not.toContain("{{");
  });
});

// A generated companion file (schema snapshot, API registry) is regenerated by its script, which the companion
// rule's applied-default note names; the core prompt itself stays project-neutral (wi_06303973).
describe("prompts/implement.md on generated files", () => {
  it("says to regenerate a generated file with the project script, never by hand", () => {
    expect(prompt("implement")).toMatch(/Regenerate a generated file with the project script that generates it, never by hand/);
  });
});

// Where the change lives (issue: prompts say "change", not "pull request"): the forge name, filled at load.
describe.each(CORE)("prompts/%s.md names the forge", (name) => {
  const text = prompt(name);

  it("has the forge placeholder", () => {
    expect(text).toContain(FORGE_PLACEHOLDER);
  });

  it.each(["github", "local"])("renders with forge %s: the name, no placeholder, no pull request or PR", (forge) => {
    const out = fillPrompt(text, repo({}), forge);
    expect(out).toContain(`the ${forge} forge`);
    expect(out).not.toContain("{{");
    expect(out).not.toMatch(/pull request/i);
    expect(out).not.toMatch(/\bPR\b/);
  });
});

describe.each(["implement", "review"])("prompts/%s.md names the configured checks", (name) => {
  const text = prompt(name);

  it("has the placeholder", () => {
    expect(text).toContain(CHECK_COMMANDS_PLACEHOLDER);
  });

  it("puts each check_commands entry in the text, in order", () => {
    const out = fillPrompt(text, repo({ check_commands: [["make", "check"], ["make", "test"]] }), "local");
    expect(out).toContain("`make check`");
    expect(out).toContain("`make test`");
    expect(out.indexOf("`make check`")).toBeLessThan(out.indexOf("`make test`"));
    expect(out).toMatch(/project's own scripts, never the test runner directly/);
  });

  it("falls back to test_command when check_commands is absent", () => {
    const out = fillPrompt(text, repo({}), "local");
    expect(out).toContain("`make unit`");
    expect(out).not.toContain("{{");
  });
});

// The UI check runs at merge (design §4): the sandbox cannot start a browser, so neither agent reports it. The
// sentence is filled from `repo.ui_check` and is absent without it, so no project is told a check runs that does not.
describe.each(["implement", "review"])("prompts/%s.md: the UI check runs at merge", (name) => {
  const text = prompt(name);
  const ui_check = { command: ["make", "ui-check"], paths: ["web/"] };

  it("has the placeholder, and no UI check sentence of its own", () => {
    expect(text).toContain(UI_CHECK_PLACEHOLDER);
    expect(text).not.toContain("UI check");
  });

  it("with repo.ui_check, names the command, says it runs at merge and is not missing or unverified work", () => {
    const out = fillPrompt(text, repo({ ui_check }), "local");
    expect(out).toMatch(/UI check, `make ui-check`, runs at merge, on the merged commit, .*never in this sandbox/);
    expect(out).toMatch(/not work to report as missing or as unverified/);
    expect(out).not.toContain("{{");
  });

  it("with no repo.ui_check, says nothing about a UI check", () => {
    const out = fillPrompt(text, repo({}), "local");
    expect(out).not.toContain("UI check");
    expect(out).not.toContain("{{");
  });
});

describe("on this repo", () => {
  const root = join(import.meta.dirname, "..");
  const config = JSON.parse(readFileSync(join(root, "factory.config.json"), "utf8")) as FactoryConfig;

  it.each(["implement", "review"])("prompts/%s.md renders with npm run typecheck and npm test", (name) => {
    const out = fillPrompt(prompt(name), config.repo, "github");
    expect(out).toContain("`npm run typecheck`");
    expect(out).toContain("`npm test`");
  });

  it.each(["implement", "review"])("prompts/%s.md says this repo's check:responsive runs at merge", (name) => {
    const out = fillPrompt(prompt(name), config.repo, "github");
    expect(out).toMatch(/UI check, `npm run -s check:responsive`, runs at merge/);
  });

  it("CLAUDE.md links to AGENTS.md; the implement prompt holds the test-running rule and AGENTS.md the install rule", () => {
    expect(readlinkSync(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(prompt("implement")).toMatch(/any single test, through the project's own scripts, never the test runner directly/);
    const agents = readFileSync(join(root, "AGENTS.md"), "utf8").split("\n");
    expect(agents.some((l) => l.startsWith("- Tests:")), "no duplicate test-running bullet").toBe(false);
    const rule = agents.find((l) => l.startsWith("- Dependencies:"));
    expect(rule, "the install rule").toBeDefined();
    expect(rule).toMatch(/never run `npm install`, `npm ci`, or `npx` for a package that is not installed/);
  });
});

// Prompts and AGENTS.md keep only what the code cannot show (wi_e42e8e51): no rule a test already enforces, no
// restated stack fact, and each instruction said once.
describe("prompts and AGENTS.md hold no rule a test enforces and say each rule once", () => {
  const agents = readFileSync(join(import.meta.dirname, "..", "AGENTS.md"), "utf8");

  it("AGENTS.md drops the rules tests enforce: the plugin descriptor, layer imports, hex colours, the symlink and the gate list", () => {
    for (const s of ["tests/plugins.test.ts fails otherwise", "tests/boundaries.test.ts", "no hex colours", "is a symlink to this file", "always need a human merge"])
      expect(agents, s).not.toContain(s);
    expect(agents).not.toContain("See the maintainability rule below");
  });

  it("the triage prompt asks for an empty decisions list once, in the output shape", () => {
    const text = prompt("triage");
    expect(text).not.toContain("Always include the field");
    expect(text).toMatch(/include `decisions` even when it is empty/);
  });

  it("the review prompt says once where cleanup notes, unverified checks and ui_unverified go", () => {
    const text = prompt("review");
    expect(text.match(/cleanup chance/g)).toHaveLength(1);
    expect(text).not.toContain("goes under `unverified`, never in findings");
    expect(text).toContain("Never put them in findings");
    expect(text).not.toContain("Leave `ui_unverified` out for any other diff");
  });
});

describe("prompts/review.md: a UI change that could not be checked (design 04-agents, 2026-11-19)", () => {
  const text = prompt("review");

  it("asks for ui_unverified and the unrun build, type-check and screenshots under unverified, with the spec's widths", () => {
    const step = text.split("\n").findIndex((l) => l.includes("UI changes:"));
    expect(step).toBeGreaterThanOrEqual(0);
    const rule = text.split("\n").slice(step, step + 6).join(" ").replace(/\s+/g, " ");
    expect(rule).toMatch(/`web\/`, `src\/ui\/`/);
    expect(rule).toMatch(/build, its type-check or its screenshots, set `ui_unverified` to true/);
    expect(rule).toMatch(/could not run under `unverified`, one line each, naming the command/);
    expect(rule).toMatch(/name the widths the spec states \(for example .*1280px and 390px/);
  });

  it("lists ui_unverified among the output fields", () => {
    expect(text.slice(text.indexOf("Output:"))).toMatch(/^- ui_unverified: true only/m);
  });
});

// UI specs name components, a reference page and what stays fixed (wi_1303fdc2): the triage prompt asks for them,
// the review prompt checks the diff against them, and the design system holds the table and the fixed list.
const flat = (s: string): string => s.replace(/\s+/g, " ");

describe("prompts/triage.md: a UI change names components, a reference page and what stays fixed", () => {
  const rule = flat(bullet(prompt("triage"), "UI changes"));

  it("asks, for a change under web/ with design-system/components.md, for the components each element uses by name", () => {
    expect(rule).toMatch(/under `web\/`.*`design-system\/components\.md`/);
    expect(rule).toMatch(/names the components each new or changed element uses, by name from `design-system\/components\.md`/);
  });

  it("asks for one existing page to match for layout and spacing", () => {
    expect(rule).toMatch(/one existing page to match for layout and spacing/);
  });

  it("points to the Stays fixed list in design-system/README.md", () => {
    expect(rule).toMatch(/"Stays fixed" list in `design-system\/README\.md`/);
  });

  it("says a need with no component says so", () => {
    expect(rule).toMatch(/A need with no component says so/);
  });
});

// A new page or a main-layout change offers layout options (wi_a82df3cb): one layout decision with 2 or 3 text
// sketches built from design-system/components.md, the default marked with a reason; small changes ask nothing.
describe("prompts/triage.md: layout decisions for a new page or a main-layout change", () => {
  const rule = flat(bullet(prompt("triage"), "Layout decisions"));

  it("adds one layout decision with 2 or 3 options when the item adds a new page or changes a page's main layout", () => {
    expect(rule).toMatch(/adds a new page or changes a page's main layout, add one layout decision/);
    expect(rule).toMatch(/`"layout": true` and 2 or 3 options/);
  });

  it("keeps one layout and no layout decision for a small change", () => {
    expect(rule).toMatch(/Small changes .* keep one layout and add no layout decision/);
  });

  it("draws each option as a text sketch of header, cards, lists and actions from design-system/components.md only", () => {
    expect(rule).toMatch(/Each option is a small text sketch/);
    expect(rule).toMatch(/header, cards, lists and actions/);
    expect(rule).toMatch(/using only components named in `design-system\/components\.md`/);
    expect(rule).toMatch(/monospace/);
  });

  it("marks the default and gives its reason", () => {
    expect(rule).toMatch(/Mark the default: it is one of the options, and the reason says why it is the default/);
  });

  it("names the layout field in the decision entry", () => {
    expect(flat(bullet(prompt("triage"), "decisions"))).toContain('"owner_only": false, "layout": false }');
  });
});

describe("prompts/review.md step 7: the diff against the named components and the Stays fixed list", () => {
  const lines = prompt("review").split("\n");
  const start = lines.findIndex((l) => l.startsWith("7. Design-system review:"));
  const end = lines.findIndex((l, i) => i > start && /^\d+\. /.test(l));
  const step = flat(lines.slice(start, end).join("\n"));

  it("checks the diff against the components the spec names and the Stays fixed list", () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(step).toMatch(/the components the spec names/);
    expect(step).toMatch(/"Stays fixed" list in `design-system\/README\.md`/);
  });

  it("flags a hand-made element where the table names a component, as kind code naming the table row", () => {
    expect(step).toMatch(/hand-made element .*"Which component for what" table names a component is a finding of kind `code` that names the table row/);
  });
});

describe("design-system: the component table and the Stays fixed list", () => {
  const root = join(import.meta.dirname, "..", "design-system");
  const components = readFileSync(join(root, "components.md"), "utf8");
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const sections = new Set([...components.matchAll(/^## (\w+)/gm)].map((m) => m[1]));
  const tableAt = components.indexOf("## Which component for what");
  const rows = components
    .slice(tableAt)
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| Need") && !l.startsWith("|---"))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const row = (need: string) => rows.find((r) => r[0] === need);

  it("opens with the table, before the first component section, with need, component and usage columns", () => {
    expect(tableAt).toBeGreaterThanOrEqual(0);
    expect(tableAt).toBeLessThan(components.indexOf("## Card"));
    expect(components.slice(tableAt)).toMatch(/^\| Need \| Component \| Usage \|$/m);
  });

  it.each([
    ["a state", "Badge"],
    ["a row's extra actions", "OverflowMenu"],
    ["input inside a list row", "Dialog"],
  ])("maps %s to %s", (need, component) => {
    expect(row(need)?.[1]).toContain(`\`${component}\``);
  });

  it("maps an on/off choice in a list to the Checkbox in web/src/components/ui/checkbox.tsx", () => {
    const r = row("an on/off choice in a list");
    expect(r?.[1]).toContain("`Checkbox`");
    expect(r?.[1]).toContain("web/src/components/ui/checkbox.tsx");
    expect(r?.join(" ")).not.toMatch(/none yet|Switch/);
  });

  it("names, in code, only components that have a section", () => {
    for (const r of rows) for (const [, name] of r[1]!.matchAll(/`(\w+)`/g)) expect(sections.has(name), name).toBe(true);
  });

  it("README has a Stays fixed section with the four items", () => {
    const at = readme.indexOf("## Stays fixed");
    expect(at).toBeGreaterThanOrEqual(0);
    const section = readme.slice(at, readme.indexOf("\n## ", at + 1));
    for (const item of ["celadon glaze palette", "the one primary action per view", "page header and Card structure", "no raw IDs on a page"])
      expect(section, item).toContain(item);
  });
});

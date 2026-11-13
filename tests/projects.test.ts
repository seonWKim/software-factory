// Task projects (phase 1 of 3): the pure name and slug rules in src/core/projects.ts. No store, no Clock.

import { describe, expect, it } from "vitest";
import { MAX_PROJECT_NAME, MAX_PROJECT_SLUG, isProjectSlug, projectName, projectSlug } from "../src/core/projects.js";

describe("projectName", () => {
  it("trims the name and folds runs of whitespace to one space", () => {
    expect(projectName("  Home   renovation\t2027 ")).toEqual({ ok: true, name: "Home renovation 2027", slug: "home-renovation-2027" });
  });

  it("keeps the name as written and gives it its slug", () => {
    expect(projectName("Q3 Launch: Web & App")).toEqual({ ok: true, name: "Q3 Launch: Web & App", slug: "q3-launch-web-app" });
  });

  it("accepts a name of exactly the longest length", () => {
    const name = "a".repeat(MAX_PROJECT_NAME);
    expect(projectName(name)).toMatchObject({ ok: true, name });
  });

  it.each([
    ["an empty name", ""],
    ["a blank name", "   \t "],
    ["a name with a newline", "two\nlines"],
    ["a name with a control character", "bell\u0007"],
    ["a name longer than the limit", "a".repeat(MAX_PROJECT_NAME + 1)],
    ["a name with no letter or digit", "!!! ---"],
    ["a name that is not a string", 42 as unknown as string],
  ])("refuses %s with a reason", (_what, raw) => {
    const r = projectName(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^a project name /);
  });
});

describe("projectSlug", () => {
  it("lowercases, joins words with one dash and drops leading and trailing dashes", () => {
    expect(projectSlug("--Hello,  World!--")).toBe("hello-world");
  });

  it("drops accents", () => {
    expect(projectSlug("Café Crème")).toBe("cafe-creme");
  });

  it("cuts a long slug at the limit without a trailing dash", () => {
    const slug = projectSlug(`${"a".repeat(MAX_PROJECT_SLUG - 1)} bbb`);
    expect(slug).toBe("a".repeat(MAX_PROJECT_SLUG - 1));
    expect(projectSlug("x".repeat(MAX_PROJECT_SLUG + 10))!.length).toBe(MAX_PROJECT_SLUG);
  });

  it("keeps letters and digits of any script", () => {
    expect(projectSlug("집 수리 2027")).toBe("집-수리-2027");
    expect(projectSlug("Ünïcode Straße")).toBe("unicode-straße");
  });

  it("is null for a name with no letter or digit", () => {
    expect(projectSlug("…")).toBeNull();
    expect(projectSlug(" - _ ! ")).toBeNull();
  });

  it("gives the same slug for names that differ only in case, spacing or punctuation", () => {
    expect(projectSlug("Home Repairs")).toBe(projectSlug("home-repairs"));
    expect(projectSlug("Home Repairs")).toBe(projectSlug(" HOME  repairs! "));
  });
});

describe("isProjectSlug", () => {
  it("accepts what projectSlug makes", () => {
    for (const name of ["Home", "Q3 Launch: Web & App", "Café Crème", "집 수리", "x".repeat(200)]) expect(isProjectSlug(projectSlug(name)!)).toBe(true);
  });

  it.each(["", "Home", "home repairs", "-home", "home-", "home--repairs", "home_repairs", "a".repeat(MAX_PROJECT_SLUG + 1)])("refuses %j", (s) => {
    expect(isProjectSlug(s)).toBe(false);
  });
});

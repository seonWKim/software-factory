import { describe, expect, it } from "vitest";
import { en } from "../web/src/i18n/en.js";

// The dashboard's copy tells the owner what to do in the page, never to edit the config file, run an npm script or a
// factory CLI command, or do something by hand (phase 4 of local-0ffe3059-d863-4717-b3eb-1c72a06e444e). The Data and
// Runners debug pages (keys starting with `data.` and `runners.`) may name them: they show the factory's own internals.

/** The terms no user-facing copy holds, matched without regard to case. */
const TERMS = ["factory.config.json", "npm run", "factory pack", "by hand"] as const;

/** The key prefixes of the debug pages, where the terms may appear. */
const ALLOWED_PREFIXES = ["data.", "runners."] as const;

/** Each `key: term` where a key outside the allow-list holds a term. */
function offending(copy: Readonly<Record<string, string>>): string[] {
  return Object.entries(copy)
    .filter(([key]) => !ALLOWED_PREFIXES.some((p) => key.startsWith(p)))
    .flatMap(([key, text]) => TERMS.filter((term) => text.toLowerCase().includes(term)).map((term) => `${key}: ${term}`));
}

describe("web user copy", () => {
  it("flags each term in a planted catalog outside the Data and debug allow-list, in any case", () => {
    expect(offending({
      "a.config": "Edit factory.config.json",
      "a.npm": "Then NPM RUN migrate.",
      "a.pack": "or factory pack approve",
      "a.hand": "Fix it By Hand.",
      "data.table": "from factory.config.json, by hand",
      "runners.cmd": "npm run factory -- dev",
      "a.clean": "Turn it on from this page.",
    })).toEqual(["a.config: factory.config.json", "a.npm: npm run", "a.pack: factory pack", "a.hand: by hand"]);
  });

  it("finds none of the terms in web/src/i18n/en.ts outside the allow-list", () => {
    expect(offending(en)).toEqual([]);
  });
});

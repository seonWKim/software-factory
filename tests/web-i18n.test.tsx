// @vitest-environment jsdom
// @ts-nocheck -- same reason as tests/data-page.test.tsx: tsconfig.test.json has no DOM and no JSX.
import { afterEach, describe, expect, it, vi } from "vitest";
import { en } from "../web/src/i18n/en.js";
import { CATALOGS, locale, pickLocale, t } from "../web/src/i18n/index.js";
import { tokens } from "../web/src/lib/format.js";

const setLanguages = (languages: string[]) => vi.spyOn(navigator, "languages", "get").mockReturnValue(languages);

afterEach(() => vi.restoreAllMocks());

describe("web i18n", () => {
  it("every catalog has the same keys as the English catalog", () => {
    for (const [tag, catalog] of Object.entries(CATALOGS)) {
      expect(Object.keys(catalog).sort(), tag).toEqual(Object.keys(en).sort());
    }
  });

  it("shows English when the browser language has no catalog", () => {
    setLanguages(["fr-FR"]);
    expect(locale()).toBe("en");
    expect(t("topbar.refresh")).toBe("Refresh");
  });

  it("picks the first browser language that has a catalog", () => {
    expect(pickLocale(["fr-FR", "en-US"])).toBe("en");
    expect(pickLocale([])).toBe("en");
  });

  it("falls back to English for a key missing in the active locale", () => {
    (CATALOGS as Record<string, object>).xx = {};
    try {
      setLanguages(["xx"]);
      expect(locale()).toBe("xx");
      expect(t("topbar.refresh")).toBe("Refresh");
    } finally {
      delete (CATALOGS as Record<string, object>).xx;
    }
  });

  it("fills values into a message", () => {
    expect(t("topbar.needsYou", { count: 3 })).toBe("Needs you (3)");
  });

  it("formats numbers for the active locale", () => {
    expect(tokens(38_521_431)).toBe("38.5M");
    expect(tokens(29_285)).toBe("29.3k");
    expect(tokens(12)).toBe("12");
  });
});

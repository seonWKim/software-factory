import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dir = new URL("../web/src/i18n/en/", import.meta.url);

describe("English dashboard text names the risk scale 'risk level'", () => {
  it("every value in web/src/i18n/en/ that has the word tier also says risk level", async () => {
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const mod = (await import(new URL(file, dir).href)) as Record<string, unknown>;
      for (const catalog of Object.values(mod)) {
        if (typeof catalog !== "object" || catalog === null) continue;
        for (const [key, value] of Object.entries(catalog)) {
          if (typeof value === "string" && /tier/i.test(value) && !/risk level/i.test(value)) offenders.push(`${file} ${key}: ${value}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

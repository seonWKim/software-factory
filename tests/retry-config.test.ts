import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RETRY_DEFAULTS, loadConfig, retryConfig } from "../src/compose.js";

describe("retry config keys", () => {
  it("defaults: max_restart 3, retry_base_ms 60000, retry_max_ms 1800000", () => {
    expect(retryConfig({})).toEqual({ max_restart: 3, retry_base_ms: 60_000, retry_max_ms: 1_800_000 });
    expect(RETRY_DEFAULTS).toEqual({ max_restart: 3, retry_base_ms: 60_000, retry_max_ms: 1_800_000 });
  });

  it("rejects non-positive or non-integer values, and a base above the cap", () => {
    expect(() => retryConfig({ max_restart: 0 })).toThrow(/max_restart/);
    expect(() => retryConfig({ retry_base_ms: 1.5 })).toThrow(/retry_base_ms/);
    expect(() => retryConfig({ retry_base_ms: 10, retry_max_ms: 5 })).toThrow(/must not exceed/);
  });

  it("factory.config.json sets all three, and loadConfig carries them into FactoryConfig", async () => {
    const root = new URL("..", import.meta.url).pathname;
    const file = JSON.parse(readFileSync(`${root}factory.config.json`, "utf8")) as Record<string, unknown>;
    expect(file).toMatchObject({ max_restart: 3, retry_base_ms: 60000, retry_max_ms: 1800000 });
    const { config } = await loadConfig(root);
    expect(config).toMatchObject({ max_restart: 3, retry_base_ms: 60000, retry_max_ms: 1800000 });
  });
});

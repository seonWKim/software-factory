import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { retryConfig } from "../src/config-values.js";
import maxRestart from "../src/controller/settings/max-restart.setting.js";
import retryBase from "../src/controller/settings/retry-base-ms.setting.js";
import retryMax from "../src/controller/settings/retry-max-ms.setting.js";
import { loadConfig } from "../src/load-config.js";

describe("retry config keys", () => {
  it("defaults: max_restart 3, retry_base_ms 60000, retry_max_ms 1800000", () => {
    expect(retryConfig({})).toEqual({ max_restart: 3, retry_base_ms: 60_000, retry_max_ms: 1_800_000, auth_pause_ms: 1_800_000 });
    expect(retryConfig({})).toMatchObject({ max_restart: maxRestart.default, retry_base_ms: retryBase.default, retry_max_ms: retryMax.default });
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

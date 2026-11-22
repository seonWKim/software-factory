// settingsBase: what the config file says about each settable key. Kernel code (RFC 0023 §3), so the settings
// command and Slack's settings reads get it without importing the composition root.

import { type GlobalSettableKey, SETTABLE_KEYS, type SettingsBase, isProjectSettableKey } from "./settings.js";

/**
 * What factory.config.json says about each settable key, before any override (design 2026-11-03): the global keys
 * as written in the file (absent: not set there), and the checked per-project layers, still keyed by `owner/name`
 * as the file writes them. build() swaps in the layers re-keyed to the project key.
 */
export function settingsBase(loaded: { file: object; config: { settings: SettingsBase["layers"]; max_workers?: number } }): SettingsBase {
  const raw = loaded.file as unknown as Record<string, unknown>;
  const file: Partial<Record<GlobalSettableKey, unknown>> = {};
  for (const k of SETTABLE_KEYS) {
    if (isProjectSettableKey(k)) continue;
    if (raw[k] !== undefined) file[k] = raw[k];
  }
  return { file, layers: loaded.config.settings, ...(loaded.config.max_workers !== undefined ? { max_workers: loaded.config.max_workers } : {}) };
}

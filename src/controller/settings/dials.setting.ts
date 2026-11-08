// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { defineSetting } from "../../shared/setting.js";

/** Each dial may only move toward more gating: spec_gate_min_tier down (more specs gated), auto_merge_max_tier down. */
function dialsLoosening(value: unknown, than: unknown): string | null {
  const v = value as { spec_gate_min_tier?: number; auto_merge_max_tier?: number };
  const t = than as { spec_gate_min_tier?: number; auto_merge_max_tier?: number };
  if ((v.spec_gate_min_tier ?? 1) > (t.spec_gate_min_tier ?? 1)) return "dials.spec_gate_min_tier rises above the value above it";
  if ((v.auto_merge_max_tier ?? 0) > (t.auto_merge_max_tier ?? 0)) return "dials.auto_merge_max_tier rises above the value above it";
  return null;
}

export default defineSetting({
  key: "dials",
  owner: "controller",
  type: "object",
  default: null,
  description: "The lowest tier that needs a spec approval; its auto_merge_max_tier stays 0 (the setting decides).",
  applies: null,
  direction: "tighten-only",
  tighter: (value, than) => dialsLoosening(value, than),
  changed_by: "review",
  scope: "global",
  dial: true,
});

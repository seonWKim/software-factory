// Ported from src/core/settings.ts (RFC 0015 M10). Changes by a reviewed PR to factory.config.json only.

import { type Floor, loosening } from "../../core/settings.js";
import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "floors",
  owner: "controller",
  type: "list",
  default: [],
  description: "Paths that raise a work item's tier to at least a given tier when a change touches them.",
  applies: null,
  direction: "tighten-only",
  tighter: (value, than) => loosening("floors", value as Floor[], than as Floor[]),
  changed_by: "review",
  scope: "project",
  dial: true,
});

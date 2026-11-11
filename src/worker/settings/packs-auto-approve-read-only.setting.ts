// Design 11-packs (issue #589): pack tools need the owner's approval; this lets a read-only one with no credential
// skip it. Off by default. Changes by a reviewed PR to factory.config.json only (`packs.auto_approve_read_only`).

import { defineSetting } from "../../shared/setting.js";

export default defineSetting({
  key: "packs.auto_approve_read_only",
  owner: "worker",
  type: "boolean",
  default: false,
  description: "Whether a read-only pack tool with no credential is approved without the owner's approval.",
  applies: null,
  direction: "tighten-only",
  tighter: [false, true],
  changed_by: "review",
  scope: "global",
});

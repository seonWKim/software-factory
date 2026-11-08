// The controller units' context (RFC 0015 M5): every unit decides on the legacy source and forge events, over the
// shared kernel; a pure unit loads through the kernel's reader and decides controller writes. `controllerUnit` is
// `defineUnit` with those four fixed.

import type { ForgeEvent } from "../../interfaces/forge.js";
import type { SourceEvent } from "../../interfaces/source-adapter.js";
import { defineUnit, type UnitContext, type UnitDecision, type UnitDescriptor } from "../router/unit.js";
import type { ControllerReader, ControllerWrite, Kernel } from "./kernel.js";

export type ControllerEvent = SourceEvent | ForgeEvent;

/**
 * Every event kind the sources and the forge report: a kind missing here, or one that is not a kind, fails the
 * typecheck, and a kind no unit accepts is a router startup problem (it would be dropped).
 */
const KINDS = {
  item_requested: true, spec_approved: true, spec_rejected: true, revise_requested: true, retry_requested: true,
  help_requested: true, standing_requested: true, unknown_command: true, plain_comment: true, source_closed: true,
  budget_continue: true, resolve_requested: true, verdict_submitted: true, base_commit: true,
  change_merged: true, change_closed: true, change_open: true, change_unmergeable: true, pr_changes_requested: true,
} as const satisfies Record<ControllerEvent["kind"], true>;

export const CONTROLLER_EVENT_KINDS = Object.keys(KINDS) as ControllerEvent["kind"][];

export type Ctx = UnitContext<Kernel, ControllerEvent>;

/** What a pure controller unit decides. */
export type ControllerDecision = UnitDecision<ControllerWrite>;

export type ControllerUnit<O> = UnitDescriptor<Kernel, ControllerEvent, O, ControllerReader, ControllerWrite>;

export function controllerUnit<O>(u: Omit<ControllerUnit<O>, "kind">): ControllerUnit<O> {
  return defineUnit(u);
}

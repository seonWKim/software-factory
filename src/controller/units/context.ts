// The controller units' context (RFC 0015 M5): every unit decides on the legacy source and forge events, over the
// shared kernel; a pure unit loads through the kernel's reader and decides controller writes. `controllerUnit` is
// `defineUnit` with those four fixed.

import type { ForgeEvent } from "../../interfaces/forge.js";
import type { SourceEvent } from "../../interfaces/source-adapter.js";
import { defineUnit, type UnitContext, type UnitDecision, type UnitDescriptor } from "../router/unit.js";
import type { ControllerReader, ControllerWrite, Kernel } from "./kernel.js";

export type ControllerEvent = SourceEvent | ForgeEvent;

export type Ctx = UnitContext<Kernel, ControllerEvent>;

/** What a pure controller unit decides. */
export type ControllerDecision = UnitDecision<ControllerWrite>;

export type ControllerUnit<O> = UnitDescriptor<Kernel, ControllerEvent, O, ControllerReader, ControllerWrite>;

export function controllerUnit<O>(u: Omit<ControllerUnit<O>, "kind">): ControllerUnit<O> {
  return defineUnit(u);
}

// The controller units' context (RFC 0015 M5): every unit decides on the legacy source and forge events, over the
// shared kernel. `controllerUnit` is `defineUnit` with those two fixed.

import type { ForgeEvent } from "../../interfaces/forge.js";
import type { SourceEvent } from "../../interfaces/source-adapter.js";
import { defineUnit, type UnitContext, type UnitDescriptor } from "../router/unit.js";
import type { Kernel } from "./kernel.js";

export type ControllerEvent = SourceEvent | ForgeEvent;

export type Ctx = UnitContext<Kernel, ControllerEvent>;

export function controllerUnit<O>(u: Omit<UnitDescriptor<Kernel, ControllerEvent, O>, "kind">): UnitDescriptor<Kernel, ControllerEvent, O> {
  return defineUnit(u);
}

// The unit contract (RFC 0015 §6.2, M5). A unit is one controller feature in its own folder,
// `src/controller/units/<unit>/<unit>.unit.ts`, found by discovery: the events it decides on (by kind, one unit per
// kind), the steps it runs on the controller's ticks, and its operations. Nothing here names a unit.
//
// A unit calls another unit's operation through `ctx.unit(name)`, typed by `UnitOperations`, which each unit file
// extends for its own name (declaration merging), so no unit imports another. Use it where a message would be
// overkill: a shared reply, a transition, a check another decision needs now.
//
// A pure step or event (RFC 0015 §6.2, §7) is split in two: `load` reads what the decision needs through the
// router's read-only accessors (`R`), and `decide` returns a decision, the writes (`W`) to commit, with no I/O and no
// clock: time comes from the tick. The router commits the decision. A legacy step (`run`) or event (a plain function)
// still reads and writes inline; the unit-purity ratchet lists those units until they are split.

import type { Tick } from "../../shared/ticks/tick-generator.js";

/** Each unit's operations by unit name; every `<unit>.unit.ts` adds its own entry. */
export interface UnitOperations {}

export type UnitName = keyof UnitOperations & string;

/** What every unit gets: the shared kernel, the other units' operations, and dispatch of a further event. */
export interface UnitContext<K, E extends { kind: string }> {
  readonly k: K;
  unit<N extends UnitName>(name: N): UnitOperations[N];
  /** Hands an event to the unit that accepts its kind (a command row that becomes a comment's event). */
  dispatch(e: E): Promise<void>;
}

/** What a pure step or event decided: the writes the router commits, in order. Nothing is written while deciding. */
export interface UnitDecision<W> {
  readonly writes: readonly W[];
}

/**
 * When a step runs. `every` names the tick kind (the role's `tick` each tick_ms, `poll` each poll interval); steps of
 * one tick run in `order`, each guarded, so one failing step never stops the others.
 */
interface StepTiming {
  readonly name: string;
  readonly every: string;
  readonly order: number;
}

/** A legacy step: reads and writes inline. */
export interface LegacyStep<O> extends StepTiming {
  run(u: O): Promise<void>;
}

/** A pure step: `load` reads through `R`, `decide` returns the writes. */
export interface PureStep<O, R, W, L = unknown> extends StepTiming {
  load(u: O, r: R, tick: Tick): Promise<L>;
  decide(u: O, loaded: L, tick: Tick): UnitDecision<W>;
}

// The loaded value is the step's own: its load and decide agree on it (method parameters are bivariant); the router passes it along.
export type UnitStep<O, R = unknown, W = unknown> = LegacyStep<O> | PureStep<O, R, W, unknown>;

/** A pure event handler: `load` reads through `R` what deciding on `e` needs, `decide` returns the writes. */
export interface PureEvent<O, M, R, W, L = unknown> {
  load(u: O, e: M, r: R, tick: Tick): Promise<L>;
  decide(u: O, e: M, loaded: L, tick: Tick): UnitDecision<W>;
}

export type UnitEvents<E extends { kind: string }, O, R = unknown, W = unknown> = {
  readonly [T in E["kind"]]?:
    | ((u: O, e: Extract<E, { kind: T }>) => Promise<void>)
    | PureEvent<O, Extract<E, { kind: T }>, R, W, unknown>;
};

export interface UnitDescriptor<K = unknown, E extends { kind: string } = { kind: string }, O = unknown, R = unknown, W = unknown> {
  readonly kind: "unit";
  readonly name: string;
  create(c: UnitContext<K, E>): O;
  readonly events?: UnitEvents<E, O, R, W>;
  readonly steps?: readonly UnitStep<O, R, W>[];
}

export const UNIT_FILE = /\.unit\.(?:ts|js)$/;

export function defineUnit<K, E extends { kind: string }, O, R = unknown, W = unknown>(
  u: Omit<UnitDescriptor<K, E, O, R, W>, "kind">,
): UnitDescriptor<K, E, O, R, W> {
  return { kind: "unit", ...u };
}

/** Whether a step is split into load and decide. */
export function isPure<O, R, W>(s: UnitStep<O, R, W>): s is PureStep<O, R, W, unknown> {
  return "decide" in s;
}

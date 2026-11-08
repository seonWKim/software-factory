// The unit contract (RFC 0015 §6.2, M5). A unit is one controller feature in its own folder,
// `src/controller/units/<unit>/<unit>.unit.ts`, found by discovery: the events it decides on (by kind, one unit per
// kind), the steps it runs on the controller's ticks, and its operations. Nothing here names a unit.
//
// A unit calls another unit's operation through `ctx.unit(name)`, typed by `UnitOperations`, which each unit file
// extends for its own name (declaration merging), so no unit imports another. Use it where a message would be
// overkill: a shared reply, a transition, a check another decision needs now.

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

/**
 * One step on the controller's ticks. `every` names the tick kind (the role's `tick` each tick_ms, `poll` each
 * poll interval); steps of one tick run in `order`, each guarded, so one failing step never stops the others.
 */
export interface UnitStep<O> {
  readonly name: string;
  readonly every: string;
  readonly order: number;
  run(u: O): Promise<void>;
}

export type UnitEvents<E extends { kind: string }, O> = { readonly [T in E["kind"]]?: (u: O, e: Extract<E, { kind: T }>) => Promise<void> };

export interface UnitDescriptor<K = unknown, E extends { kind: string } = { kind: string }, O = unknown> {
  readonly kind: "unit";
  readonly name: string;
  create(c: UnitContext<K, E>): O;
  readonly events?: UnitEvents<E, O>;
  readonly steps?: readonly UnitStep<O>[];
}

export const UNIT_FILE = /\.unit\.(?:ts|js)$/;

export function defineUnit<K, E extends { kind: string }, O>(u: Omit<UnitDescriptor<K, E, O>, "kind">): UnitDescriptor<K, E, O> {
  return { kind: "unit", ...u };
}

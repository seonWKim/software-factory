// The controller's router (RFC 0015 §7, M5): builds the discovered units over one kernel, hands each event to the
// unit that accepts its kind, and runs the units' steps on a tick in their order. It names no unit and holds no
// feature logic; the role (src/runtime/roles) discovers the units and drives the ticks.

import type { UnitContext, UnitDescriptor, UnitName, UnitOperations, UnitStep } from "./unit.js";

type AnyUnit<K, E extends { kind: string }> = UnitDescriptor<K, E, unknown>;

export interface RouterOptions {
  /** Runs one step or event so that its failure is logged and passed. */
  guard(what: string, fn: () => Promise<void>): Promise<void>;
}

export class Router<K, E extends { kind: string }> {
  private readonly instances = new Map<string, unknown>();
  private readonly byKind = new Map<string, { unit: string; on: (u: unknown, e: E) => Promise<void> }[]>();
  private readonly steps: { unit: string; step: UnitStep<unknown> }[] = [];

  constructor(
    units: readonly AnyUnit<K, E>[],
    readonly k: K,
    private readonly opts: RouterOptions,
  ) {
    const ctx: UnitContext<K, E> = { k, unit: (name) => this.unit(name), dispatch: (e) => this.dispatch(e) };
    for (const u of units) {
      if (this.instances.has(u.name)) throw new Error(`controller unit "${u.name}" is defined twice`);
      this.instances.set(u.name, u.create(ctx));
      for (const [kind, on] of Object.entries(u.events ?? {})) {
        if (!on) continue;
        this.byKind.set(kind, [...(this.byKind.get(kind) ?? []), { unit: u.name, on: on as (u: unknown, e: E) => Promise<void> }]);
      }
      for (const step of u.steps ?? []) this.steps.push({ unit: u.name, step });
    }
    this.steps.sort((a, b) => a.step.order - b.step.order);
  }

  /** Startup problems: an event kind several units accept (an event has one deciding unit), a step order used twice. */
  problems(): string[] {
    const out: string[] = [];
    for (const [kind, hs] of this.byKind) if (hs.length > 1) out.push(`event ${kind} is accepted by ${hs.map((h) => h.unit).join(", ")}`);
    const orders = new Map<string, string>();
    for (const { unit, step } of this.steps) {
      const key = `${step.every}:${step.order}`;
      const seen = orders.get(key);
      if (seen) out.push(`steps ${seen} and ${unit}.${step.name} share order ${step.order} on ${step.every}`);
      orders.set(key, `${unit}.${step.name}`);
    }
    return out;
  }

  unit<N extends UnitName>(name: N): UnitOperations[N] {
    const u = this.instances.get(name);
    if (u === undefined) throw new Error(`no controller unit "${name}"`);
    return u as UnitOperations[N];
  }

  /** The event to the unit that accepts its kind; an event no unit accepts is dropped. */
  async dispatch(e: E): Promise<void> {
    const h = this.byKind.get(e.kind)?.[0];
    if (h) await h.on(this.instances.get(h.unit), e);
  }

  /** Every step whose `every` is in `kinds`, in order, each guarded. */
  async tick(kinds: readonly string[]): Promise<void> {
    for (const { unit, step } of this.steps) {
      if (kinds.includes(step.every)) await this.opts.guard(step.name, () => step.run(this.instances.get(unit)));
    }
  }
}

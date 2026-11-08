// The controller's router (RFC 0015 §7, M5): builds the discovered units over one kernel, hands each event to the
// unit that accepts its kind, and runs the units' steps on a tick in their order. A pure step or event is loaded
// through the read-only accessors, decided, and its decision committed here; a legacy one runs as it is. It names no
// unit and holds no feature logic; the role (src/runtime/roles) discovers the units and drives the ticks.

import type { Envelope } from "../../shared/envelope.js";
import type { Tick } from "../../shared/ticks/tick-generator.js";
import { isPure, type PureEvent, type UnitContext, type UnitDecision, type UnitDescriptor, type UnitName, type UnitOperations, type UnitStep } from "./unit.js";

type AnyUnit<K, E extends { kind: string }, R, W> = UnitDescriptor<K, E, unknown, R, W>;
type Handler<E, R, W> = ((u: unknown, e: E) => Promise<void>) | PureEvent<unknown, E, R, W, unknown>;

export interface RouterOptions<E extends { kind: string }, R, W> {
  /** Every event kind the router can be handed: a kind no unit accepts is a startup problem, not a silent drop. */
  readonly kinds: readonly E["kind"][];
  /** Every bus message type the controller's consumer hands the router: each needs exactly one unit. */
  readonly messages: readonly string[];
  /** Runs one step or event so that its failure is logged and passed. */
  guard(what: string, fn: () => Promise<void>): Promise<void>;
  /** The read-only accessors a pure unit's `load` reads through. */
  readonly reader: R;
  /** Commits a pure unit's decision. */
  commit(d: UnitDecision<W>): Promise<void>;
  /** The tick an event is decided on when the caller gives none (an event the bus delivered). */
  now(): Tick;
}

export class Router<K, E extends { kind: string }, R = unknown, W = unknown> {
  private readonly instances = new Map<string, unknown>();
  private readonly byKind = new Map<string, { unit: string; on: Handler<E, R, W> }[]>();
  private readonly byMessage = new Map<string, { unit: string; on: (u: unknown, m: Envelope) => Promise<void> }[]>();
  private readonly steps: { unit: string; step: UnitStep<unknown, R, W> }[] = [];

  constructor(
    units: readonly AnyUnit<K, E, R, W>[],
    readonly k: K,
    private readonly opts: RouterOptions<E, R, W>,
  ) {
    const ctx: UnitContext<K, E> = { k, unit: (name) => this.unit(name), dispatch: (e) => this.dispatch(e) };
    for (const u of units) {
      if (this.instances.has(u.name)) throw new Error(`controller unit "${u.name}" is defined twice`);
      this.instances.set(u.name, u.create(ctx));
      for (const [kind, on] of Object.entries(u.events ?? {})) {
        if (!on) continue;
        this.byKind.set(kind, [...(this.byKind.get(kind) ?? []), { unit: u.name, on: on as Handler<E, R, W> }]);
      }
      for (const [type, on] of Object.entries(u.messages ?? {})) {
        this.byMessage.set(type, [...(this.byMessage.get(type) ?? []), { unit: u.name, on }]);
      }
      for (const step of u.steps ?? []) this.steps.push({ unit: u.name, step });
    }
    this.steps.sort((a, b) => a.step.order - b.step.order);
  }

  /**
   * Startup problems: an event kind or message type no unit or several units accept (each has one deciding unit; one
   * with none would be dropped), a message type no topic of the controller delivers, a step order used twice.
   */
  problems(): string[] {
    const out: string[] = [];
    for (const kind of this.opts.kinds) if (!this.byKind.has(kind)) out.push(`event ${kind} is accepted by no unit`);
    for (const [kind, hs] of this.byKind) if (hs.length > 1) out.push(`event ${kind} is accepted by ${hs.map((h) => h.unit).join(", ")}`);
    for (const type of this.opts.messages) if (!this.byMessage.has(type)) out.push(`message ${type} is taken by no unit`);
    for (const [type, hs] of this.byMessage) {
      if (!this.opts.messages.includes(type)) out.push(`message ${type} (unit ${hs[0]!.unit}) is on no topic the controller consumes`);
      if (hs.length > 1) out.push(`message ${type} is taken by ${hs.map((h) => h.unit).join(", ")}`);
    }
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

  /** The event to the unit that accepts its kind, on `tick` (default: now); startup refused a kind no unit accepts. */
  async dispatch(e: E, tick: Tick = this.opts.now()): Promise<void> {
    const h = this.byKind.get(e.kind)?.[0];
    if (!h) return;
    const u = this.instances.get(h.unit);
    if (typeof h.on === "function") return h.on(u, e);
    const loaded = await h.on.load(u, e, this.opts.reader, tick);
    await this.opts.commit(h.on.decide(u, e, loaded, tick));
  }

  /** A bus message to the unit that takes its type (startup refused a type no unit takes). */
  async receive(m: Envelope): Promise<void> {
    const h = this.byMessage.get(m.type)?.[0];
    if (!h) throw new Error(`no controller unit takes message ${m.type}`);
    await h.on(this.instances.get(h.unit), m);
  }

  /** Every step whose `every` is in `kinds`, in order, each guarded, on `tick`. */
  async tick(kinds: readonly string[], tick: Tick): Promise<void> {
    for (const s of this.steps) {
      if (kinds.includes(s.step.every)) await this.opts.guard(s.step.name, () => this.run(s, tick));
    }
  }

  /** One step by name, unguarded (a manual tick in a test or the CLI). */
  async step(name: string, tick: Tick): Promise<void> {
    const s = this.steps.find((x) => x.step.name === name);
    if (!s) throw new Error(`no controller step "${name}"`);
    await this.run(s, tick);
  }

  private async run({ unit, step }: { unit: string; step: UnitStep<unknown, R, W> }, tick: Tick): Promise<void> {
    const u = this.instances.get(unit);
    if (!isPure(step)) return step.run(u);
    const loaded = await step.load(u, this.opts.reader, tick);
    await this.opts.commit(step.decide(u, loaded, tick));
  }
}

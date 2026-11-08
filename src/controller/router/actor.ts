// An actor's state table (RFC 0015 §6.1, §8): its states, where it starts, which states end it, and every
// allowed move. The router checks each decision against it before committing (M5); the state-machines
// architecture test checks the tables themselves. One `<actor>.actor.ts` per folder under controller/actors/.

export interface ActorDescriptor<S extends string = string> {
  readonly kind: "actor";
  readonly name: string;
  readonly states: readonly S[];
  readonly initial: readonly S[];
  readonly terminal: readonly S[];
  /** Allowed moves as `from → to` pairs; staying in a state is always allowed. */
  readonly transitions: readonly (readonly [S, S])[];
}

export const ACTOR_FILE = /\.actor\.(?:ts|js)$/;

export function defineActor<S extends string>(d: Omit<ActorDescriptor<S>, "kind">): ActorDescriptor<S> {
  return { kind: "actor", ...d };
}

/** Whether the actor may move from `from` to `to`. */
export function allowed<S extends string>(a: ActorDescriptor<S>, from: S, to: S): boolean {
  return from === to || a.transitions.some(([f, t]) => f === from && t === to);
}

/** Problems with a table: unknown states, moves out of a terminal state, states no path reaches. */
export function actorProblems(a: ActorDescriptor): string[] {
  const out: string[] = [];
  const known = new Set(a.states);
  for (const s of [...a.initial, ...a.terminal, ...a.transitions.flat()]) if (!known.has(s)) out.push(`${a.name}: unknown state ${s}`);
  for (const [f, t] of a.transitions) if (a.terminal.includes(f)) out.push(`${a.name}: ${f} is terminal but moves to ${t}`);
  if (a.initial.length === 0) out.push(`${a.name}: no initial state`);
  const reached = new Set(a.initial);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [f, t] of a.transitions) if (reached.has(f) && !reached.has(t)) { reached.add(t); grew = true; }
  }
  for (const s of a.states) if (!reached.has(s)) out.push(`${a.name}: ${s} is never reached`);
  return out;
}

// Discovery (RFC 0015 §6.1): the registry finds every `*.handler.ts` and `*.topic.ts` under src/ (`.js` once
// built) and indexes them; settings, roles and hooks are found the same way (`loadDescriptors`). Nothing
// registers itself in a central list, and nothing here names a feature.

import { relative } from "node:path";
import { pathToFileURL } from "node:url";
import type { Envelope, MessageKind } from "../../shared/envelope.js";
import type { HandlerDescriptor } from "../../shared/handler.js";
import type { TopicDescriptor } from "../../shared/topic.js";
import { findDescriptorFiles } from "../../state/index.js";

export { findDescriptorFiles };

export const DESCRIPTOR_PATTERNS = {
  handler: /\.handler\.(?:ts|js)$/,
  topic: /\.topic\.(?:ts|js)$/,
  setting: /\.setting\.(?:ts|js)$/,
  role: /\.role\.(?:ts|js)$/,
  hook: /\.hook\.(?:ts|js)$/,
  unit: /\.unit\.(?:ts|js)$/,
} as const;

export type DescriptorKind = keyof typeof DESCRIPTOR_PATTERNS;

export interface Located<D> {
  /** Path relative to the source root. */
  readonly file: string;
  readonly descriptor: D;
}

export class Registry {
  private readonly byType = new Map<string, Located<HandlerDescriptor>[]>();
  private readonly topicByType = new Map<string, Located<TopicDescriptor>>();

  constructor(
    readonly handlers: readonly Located<HandlerDescriptor>[],
    readonly topics: readonly Located<TopicDescriptor>[],
  ) {
    const names = new Map<string, string>();
    for (const h of handlers) {
      const seen = names.get(h.descriptor.name);
      if (seen) throw new Error(`handler name "${h.descriptor.name}" is used by ${seen} and ${h.file}`);
      names.set(h.descriptor.name, h.file);
      for (const type of h.descriptor.accepts) this.byType.set(type, [...(this.byType.get(type) ?? []), h]);
    }
    const topicNames = new Set<string>();
    for (const t of topics) {
      if (topicNames.has(t.descriptor.name)) throw new Error(`topic "${t.descriptor.name}" is declared twice (${t.file})`);
      topicNames.add(t.descriptor.name);
      for (const type of Object.keys(t.descriptor.messages)) {
        const other = this.topicByType.get(type);
        if (other) throw new Error(`message type ${type} is on two topics: ${other.descriptor.name} and ${t.descriptor.name}`);
        this.topicByType.set(type, t);
      }
    }
  }

  handlersFor(type: string): readonly HandlerDescriptor[] {
    return (this.byType.get(type) ?? []).map((h) => h.descriptor);
  }

  /** The handlers that take this message: accepted by type, then filtered by canHandle. */
  dispatch(m: Envelope): readonly HandlerDescriptor[] {
    return this.handlersFor(m.type).filter((h) => h.canHandle?.(m) ?? true);
  }

  topicOf(type: string): TopicDescriptor | null {
    return this.topicByType.get(type)?.descriptor ?? null;
  }

  kindOf(type: string): MessageKind | null {
    return this.topicOf(type)?.messages[type] ?? null;
  }

  /**
   * Dispatch rules (RFC 0015 §6.2): a command has exactly one handler; an accepted type must be on a topic; with
   * `consumed` (the components whose consumers the roles build), every handler sits in one of them, since a
   * handler no consumer subscribes would let its messages pile up unread. Returns every violation; startup
   * refuses a non-empty list.
   */
  problems(consumed?: readonly string[]): string[] {
    const out: string[] = [];
    if (consumed) {
      for (const h of this.handlers) {
        const component = h.file.split("/")[0]!;
        if (!consumed.includes(component)) out.push(`handler ${h.descriptor.name} (${h.file}) is in ${component}, which no role consumes (${consumed.join(", ")})`);
      }
    }
    for (const [type, located] of this.topicByType) {
      const kind = located.descriptor.messages[type];
      const n = this.handlersFor(type).length;
      if (kind === "command" && n !== 1) out.push(`command ${type} has ${n} handlers; a command needs exactly one`);
    }
    for (const type of this.byType.keys()) {
      if (!this.topicByType.has(type)) out.push(`message type ${type} is accepted by a handler but declared on no topic`);
    }
    return out;
  }
}

/** Imports every handler and topic descriptor under `root` and builds the registry. */
export async function loadRegistry(root: string): Promise<Registry> {
  const handlers = await loadDescriptors<HandlerDescriptor>(root, "handler");
  const topics = await loadDescriptors<TopicDescriptor>(root, "topic");
  return new Registry(handlers, topics);
}

/** Imports every descriptor of `kind` under `root`; a file whose default export is not its `define*` fails. */
export async function loadDescriptors<D extends { kind: string }>(root: string, kind: DescriptorKind): Promise<Located<D>[]> {
  const out: Located<D>[] = [];
  for (const file of findDescriptorFiles(root, DESCRIPTOR_PATTERNS[kind])) {
    const mod = (await import(pathToFileURL(file).href)) as { default?: { kind?: unknown } };
    if (mod.default?.kind !== kind) throw new Error(`${relative(root, file)}: default export must be define${kind[0]!.toUpperCase()}${kind.slice(1)}(...)`);
    out.push({ file: relative(root, file), descriptor: mod.default as unknown as D });
  }
  return out;
}

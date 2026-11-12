// Which `notify_channels` names reach an adapter that takes the owner's notices (design 12-notification-channels).
// Read once, when the unit is built: the configured sources are fixed for the kernel's life. It hands the unit plain
// data, a channel name and its adapter's type, never an adapter, so the unit can call no source; outbound does.

import type { Kernel } from "../kernel.js";

/** A channel in `notify_channels` whose adapter has `notifyOwner`, and that adapter's source type (its rows' target). */
export interface Notifier {
  readonly channel: string;
  readonly type: string;
}

/**
 * The notifier a channel name reaches, or null: the configured source whose type is the name, or the name and a
 * suffix (the `slack` plugin's `slack_thread`), when it has `notifyOwner`. Availability is the presence of the
 * method, never a source type known here. Built once per unit: `names` is read on each pass.
 */
export function notifiers(k: Pick<Kernel, "sources">): (names: readonly string[]) => Notifier[] {
  const able = k.sources.filter((s) => typeof s.notifyOwner === "function").map((s) => s.type);
  return (names) =>
    names.flatMap((channel) => {
      const type = able.find((t) => t === channel) ?? able.find((t) => t.startsWith(`${channel}_`));
      return type === undefined ? [] : [{ channel, type }];
    });
}

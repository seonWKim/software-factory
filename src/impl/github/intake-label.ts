// The intake label in force (design 08-settings, 2026-11-12): `intake_label` is settable, so the GitHub source reads
// the stored override, else the file's label, each time it lists new issues or files one. An open item keeps the
// label its issue already carries: nothing is relabelled.

import { parseSettable } from "../../core/settings.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";

export class LiveIntakeLabel {
  /** The label of the last read; a failed store read keeps it. */
  private inUse: string | null = null;

  constructor(
    /** The file's `intake_label`. */
    private readonly file: string,
    private readonly store: Pick<FactoryStore, "listSettingOverrides"> | null,
  ) {}

  /** The stored global override when it passes the config loader's check, else the file's label. */
  async current(): Promise<string> {
    if (!this.store) return this.file;
    try {
      const row = (await this.store.listSettingOverrides()).find((o) => o.key === "intake_label" && o.project === "");
      this.inUse = (row ? overrideLabel(row.value) : null) ?? this.file;
    } catch {
      // The store could not be read: keep the label in use; the next read tries again.
    }
    return this.inUse ?? this.file;
  }
}

/** A stored override's label, or null when it fails its check (resolveSettings ignores it the same way). */
function overrideLabel(value: string): string | null {
  try {
    return parseSettable("intake_label", JSON.parse(value));
  } catch {
    return null;
  }
}

/** A fixed label as it is; a live one as it stands now. */
export function labelOf(label: string | LiveIntakeLabel): Promise<string> {
  return typeof label === "string" ? Promise.resolve(label) : label.current();
}

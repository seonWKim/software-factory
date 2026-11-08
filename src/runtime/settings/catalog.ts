// The settings catalog (RFC 0015 §6.1, M10): every `*.setting.ts` under the code root, found by discovery. The
// catalog page docs/settings.md is generated from it (`npm run settings:catalog`), never written by hand.

import { join } from "node:path";
import type { SettingDescriptor } from "../../shared/setting.js";
import { type Located, loadDescriptors } from "../registry/registry.js";

/** The code root: src/ (tests) or dist/ (built); this file is src/runtime/settings/catalog.ts. */
export const CODE_ROOT = join(import.meta.dirname, "..", "..");

export class SettingCatalog {
  private readonly byKey = new Map<string, Located<SettingDescriptor>>();

  constructor(readonly entries: readonly Located<SettingDescriptor>[]) {
    for (const e of entries) {
      const seen = this.byKey.get(e.descriptor.key);
      if (seen) throw new Error(`setting "${e.descriptor.key}" is declared by ${seen.file} and ${e.file}`);
      this.byKey.set(e.descriptor.key, e);
    }
  }

  get(key: string): SettingDescriptor | null {
    return this.byKey.get(key)?.descriptor ?? null;
  }

  /** Every setting, by key. */
  all(): SettingDescriptor[] {
    return [...this.byKey.values()].map((e) => e.descriptor).sort((a, b) => a.key.localeCompare(b.key));
  }

  /** What `factory settings` and the Settings page show for a key: its description and when a change applies. */
  describe(key: string): { description: string; applies: string | null } {
    const s = this.get(key);
    if (!s) throw new Error(`no setting "${key}" in the catalog`);
    return { description: s.description, applies: s.applies };
  }
}

let cached: Promise<SettingCatalog> | null = null;

/** Loads the catalog from `root` (cached for the code root). */
export function loadSettingCatalog(root: string = CODE_ROOT): Promise<SettingCatalog> {
  if (root === CODE_ROOT && cached) return cached;
  const load = loadDescriptors<SettingDescriptor>(root, "setting").then((e) => new SettingCatalog(e));
  if (root === CODE_ROOT) cached = load;
  return load;
}

const cell = (v: string) => v.replace(/\|/g, "\\|");

/** docs/settings.md: one row per setting. Generated; `tests/architecture/settings-catalog.test.ts` checks it is fresh. */
export function renderSettingCatalog(c: SettingCatalog): string {
  const lines = [
    "# Settings catalog",
    "",
    "Generated from the `*.setting.ts` files by `npm run settings:catalog`; do not edit by hand.",
    "Direction: `tighten-only` keys may only be tightened by a lower level (owner → org → project → pack → user);",
    "`review` keys change only by a reviewed PR to factory.config.json. Guards are never loosened.",
    "",
    "| Key | Owner | Changed by | Scope | Direction | Class | Default | What it controls |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const s of c.all()) {
    const cls = s.guard ? "guard" : s.dial ? `dial${s.change_needs ? ` (${s.change_needs})` : ""}` : "";
    const dflt = s.default === null ? "" : `\`${cell(JSON.stringify(s.default))}\``;
    lines.push(`| \`${s.key}\` | ${s.owner} | ${s.changed_by} | ${s.scope} | ${s.direction} | ${cls} | ${dflt} | ${cell(s.description)} |`);
  }
  return lines.join("\n") + "\n";
}

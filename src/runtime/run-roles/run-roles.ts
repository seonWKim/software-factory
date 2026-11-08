// Discovered run roles (RFC 0015 §8) and the golden cases tied to each. A case names its role in case.json
// (`role`); a case without one is a review case, as every case `factory golden add` wrote before roles existed.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoleDescriptor } from "../../shared/role.js";
import { type Located, loadDescriptors } from "../registry/registry.js";
import { CODE_ROOT } from "../../state/index.js";

/** The role of a golden case with no `role` field. */
export const DEFAULT_GOLDEN_ROLE = "review";

export class RoleCatalog {
  private readonly byName = new Map<string, Located<RoleDescriptor>>();

  constructor(readonly entries: readonly Located<RoleDescriptor>[]) {
    for (const e of entries) {
      const seen = this.byName.get(e.descriptor.name);
      if (seen) throw new Error(`role "${e.descriptor.name}" is declared by ${seen.file} and ${e.file}`);
      this.byName.set(e.descriptor.name, e);
    }
  }

  get(name: string): RoleDescriptor | null {
    return this.byName.get(name)?.descriptor ?? null;
  }

  all(): RoleDescriptor[] {
    return [...this.byName.values()].map((e) => e.descriptor).sort((a, b) => a.name.localeCompare(b.name));
  }
}

let cached: Promise<RoleCatalog> | null = null;

export function loadRoles(root: string = CODE_ROOT): Promise<RoleCatalog> {
  if (root === CODE_ROOT && cached) return cached;
  const load = loadDescriptors<RoleDescriptor>(root, "role").then((e) => new RoleCatalog(e));
  if (root === CODE_ROOT) cached = load;
  return load;
}

/** Golden case ids per role, from `<casesDir>/<id>/case.json`. */
export function goldenCasesByRole(casesDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!existsSync(casesDir)) return out;
  for (const e of readdirSync(casesDir, { withFileTypes: true })) {
    const file = join(casesDir, e.name, "case.json");
    if (!e.isDirectory() || !existsSync(file)) continue;
    const c = JSON.parse(readFileSync(file, "utf8")) as { role?: unknown };
    const role = typeof c.role === "string" ? c.role : DEFAULT_GOLDEN_ROLE;
    out.set(role, [...(out.get(role) ?? []), e.name]);
  }
  return out;
}

/** Each role with fewer golden cases than it declares, with its count. */
export function rolesShortOfGolden(roles: RoleCatalog, casesDir: string): { role: string; cases: number; min: number }[] {
  const byRole = goldenCasesByRole(casesDir);
  return roles
    .all()
    .map((r) => ({ role: r.name, cases: byRole.get(r.name)?.length ?? 0, min: r.golden.min_cases }))
    .filter((r) => r.cases < r.min);
}

// Discovered run roles (RFC 0015 §8) and the golden cases tied to each. A role's cases live in its own folder,
// `src/worker/roles/<name>/golden/<case-id>/` (instruction.md, environment/diff.patch, case.json): the folder names
// the role. Every role folder is scanned; no list of roles lives in code.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { RoleDescriptor } from "../../shared/role.js";
import { type Located, loadDescriptors } from "../registry/registry.js";
import { CODE_ROOT, forgetOnFailure } from "../../state/index.js";

/** The roles folder, relative to the repo root: role `<name>` keeps its cases in `<name>/golden/<case-id>/`. */
export const ROLES_DIR = join("src", "worker", "roles");

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
  return root === CODE_ROOT ? (cached = forgetOnFailure(load, () => (cached = null))) : load;
}

/** Golden case ids per role, from `<rolesDir>/<role>/golden/<id>/case.json`, sorted by id (numeric first). */
export function goldenCasesByRole(rolesDir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const role of subdirs(rolesDir)) {
    const golden = join(rolesDir, role, "golden");
    const ids = subdirs(golden).filter((id) => existsSync(join(golden, id, "case.json")));
    if (ids.length > 0) out.set(role, ids.sort((a, b) => Number(a) - Number(b) || a.localeCompare(b)));
  }
  return out;
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name);
}

/** Each role with fewer golden cases than it declares, with its count. */
export function rolesShortOfGolden(roles: RoleCatalog, rolesDir: string): { role: string; cases: number; min: number }[] {
  const byRole = goldenCasesByRole(rolesDir);
  return roles
    .all()
    .map((r) => ({ role: r.name, cases: byRole.get(r.name)?.length ?? 0, min: r.golden.min_cases }))
    .filter((r) => r.cases < r.min);
}

import { ROLES, type GrantSource, type GrantSubject, type Role } from "../../interfaces/auth-provider.js";

/** `permissions.static`, checked: roles per factory user ID and project (`*` for every project), and denies. */
export interface StaticGrantConfig {
  roles: Readonly<Record<string, Readonly<Record<string, readonly Role[]>>>>;
  deny: Readonly<Record<string, readonly string[]>>;
}

const USER_ID = /^[a-z]+:\S+$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Checks `permissions.static` from factory.config.json; any problem fails startup. Absent: no roles, no denies. */
export function staticGrantConfig(raw: unknown): StaticGrantConfig {
  if (raw === undefined) return { roles: {}, deny: {} };
  if (!isObject(raw)) throw new Error("permissions.static must be an object with `roles` and `deny`");
  for (const k of Object.keys(raw)) {
    if (k !== "roles" && k !== "deny") throw new Error(`unknown key permissions.static.${k}; known keys: roles, deny`);
  }
  const user = (key: string, id: string) => {
    if (!USER_ID.test(id)) throw new Error(`${key}: ${JSON.stringify(id)} is not a factory user id (<provider>:<id>, e.g. github:12345)`);
  };
  const roles: Record<string, Record<string, Role[]>> = {};
  const rawRoles = raw.roles ?? {};
  if (!isObject(rawRoles)) throw new Error("permissions.static.roles must map a user id to { <project key or *>: [roles] }");
  for (const [id, byProject] of Object.entries(rawRoles)) {
    user("permissions.static.roles", id);
    if (!isObject(byProject)) throw new Error(`permissions.static.roles["${id}"] must map a project key or * to a list of roles`);
    roles[id] = {};
    for (const [project, list] of Object.entries(byProject)) {
      if (!Array.isArray(list) || !list.every((r) => (ROLES as readonly unknown[]).includes(r))) {
        throw new Error(`permissions.static.roles["${id}"]["${project}"] must be a list of roles: ${ROLES.join(", ")}`);
      }
      roles[id][project] = list as Role[];
    }
  }
  const deny: Record<string, string[]> = {};
  const rawDeny = raw.deny ?? {};
  if (!isObject(rawDeny)) throw new Error("permissions.static.deny must map a user id to a list of project keys or *");
  for (const [id, projects] of Object.entries(rawDeny)) {
    user("permissions.static.deny", id);
    if (!Array.isArray(projects) || !projects.every((p) => typeof p === "string" && p !== "")) {
      throw new Error(`permissions.static.deny["${id}"] must be a list of project keys or *`);
    }
    deny[id] = projects as string[];
  }
  return { roles, deny };
}

/**
 * Roles and denies written in config (design 2026-11-01): `permissions.static.roles[user][project]`, where
 * project `*` covers every project, and `permissions.static.deny[user]`, a list of projects or `*`. A deny here
 * overrides every grant from any source. No remote call.
 */
export class StaticGrant implements GrantSource {
  readonly remote = false;

  constructor(private readonly config: StaticGrantConfig) {}

  async denies(subject: GrantSubject, project: string | null): Promise<boolean> {
    const list = this.config.deny[subject.user_id] ?? [];
    return list.includes("*") || (project !== null && list.includes(project));
  }

  async roles(subject: GrantSubject, project: string | null): Promise<Role[]> {
    const byProject = this.config.roles[subject.user_id] ?? {};
    return [...new Set([...(byProject["*"] ?? []), ...(project !== null ? (byProject[project] ?? []) : [])])];
  }
}

// Local users on the dashboard (design 08-permissions and 09-dashboard-app, issue #445). GET /api/v1/users lists the
// local users (role, added by, added at), the users the `static` grant names (roles per project) and each listed
// user's linked accounts, with the viewer's identity, its source and role. Store reads only, no forge call: a user
// whose role comes only from GitHub permission is not listed. POST /api/v1/users adds, changes or removes a local
// user through the CLI's own `users` actions (runLocalCli), so the page and `factory users` share one path, its
// owner rule, its first-writer-is-owner claim and its audit row (`identity_local_user_changes`, written by the store). The
// request guards (Host, Origin, Content-Type, CSRF token, body size, JSON) run in server.ts; then the body; then
// the owner check inside runLocalCli. Every refusal comes before any store write.

import { ANONYMOUS, type CliAction, type CliIdentity, parseLocalCliArgs, runLocalCli } from "../core/local-cli.js";
import type { Logger } from "../core/log.js";
import type { UserId } from "../core/types.js";
import { staticGrantConfig } from "../impl/grant/static.js";
import type { Role } from "../interfaces/auth-provider.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./pages.js";
import { Withholder } from "./withhold.js";

export const USERS_PATH = "/api/v1/users";

const ANONYMOUS_USER = `local:${ANONYMOUS}`;

/** A user the `static` grant gives roles, per project key (`*` for every project). */
export interface StaticUser {
  user_id: UserId;
  projects: { project: string; roles: Role[] }[];
}

/** What the users routes need beside the store. Built once per UI process (compose.ts buildUiParts). */
export interface UiUsers {
  /** The identity the UI process starts with (cliIdentity): the viewer, and who every users write acts as. */
  identity: CliIdentity;
  /** The selected grants (`permissions.grants`) and `permissions.static`: its users are listed when `static` is selected. */
  permissions: { grants: readonly string[]; static: unknown };
  /** The per-process token every write route shares; POST must send it in x-csrf-token. */
  csrfToken: string;
  log: Logger;
}

/** The UI's dependencies with the users routes. Absent `users`: GET is a 404 and POST a 405. */
export type UsersDeps = UiDeps & { users?: UiUsers };

/** `permissions.static.roles` (checked by staticGrantConfig) as the page's rows, in config order; none unless `static` is selected. */
function staticUsers(p: UiUsers["permissions"]): StaticUser[] {
  if (!p.grants.includes("static")) return [];
  return Object.entries(staticGrantConfig(p.static).roles).map(([user_id, byProject]) => ({
    user_id: user_id as UserId,
    projects: Object.entries(byProject).map(([project, list]) => ({ project, roles: [...list] })),
  }));
}

/** runLocalCli's refusal for anyone but the owner; the page shows it before a write is tried. */
const ownerOnly = (owner: string | null, user: string) => `only the local owner (${owner ?? "none yet"}) can change roles; you are ${user}`;

/** GET /api/v1/users. Every stored or configured ID leaves through the Withholder. */
export async function readUsers(d: UsersDeps, u: UiUsers) {
  const w = new Withholder(d.scanner);
  const text = async (v: string) => (await w.plain(v)).text;
  const links = async (user_id: UserId) =>
    Promise.all((await d.store.listLinks(user_id)).map(async (l) => ({ provider: l.provider, subject: await text(l.subject) })));
  const locals = await d.store.listLocalUsers();
  const users = [];
  for (const l of locals) {
    users.push({
      user_id: await text(l.user_id), role: l.role, source: "local" as const, added_by: await text(l.added_by), added_at: l.created_at,
      projects: [], links: await links(l.user_id),
    });
  }
  const statics = staticUsers(u.permissions);
  for (const s of statics) {
    const roles = s.projects.flatMap((p) => p.roles);
    users.push({
      user_id: await text(s.user_id), role: roles.includes("approver") ? "approver" : "requester", source: "static" as const,
      added_by: null, added_at: null, projects: s.projects, links: await links(s.user_id),
    });
  }
  const me = u.identity.user;
  const owner = locals.find((l) => l.role === "owner")?.user_id ?? null;
  // As runLocalCli decides: the owner may write; with no owner yet, the first named identity to write becomes it.
  const canChange = owner === me || (owner === null && me !== ANONYMOUS_USER);
  const staticRoles = statics.find((s) => s.user_id === me)?.projects.flatMap((p) => p.roles) ?? [];
  const role = locals.find((l) => l.user_id === me)?.role ?? (staticRoles.length ? (staticRoles.includes("approver") ? "approver" : "requester") : null);
  return {
    as_of: d.clock.now().toISOString(),
    csrf_token: u.csrfToken,
    viewer: { user_id: await text(me), source: u.identity.from, role },
    can_change: canChange,
    read_only_reason: canChange ? null : await text(ownerOnly(owner, me)),
    users,
  };
}

type UsersWrite = { action: "add" | "change" | "remove"; user_id: string; role?: "approver" | "requester" };

/** The POST body as one of the CLI's `users` actions, or why it is not one. */
function parseWrite(body: unknown): CliAction | { error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { error: "the body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).find((k) => k !== "action" && k !== "user_id" && k !== "role");
  if (extra) return { error: `unknown field "${extra}"` };
  if (b.action !== "add" && b.action !== "change" && b.action !== "remove") return { error: "action must be add, change or remove" };
  if (typeof b.user_id !== "string") return { error: "user_id must be a string" };
  const w = b as UsersWrite;
  if (w.action === "remove" && b.role !== undefined) return { error: "remove takes no role" };
  if (w.action !== "remove" && b.role !== "approver" && b.role !== "requester") return { error: "role must be approver or requester" };
  // `change` is `users add` on a user who has a role: the store tells the two apart in its audit row.
  const parsed = parseLocalCliArgs("users", w.action === "remove" ? ["remove", w.user_id] : ["add", w.user_id, "--role", w.role!]);
  if ("error" in parsed) return { error: "user_id must be a factory user ID: local:<name> or <provider>:<id>, such as local:dev@example.com" };
  if (w.user_id === ANONYMOUS_USER && w.role === "approver") return { error: "anonymous gets read and create only: it cannot be an approver" };
  return parsed;
}

const never = (what: string) => () => Promise.reject(new Error(`the users actions do not ${what}`));

/**
 * POST /api/v1/users with `{ action: add|change|remove, user_id, role? }`, after the request guards: 400 for a body
 * that is not one; 403 when the viewer is not the owner (runLocalCli's reason); 409 for the owner's own row; else
 * 200 with what changed and the read model.
 */
export async function writeUsers(d: UsersDeps, u: UiUsers, body: unknown): Promise<ApiResult> {
  const action = parseWrite(body);
  if ("error" in action) return { status: 400, value: { error: action.error } };
  const r = await runLocalCli({ store: d.store, identity: u.identity, project: never("read the project"), read: never("read files"), newId: () => "" }, action);
  const line = r.lines[0] ?? "";
  if (r.code !== 0) return { status: line.startsWith("only the local owner") ? 403 : 409, value: { error: line } };
  const b = body as UsersWrite;
  u.log.info("local user changed", { action: b.action, user_id: b.user_id, ...(b.role ? { role: b.role } : {}), actor: u.identity.user });
  return { status: 200, value: { done: line, ...(await readUsers(d, u)) } };
}

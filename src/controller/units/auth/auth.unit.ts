// Authorizes a person's command by the one owner check (design 08-permissions, One owner): whatever its origin (a
// forge comment, Slack, the CLI, the dashboard), the caller's identity resolved to a factory user must be the store's
// local owner. The controller's automatic steps are authorized under its service passport instead. Each is a check
// through the kernel's reader.

import { refusalReply } from "../../../core/authorize.js";
import type { AuthAction, ExternalIdentity, Principal } from "../../../interfaces/auth-provider.js";
import { type Refusal } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Authorizes a person's command by the owner check, and the controller's automatic steps by its service passport. */
export class AuthUnit {
  constructor(private readonly c: Ctx) {}

  async authorize(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const principal = await this.c.k.reader.auth.owner.resolve(identity);
    if (!principal) return { refuse: refusalReply("not_linked") };
    return this.allowed(principal, action, resource);
  }

  /** The permission half of `authorize`, for a principal already known (an app request names its user). */
  async allowed(principal: Principal, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const decision = await this.c.k.reader.auth.owner.authorize(principal, action, { kind: "work_item", id: resource });
    if (decision.allow) return principal;
    this.c.k.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
    return { refuse: refusalReply(decision.reason) };
  }

  /**
   * An automatic step of the controller (auto mode's spec approval or merge) on `it`, under the controller's service
   * passport. The refusal, or null when allowed (also with no Identity wired).
   */
  async automatic(action: "approve_spec" | "approve_merge", it: { project: string; id: string }): Promise<string | null> {
    const check = this.c.k.reader.auth.service;
    if (!check) return null;
    const decision = await check(action, { project: it.project, item: it.id });
    if (decision.allow) return null;
    this.c.k.d.log.warn("automatic step refused", { work_item_id: it.id, action, reason: decision.reason });
    return `the controller's service passport does not allow it (\`${decision.reason}\`)`;
  }
}

declare module "../../router/unit.js" {
  interface UnitOperations {
    "auth": AuthUnit;
  }
}

export default controllerUnit({
  name: "auth",
  create: (c: Ctx) => new AuthUnit(c),
});

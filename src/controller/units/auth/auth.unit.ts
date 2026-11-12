// Authorizes a person's command under the command's passport (RFC 0015 §8, M9): Identity checks the passport, and the
// one owner check decides (design 08-permissions, issue #575), whatever the surface: GitHub, Slack, the CLI or the
// dashboard. The controller's automatic steps are authorized under its service passport. Each is a check through the
// kernel's reader.

import { NOT_OWNER, NOT_OWNER_REPLY, type AuthAction, type CommandPassport, type ExternalIdentity, type Principal } from "../../../interfaces/auth-provider.js";
import { type Refusal } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Authorizes a person's command by the owner check, from any surface. */
export class AuthUnit {
  constructor(private readonly c: Ctx) {}

  async authorize(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const principal = await this.c.k.reader.auth.owner.resolve(identity);
    if (!principal) {
      if (identity.provider === "local") return { refuse: "your local identity resolves to no factory user" };
      return { refuse: "your account is not linked to a factory user; link it with `/link <code>` (code from `factory link-code <user_id>`)" };
    }
    return this.decide(principal, action, resource, identity.passport);
  }

  /**
   * The permission half of `authorize`, for a principal already known (an app request names its user). `_local`: the
   * command came from the CLI, the dashboard or chat; the owner check is the same for every surface, so it is unused.
   * `passport`: the command's edge passport, which Identity checks first (absent: a row from before M9).
   */
  allowed(principal: Principal, action: AuthAction, resource: string, _local = false, passport?: CommandPassport): Promise<Principal | Refusal> {
    return this.decide(principal, action, resource, passport);
  }

  private async decide(principal: Principal, action: AuthAction, resource: string, passport?: CommandPassport): Promise<Principal | Refusal> {
    const decision = await this.c.k.reader.auth.owner.authorize(principal, action, { kind: "work_item", id: resource }, passport);
    if (!decision.allow) {
      this.c.k.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      if (decision.reason === NOT_OWNER) return { refuse: NOT_OWNER_REPLY };
      return { refuse: `it is not allowed (\`${decision.reason}\`)` };
    }
    return principal;
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

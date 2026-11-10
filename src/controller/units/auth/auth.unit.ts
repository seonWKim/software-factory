// Authorizes a person's command under the command's passport (RFC 0015 §8, M9): Identity checks the passport, and the
// auth plugin of the command's origin decides the role: the local one (the CLI, the app and chat accounts by
// default), the Slack one (Slack threads, issue #486, when config names one) or the forge's (forge identities). The
// controller's automatic steps are authorized under its service passport. Each is a check through the kernel's reader.

/**
 * Providers the local auth plugin judges by default (design 08-permissions, issue #498): the CLI and the app
 * (`local`), and chat accounts (`slack`), which act as the factory user they are linked to, with that user's stored
 * role. `auth.slack_thread` names another plugin for Slack (issue #486).
 */
const LOCALLY_JUDGED: readonly string[] = ["local", "slack"];

import type { AuthAction, AuthProvider, CommandPassport, ExternalIdentity, Principal } from "../../../interfaces/auth-provider.js";
import { type Refusal } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Authorizes a person's command by the auth plugin of its origin: local, Slack thread, or the forge's for the rest. */
export class AuthUnit {
  constructor(private readonly c: Ctx) {}

  async authorize(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const local = LOCALLY_JUDGED.includes(identity.provider);
    const plugin = this.plugin(identity.provider);
    const principal = await plugin.resolve(identity);
    if (!principal) {
      if (identity.provider === "local") return { refuse: "your local identity resolves to no factory user under the local auth plugin" };
      return { refuse: "your account is not linked to a factory user; link it with `/link <code>` (code from `factory link-code <user_id>`)" };
    }
    return this.decide(plugin, principal, action, resource, local, identity.passport);
  }

  /**
   * The auth plugin of a command's origin: the local one for the CLI and the local UI (issue #318), the Slack one
   * for Slack threads (issue #486; the local one unless config names one, issue #498), else the forge's.
   */
  private plugin(provider: ExternalIdentity["provider"]): AuthProvider {
    const { forge, local, slack } = this.c.k.reader.auth;
    if (provider === "local") return local ?? forge;
    return provider === "slack" ? slack : forge;
  }

  /**
   * The permission half of `authorize`, for a principal already known (an app request names its user). `local`:
   * a command from the CLI, the local UI or chat, checked by the local auth plugin. `passport`: the command's edge
   * passport, which Identity checks first (absent: a row from before M9; the plugin alone decides).
   */
  allowed(principal: Principal, action: AuthAction, resource: string, local = false, passport?: CommandPassport): Promise<Principal | Refusal> {
    return this.decide(this.plugin(local ? "local" : "github"), principal, action, resource, local, passport);
  }

  private async decide(plugin: AuthProvider, principal: Principal, action: AuthAction, resource: string, local: boolean, passport?: CommandPassport): Promise<Principal | Refusal> {
    const decision = await plugin.authorize(principal, action, { kind: "work_item", id: resource }, passport);
    if (!decision.allow) {
      this.c.k.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      if (local && this.c.k.reader.auth.local) {
        return { refuse: `${principal.user_id} has no role that allows it (\`${decision.reason}\`); the local owner can grant one with \`factory users add ${principal.user_id} --role approver\`` };
      }
      return { refuse: `it needs write permission on this repository (\`${decision.reason}\`)` };
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

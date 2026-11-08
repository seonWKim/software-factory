// Authorizes a person's command: the forge's auth plugin for forge identities, the local one for the CLI and the app.
// Moved out of the legacy controller (RFC 0015 M5); its I/O is still inline (unit-purity ratchet).

import type { AuthAction, AuthProvider, ExternalIdentity, Principal } from "../../../interfaces/auth-provider.js";
import { type Refusal } from "../support.js";
import type { Ctx } from "../context.js";
import { controllerUnit } from "../context.js";

/** Authorizes a person's command: the forge's auth plugin for forge identities, the local one for the CLI and the app. */
export class AuthUnit {
  constructor(private readonly c: Ctx) {}

  async authorize(identity: ExternalIdentity, action: AuthAction, resource: string): Promise<Principal | Refusal> {
    const local = identity.provider === "local";
    const principal = await (local ? this.localAuth : this.c.k.d.auth).resolve(identity);
    if (!principal) {
      if (local) return { refuse: "your local identity resolves to no factory user under the local auth plugin" };
      return { refuse: "your account is not linked to a factory user; link it with `/link <code>` (code from `factory link-code <user_id>`)" };
    }
    return this.allowed(principal, action, resource, local);
  }

  /** The auth plugin for local commands: the CLI and the local UI (issue #318). */
  get localAuth(): AuthProvider {
    return this.c.k.d.local_auth ?? this.c.k.d.auth;
  }

  /**
   * The permission half of `authorize`, for a principal already known (an app request names its user). `local`:
   * a command from the CLI or the local UI, checked by the local auth plugin.
   */
  async allowed(principal: Principal, action: AuthAction, resource: string, local = false): Promise<Principal | Refusal> {
    const decision = await (local ? this.localAuth : this.c.k.d.auth).authorize(principal, action, { kind: "work_item", id: resource });
    if (!decision.allow) {
      this.c.k.d.log.warn("unauthorized", { user_id: principal.user_id, action, reason: decision.reason });
      if (local && this.c.k.d.local_auth) {
        return { refuse: `${principal.user_id} has no role that allows it (\`${decision.reason}\`); the local owner can grant one with \`factory users add ${principal.user_id} --role approver\`` };
      }
      return { refuse: `it needs write permission on this repository (\`${decision.reason}\`)` };
    }
    return principal;
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

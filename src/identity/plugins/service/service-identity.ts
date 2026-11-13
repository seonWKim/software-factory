// Service passports (RFC 0015 §8): a factory component acting with no person behind it (the controller's
// automatic steps, the worker's tool calls, outbound's deliveries) authenticates as itself. Only the `service`
// provider resolves a `service:` principal, and each service's passport is limited to the actions it takes.

import type { Action, AuthProvider, ExternalIdentity, Principal, Restrictions } from "../../passport/types.js";

export type ServiceName = "controller" | "worker" | "outbound";

/** What each service may do at all; a run passport narrows the worker's further. */
export const SERVICE_ACTIONS: Readonly<Record<ServiceName, readonly Action[]>> = {
  // Automatic spec approval and merge in auto mode (design 08-permissions).
  controller: ["approve_spec", "approve_merge"],
  // Credentialed tool calls through the ToolBroker (G2), always under a run passport.
  worker: ["use_tool"],
  // Comments, labels and replies on the sources.
  outbound: ["use_tool"],
};

export const SERVICE_PREFIX = "service:";

export function serviceUser(name: ServiceName): string {
  return `${SERVICE_PREFIX}${name}`;
}

export function serviceRestrictions(name: ServiceName): Restrictions {
  return { actions: SERVICE_ACTIONS[name] };
}

/** Resolves only the known service names, and only for the `service` provider. */
export class ServiceAuthProvider implements AuthProvider {
  readonly provider = "service" as const;

  async resolve(identity: ExternalIdentity): Promise<Principal | null> {
    if (identity.provider !== "service" || !(identity.subject in SERVICE_ACTIONS)) return null;
    return { user_id: serviceUser(identity.subject as ServiceName) };
  }
}

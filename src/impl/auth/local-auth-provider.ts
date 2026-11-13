import { OwnerAuth, type OwnerStore } from "../../core/authorize.js";
import type { GrantSource } from "../../interfaces/auth-provider.js";

/**
 * Deprecated (phase A of issue #575): nothing selects the `local` auth plugin. It is the owner check itself
 * (src/core/authorize.ts), so the one caller that still builds it by name (the Slack source's Good, Bad and Feedback
 * taps) takes the same check as every command. Its grants are ignored. Phase B removes this file.
 */
export class LocalAuthProvider extends OwnerAuth {
  constructor(store: OwnerStore, _grants: readonly GrantSource[] = []) {
    super(store);
  }
}

import { OwnerAuth } from "../../core/authorize.js";
import type { FactoryStore } from "../../interfaces/factory-store.js";

/**
 * The owner check (`OwnerAuth`) over the store alone, for a plugin that builds its own check with no `cli_user` to
 * claim the owner: the Slack source's Good, Bad and Feedback taps. Only a stored owner is the owner. Not a plugin:
 * the `local` auth plugin was removed with the others (issue #575).
 */
export class LocalAuthProvider extends OwnerAuth {
  constructor(store: Pick<FactoryStore, "resolveLink" | "getLocalUser" | "claimLocalOwner">) {
    super({ store, claimer: null });
  }
}

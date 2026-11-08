// Identity in a running process (RFC 0015 §8, M9): the passport service on the store's database, signed with the
// solo key in the state folder, with its `revocations` tick running. Every factory process that authenticates at
// the edge (CLI, UI), mints run or service passports (worker, controller) or checks them (ToolBroker) starts one.

import { join } from "node:path";
import { TimeBasedTickGenerator } from "../../shared/ticks/plugins/time-based/time-based-tick-generator.js";
import type { SqlExecutor } from "../../state/index.js";
import { secretKeyring } from "../passport/keys.js";
import { PassportService } from "../passport/service.js";
import type { AuthProvider, ExternalIdentity, GrantSource, Origin, PassportId } from "../passport/types.js";
import { LOCAL_KEY_FILE, localKeyFile } from "../plugins/local/local-key.js";
import { LocalAuthProvider } from "../plugins/local/local-identity.js";

/** The passport key's name; a SecretStore value under it replaces the local key file (enterprise, not wired yet). */
export const PASSPORT_KEY = "SF_PASSPORT_KEY";

export interface IdentityRuntime {
  readonly passports: PassportService;
  /** A person passport for a command entering at `origin`; its id goes on the command row. */
  edge(identity: ExternalIdentity, origin: Origin): Promise<PassportId>;
  stop(): Promise<void>;
}

export async function startIdentity(o: {
  db: SqlExecutor;
  stateDir: string;
  /** Beside the local provider (and the built-in service one). */
  providers?: readonly AuthProvider[];
  grants?: readonly GrantSource[];
  onError?: (schedule: string, err: unknown) => void;
}): Promise<IdentityRuntime> {
  const ticks = new TimeBasedTickGenerator(o.onError);
  const passports = new PassportService({
    db: o.db,
    keys: secretKeyring(localKeyFile(join(o.stateDir, LOCAL_KEY_FILE), PASSPORT_KEY), { current: PASSPORT_KEY }),
    providers: [new LocalAuthProvider(), ...(o.providers ?? [])],
    grants: o.grants ?? [],
    ticks,
  });
  const stop = new AbortController();
  const running = ticks.run(stop.signal);
  await passports.ready();
  return {
    passports,
    edge: async (identity, origin) => (await passports.authenticate(identity, origin)).passport.id,
    stop: async () => {
      stop.abort();
      await running;
    },
  };
}

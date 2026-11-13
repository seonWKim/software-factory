// Identity component (RFC 0015 §7, §8): authenticate once at the edge, authorize(passport, action, resource),
// narrow passports for runs and tool calls, revoke, and audit every decision. Other components import only
// this file. It never holds or returns a secret: the keyring signs, and only token hashes are stored.

export type {
  Action,
  AuthProvider,
  Authorization,
  AuthzResult,
  ExternalIdentity,
  Issued,
  NarrowRequest,
  Origin,
  Passport,
  PassportChecker,
  PassportId,
  PassportKind,
  Principal,
  Provider,
  ResourceRef,
  RoleCheck,
  Restrictions,
  Role,
} from "./passport/types.js";
export { ACTIONS, ROLE_ACTIONS } from "./passport/types.js";
export { NotAuthenticated, PassportService, REVOCATIONS_TICK, type IdentityOptions } from "./passport/service.js";
export type { PassportKeyring, SigningKey } from "./passport/token.js";
export { secretKeyring, type SecretProvider } from "./passport/keys.js";
export { ANONYMOUS_USER, LocalAuthProvider, localIdentity, type LocalEnvironment } from "./plugins/local/local-identity.js";
export { readLocalEnvironment } from "./plugins/local/local-environment.js";
export { LOCAL_KEY_FILE, localKeyFile } from "./plugins/local/local-key.js";
export { SERVICE_ACTIONS, ServiceAuthProvider, serviceUser, type ServiceName } from "./plugins/service/service-identity.js";
export { PASSPORT_KEY, startIdentity, type IdentityRuntime } from "./runtime/start.js";
export { DISPLAY_NAME_MAX, ProfileStore, checkDisplayName, type Profile, type ProfileSource } from "./profiles/profiles.js";
export { recordLocalUserChange, type LocalUserChange } from "./local-users/changes.js";

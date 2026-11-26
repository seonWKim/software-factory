// The checked-in list of capability declaration files (design 09-api-registry, owner answer 2): one import per file
// in src/api/capabilities/, spread into DECLARATIONS. A new declaration file adds its line here;
// tests/api-registry.test.ts fails while a file is missing from this list or the list names a file that is gone.
// After a change, `npm run gen:api` rewrites docs/api/openapi.json and web/src/api/generated.ts.

import type { ServerDeps } from "../ui/server.js";
import { type Declared, type Registry, type RegistryDeps, buildRegistry } from "./registry.js";

/** Every declared capability. None in phase 1: only the tests declare a fixture. */
export const DECLARATIONS: readonly Declared[] = [];

export const REGISTRY: Registry = buildRegistry(DECLARATIONS);

/** The registry a server answers from: a test's own (`api_registry`), else the declared one. */
export const registryOf = (d: ServerDeps & RegistryDeps): Registry => d.api_registry ?? REGISTRY;

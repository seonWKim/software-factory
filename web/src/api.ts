// The app talks only to the JSON API under /api/v1 (design §9); nothing else is fetched. This file only re-exports
// web/src/api/: one file per resource holds its endpoints, types, hooks and POST helpers (client.ts: the shared
// fetch, polling and CSRF retry; routes.ts: the route map). A new endpoint goes in its resource file.

export { POLL_MS, getJson, postJson, useApi, useManualApi } from "./api/client.js";
export * from "./api/routes.js";
export * from "./api/overview.js";
export * from "./api/health.js";
import type { Health } from "./api/health.js";
/** A Health check row with the action the server offers on it (design 09-health, 2026-11-23): the Add model credential dialog. */
export type HealthCheck = Health["checks"][number] & { action?: "add_model_credential" };
export * from "./api/items.js";
export * from "./api/item-commands.js";
export * from "./api/supervisor.js";
export * from "./api/system.js";
export * from "./api/settings.js";
export * from "./api/plugins.js";
export * from "./api/rules.js";
export * from "./api/proposals.js";
export * from "./api/tasks.js";
export * from "./api/calendar.js";
export * from "./api/routines.js";
export * from "./api/schedules.js";
export * from "./api/data.js";
export * from "./api/model-credential.js";

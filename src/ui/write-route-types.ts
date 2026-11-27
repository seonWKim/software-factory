// The shape of one dashboard POST route and the CSRF token helpers the area route lists share (write-routes-*.ts),
// so they do not import write-routes.ts, the guard chain that concatenates them.

import type { ApiResult } from "./api.js";
import type { ServerDeps } from "./server.js";

/** One POST route: when it is wired for `path`, the CSRF token it checks, and its handler (after the guards). */
export interface WriteRoute {
  matches(d: ServerDeps, path: string): boolean;
  token(d: ServerDeps): string;
  run(d: ServerDeps, path: string, body: unknown): ApiResult | Promise<ApiResult>;
}

export const settingsToken = (d: ServerDeps): string => d.settings!.csrfToken;
export const pausesToken = (d: ServerDeps): string => d.pauses!.csrfToken;

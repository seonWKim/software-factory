// The feature map (design 09-api-registry): what the factory can do, read from the registry's declarations, so the
// dashboard, chat and CLI find a capability without a hand-kept list. Three GETs:
//   /api/v1/feature-map/areas                  every area with its capability ids
//   /api/v1/feature-map/capabilities           every capability: id, area, description, permission, method, path
//   /api/v1/feature-map/capabilities/<id>      one capability with its input and output JSON Schemas
// The text is the declarations' own (code, not store text), so it needs no Withholder.

import type { ApiResult } from "../ui/api.js";
import type { Declared, Registry } from "./registry.js";

export const FEATURE_MAP_PREFIX = "/api/v1/feature-map/";
const AREAS = `${FEATURE_MAP_PREFIX}areas`;
const CAPABILITIES = `${FEATURE_MAP_PREFIX}capabilities`;

/** True for /api/v1/feature-map and every path under it. */
export const isFeatureMapPath = (path: string): boolean => path === FEATURE_MAP_PREFIX.slice(0, -1) || path.startsWith(FEATURE_MAP_PREFIX);

const summary = (c: Declared) => ({ id: c.id, area: c.area, description: c.description, permission: c.permission, method: c.method, path: c.path });

/** The areas, sorted, each with its capability ids in id order. */
function areas(r: Registry): { id: string; capabilities: string[] }[] {
  const by = new Map<string, string[]>();
  for (const c of r.capabilities) by.set(c.area, [...(by.get(c.area) ?? []), c.id]);
  return [...by].sort(([a], [b]) => a.localeCompare(b)).map(([id, capabilities]) => ({ id, capabilities }));
}

/** The feature map's answer for a path under /api/v1/feature-map (404 for any other there), else null. */
export function readFeatureMap(r: Registry, path: string): ApiResult | null {
  if (!isFeatureMapPath(path)) return null;
  if (path === AREAS) return { status: 200, value: { areas: areas(r) } };
  if (path === CAPABILITIES) return { status: 200, value: { capabilities: r.capabilities.map(summary) } };
  if (path.startsWith(`${CAPABILITIES}/`)) {
    let id: string;
    try {
      id = decodeURIComponent(path.slice(CAPABILITIES.length + 1));
    } catch {
      return { status: 404, value: { error: "No such capability." } };
    }
    const c = r.capabilities.find((x) => x.id === id);
    return c ? { status: 200, value: { capability: { ...summary(c), input: c.input.json(), output: c.output.json() } } } : { status: 404, value: { error: "No such capability." } };
  }
  return { status: 404, value: { error: "Not found." } };
}

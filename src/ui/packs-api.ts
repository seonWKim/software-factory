// The dashboard's approve action for pack tools and MCP servers (design 11-packs, issue #589). POST
// /api/v1/packs/approvals with `{ "action": "approve" | "revoke", "kind": "tool" | "mcp_server", "name": <name>,
// "description_hash"?: <prefix> }` approves or revokes one stored description, through the same path as `factory pack
// approve|revoke` (changeApproval): `approve_tool` through the page's auth plugin, then one ext_packs_approvals row with
// the page's factory user ID. The request guards (Host, Origin, Content-Type, CSRF token, body size, JSON) run in
// server.ts first; every refusal comes before any store write.

import { storeSql } from "../impl/store/sql/store-sql.js";
import { type ApprovalRequest, PackApprovalsStore, approvalLine, changeApproval } from "../packs/pack-approvals.store.js";
import { PackEntriesStore } from "../packs/pack-entries.store.js";
import type { ApiResult } from "./api.js";
import type { PauseDeps, UiPauses } from "./pause-api.js";

export const PACK_APPROVALS_PATH = "/api/v1/packs/approvals";

/** The body as a request, or why it is not one. */
function request(body: unknown): ApprovalRequest | string {
  const b = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (b.action !== "approve" && b.action !== "revoke") return "action must be approve or revoke";
  if (typeof b.kind !== "string" || typeof b.name !== "string" || b.name === "") return "kind and name must be strings";
  if (b.description_hash !== undefined && (typeof b.description_hash !== "string" || b.description_hash === "")) return "description_hash must be a non-empty string";
  return { action: b.action, kind: b.kind, name: b.name, ...(b.description_hash === undefined ? {} : { hash: b.description_hash }) };
}

/** POST /api/v1/packs/approvals, after the request guards. `p.auth` is set (the route is wired only then). */
export async function writePackApproval(d: PauseDeps, p: UiPauses, body: unknown): Promise<ApiResult> {
  const r = request(body);
  if (typeof r === "string") return { status: 400, value: { error: r } };
  const user_id = await p.principal();
  if (user_id === null) return { status: 403, value: { error: "No factory user acts from this page: link your local account or set cli_user." } };
  const db = storeSql(d.store);
  const now = () => d.clock.now().toISOString();
  const result = await changeApproval({ auth: p.auth!, entries: new PackEntriesStore(db, now), approvals: new PackApprovalsStore(db, now), user_id }, r);
  if (!result.ok) return { status: result.refusal === "not_allowed" ? 403 : 404, value: { error: approvalLine(r, result) } };
  return { status: 200, value: { ...result.ref, action: r.action, line: approvalLine(r, result) } };
}

// POST /api/v1/attachments (design 02-attachments, design 09-dashboard-item): the item page's Attach dialog, one image
// (`{ id, kind: "image", name, data }`, base64) or one link (`{ id, kind: "link", url, label }`) on a New or in-triage
// item, stored through core/attachments.ts `attach`, the same path and refusals as `factory attach`. The page's
// commands actor (UiCommands) is the one who attaches, under the owner check the item commands use. The request guards
// (Host, Origin, Content-Type, CSRF token, the larger body limit MAX_ATTACH_BODY, JSON) run before this is reached;
// every refusal comes before the store write. The route table (write-routes.ts, the composition root) hands it
// `attach`, so this route imports no core module.

import { randomUUID } from "node:crypto";
import type { AttachDeps, AttachInput, Attachment } from "../core/attachments.js";
import type { UserId, WorkItem, WorkItemId } from "../core/types.js";
import type { ApiResult } from "./api.js";
import type { UiDeps } from "./deps.js";

export const ATTACH_PATH = "/api/v1/attachments";
/** The largest attach body: a 5 MB image as base64 (4/3 larger) and the JSON around it. */
export const MAX_ATTACH_BODY = 7 * 1024 * 1024;

/** core/attachments.ts `attach`, as the route table hands it in. */
export type AttachFn = (d: AttachDeps, item: WorkItem, input: AttachInput, by: UserId) => Promise<{ attachment: Attachment } | { refuse: string }>;

const refused = (status: 400 | 403 | 404 | 409 | 503, error: string): ApiResult => ({ status, value: { error } });
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The input a body asks for, or why it is not one. A base64 image is decoded here; its type and size are `attach`'s checks. */
function inputOf(b: Record<string, unknown>): AttachInput | string {
  if (b.kind === "link") {
    const url = str(b.url);
    return url === null ? "a link needs `url`" : { kind: "link", url, label: str(b.label) };
  }
  if (b.kind === "image") {
    const data = str(b.data), name = str(b.name) ?? "image";
    if (data === null || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return "an image needs `data`, its bytes as base64";
    return { kind: "image", bytes: new Uint8Array(Buffer.from(data, "base64")), name };
  }
  return "`kind` must be image or link";
}

/** POST /api/v1/attachments: 200 with the stored attachment's line fields; 409 with the one refusal `factory attach` gives. */
export async function writeAttachment(d: UiDeps, body: unknown, attach: AttachFn): Promise<ApiResult> {
  const actor = d.commands?.actor ?? null;
  if (actor === null) return refused(503, "Attachments are off: this server is not on loopback, so it needs ui.user_id.");
  if (typeof body !== "object" || body === null) return refused(400, "The body must be a JSON object.");
  const b = body as Record<string, unknown>;
  const id = str(b.id);
  if (id === null) return refused(400, "`id` is required.");
  const input = inputOf(b);
  if (typeof input === "string") return refused(400, input);
  const allowed = d.commands?.allowed ? await d.commands.allowed("approve_spec") : { allow: true as const };
  if (!allowed.allow) return refused(403, `nothing was attached: ${allowed.reason}`);
  const item = await d.store.getWorkItem(id as WorkItemId);
  if (!item) return refused(404, `no work item ${id}`);
  const r = await attach({ store: d.store, scanner: d.scanner, newId: randomUUID }, item, input, actor);
  if ("refuse" in r) return refused(409, r.refuse);
  const { data: _bytes, ...shown } = r.attachment;
  return { status: 200, value: { attachment: shown } };
}

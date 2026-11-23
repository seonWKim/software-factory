// Attachments (design 02-attachments): images and links the owner adds to a New or in-triage item, kept in the
// controller store (`controller_attachments`), never in the repository or a sandbox working tree. The CLI
// (`factory attach`) and the dashboard's Attach dialog both store through `attach`, so their refusals are the same.
// The egress scanner reads text only: a link's URL and label are scanned, an image's bytes are not.

import { commandPhase, phaseLabel } from "./commands.js";
import type { Timestamp, UserId, WorkItem, WorkItemId } from "./types.js";

/** The image types an attachment may have, found from the file's first bytes, never from its name. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
/** The largest image taken: 5 MB. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The longest URL and label taken. */
export const MAX_URL_CHARS = 2000;
export const MAX_LABEL_CHARS = 200;

export interface Attachment {
  id: string;
  work_item_id: WorkItemId;
  kind: "image" | "link";
  /** An image's type; null for a link. */
  media_type: ImageType | null;
  /** An image's bytes, base64; null for a link. */
  data: string | null;
  /** An image's size in bytes; null for a link. */
  size_bytes: number | null;
  /** An image's file name as given (no folder); null for a link. */
  name: string | null;
  /** A link's http or https URL; null for an image. */
  url: string | null;
  /** A link's optional label. */
  label: string | null;
  created_by: UserId;
  created_at: Timestamp;
}

export type NewAttachment = Omit<Attachment, "created_at">;

export interface AttachmentStore {
  /**
   * Stores `a` only while its item's stage is NEW, in one conditional insert: null when the item is gone or past
   * triage, and nothing is stored. An ID already stored returns the stored row.
   */
  addAttachment(a: NewAttachment): Promise<Attachment | null>;
  /** The item's attachments, oldest first, images with their bytes. */
  listAttachments(work_item_id: WorkItemId): Promise<Attachment[]>;
}

/** The type of an image from its first bytes (png, jpeg, gif, webp), else null. */
export function imageType(b: Uint8Array): ImageType | null {
  const at = (i: number, ...xs: number[]) => xs.every((x, j) => b[i + j] === x);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/** The refusal of an attachment on an item that is not New, naming where it is; null on a New item. */
export function attachStageRefusal(it: Pick<WorkItem, "stage" | "blocked_on" | "blocked_reason" | "change_ref">): string | null {
  if (it.stage === "NEW") return null;
  return `nothing was attached: attachments are taken only while the item is New or in triage, and it is ${phaseLabel(commandPhase(it))}`;
}

/** The refusal of an image's bytes (type, size), else null. */
export function imageRefusal(bytes: Uint8Array): string | null {
  if (imageType(bytes) === null) return "nothing was attached: only a png, jpeg, gif or webp image can be attached, and this file is none of those";
  if (bytes.length > MAX_IMAGE_BYTES) return `nothing was attached: the image is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, and the largest taken is 5 MB`;
  return null;
}

/** The refusal of a link's URL and label (http or https only, lengths), else null. */
export function linkRefusal(url: string, label: string | null): string | null {
  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme !== "http:" && scheme !== "https:") return "nothing was attached: only an http or https URL can be attached";
  if (url.length > MAX_URL_CHARS) return `nothing was attached: the URL is longer than ${MAX_URL_CHARS} characters`;
  if (label !== null && label.length > MAX_LABEL_CHARS) return `nothing was attached: the label is longer than ${MAX_LABEL_CHARS} characters`;
  return null;
}

/** What `attach` stores: an image's bytes and file name, or a link with an optional label. */
export type AttachInput = { kind: "image"; bytes: Uint8Array; name: string } | { kind: "link"; url: string; label: string | null };

/** The egress scan `attach` runs on a link's text (structurally the EgressScanner's `scan`). */
export interface TextScanner {
  scan(channel: "comment", content: string): Promise<{ clean: true } | { clean: false; findings: readonly { rule: string }[] }>;
}

export interface AttachDeps {
  store: AttachmentStore;
  scanner: TextScanner;
  newId: () => string;
}

/**
 * One attachment on `item` by `by`: the stage, then the image's type and size or the link's scheme and egress scan,
 * then the store's conditional insert (which refuses an item that left New meanwhile). Every refusal stores nothing.
 */
export async function attach(d: AttachDeps, item: WorkItem, input: AttachInput, by: UserId): Promise<{ attachment: Attachment } | { refuse: string }> {
  const stage = attachStageRefusal(item);
  if (stage) return { refuse: stage };
  const base = { id: `at_${d.newId()}`, work_item_id: item.id, created_by: by };
  let row: NewAttachment;
  if (input.kind === "image") {
    const bad = imageRefusal(input.bytes);
    if (bad) return { refuse: bad };
    const name = input.name.split(/[\\/]/).at(-1)!.slice(0, MAX_LABEL_CHARS);
    row = { ...base, kind: "image", media_type: imageType(input.bytes), data: Buffer.from(input.bytes).toString("base64"), size_bytes: input.bytes.length, name, url: null, label: null };
  } else {
    const url = input.url.trim(), label = input.label?.trim() || null;
    const bad = linkRefusal(url, label);
    if (bad) return { refuse: bad };
    const scan = await d.scanner.scan("comment", [url, label ?? ""].join("\n"));
    if (!scan.clean) return { refuse: `nothing was attached: the link was blocked by the leak scanner (\`${scan.findings.map((f) => f.rule).join(",")}\`)` };
    row = { ...base, kind: "link", media_type: null, data: null, size_bytes: null, name: null, url, label };
  }
  const stored = await d.store.addAttachment(row);
  return stored ? { attachment: stored } : { refuse: "nothing was attached: the item left triage before it was stored" };
}

/** One line naming a stored attachment, as the CLI and the dashboard say it. */
export function attachmentLine(a: Attachment): string {
  return a.kind === "image"
    ? `${a.id}: image ${a.name ?? ""} (${a.media_type}, ${Math.ceil((a.size_bytes ?? 0) / 1024)} KB)`
    : `${a.id}: link ${a.url}${a.label ? ` (${a.label})` : ""}`;
}

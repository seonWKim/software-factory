// Attachments (design 02-attachments): images and links the owner adds to a New or in-triage item, kept in the
// controller store (`controller_attachments`), never in the repository or a sandbox working tree. The CLI
// (`factory attach`) and the dashboard's Attach dialog both store through `attach`, so their refusals are the same.
// The egress scanner reads text only: a link's URL and label are scanned, an image's bytes are not. A chat message's
// images (design 04-chat-agent) are rows of the same table that belong to a chat turn instead of an item: checked by
// `chatImages`, stored with the turn's messages, and scanned as the text inside them (`imageText`) before the model.

import type { AuthProvider } from "../interfaces/auth-provider.js";
import type { FactoryStore } from "../interfaces/factory-store.js";
import { commandPhase, phaseLabel } from "./commands.js";
import { cliName, resolveItem } from "./local-cli.js";
import type { Timestamp, UserId, WorkItem, WorkItemId } from "./types.js";

/** The `at` detail of added context: a `revise_queued` state change on a New or in-triage item (design 02-attachments). */
export const AT_TRIAGE = "triage";

/** Every context the owner added to the item while it was New or in triage, oldest first, from its state changes. */
export function addedContext(changes: readonly { reason: string; detail: Readonly<Record<string, unknown>> | null }[]): string[] {
  return changes.flatMap((c) => (c.reason === "revise_queued" && c.detail?.at === AT_TRIAGE && typeof c.detail.feedback === "string" ? [c.detail.feedback] : []));
}

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

/** The most images one chat message takes. */
export const MAX_CHAT_IMAGES = 5;

/** A chat message's image as a client sends it: its file name and its bytes, base64. */
export interface ChatImageInput {
  name: string;
  data: string;
}

/**
 * A chat message's image, checked: its type from its first bytes, its size, its bytes (base64) and who sent it. It is
 * stored in `controller_attachments` with the user message of its turn (session and seq), with no work item.
 */
export interface ChatImage {
  id: string;
  name: string;
  media_type: ImageType;
  data: string;
  size_bytes: number;
  created_by: UserId;
}

/** A stored chat image as a page reads it: everything but its bytes. */
export type ChatImageRef = Omit<ChatImage, "data" | "created_by">;

export interface AttachmentStore {
  /**
   * Stores `a` only while its item's stage is NEW, in one conditional insert: null when the item is gone or past
   * triage, and nothing is stored. An ID already stored returns the stored row.
   */
  addAttachment(a: NewAttachment): Promise<Attachment | null>;
  /** The item's attachments, oldest first, images with their bytes. */
  listAttachments(work_item_id: WorkItemId): Promise<Attachment[]>;
  /** One stored chat image with its bytes, or null (unknown, or an item's attachment). Chat images are written with their turn (`appendChatMessages`). */
  getChatImage(id: string): Promise<ChatImage | null>;
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

/** The refusal of an image (its first bytes and its size: type, then size), else null. */
export function imageRefusal(bytes: Uint8Array, size = bytes.length): string | null {
  if (imageType(bytes) === null) return "nothing was attached: only a png, jpeg, gif or webp image can be attached, and this file is none of those";
  if (size > MAX_IMAGE_BYTES) return `nothing was attached: the image is ${(size / 1024 / 1024).toFixed(1)} MB, and the largest taken is 5 MB`;
  return null;
}

/** A file name as stored and shown: its last path part, at most MAX_LABEL_CHARS. */
const baseName = (name: string): string => name.split(/[\\/]/).at(-1)!.slice(0, MAX_LABEL_CHARS);

/**
 * A chat message's images, checked in order: at most MAX_CHAT_IMAGES, then each one's bytes (base64), type (png,
 * jpeg, gif or webp, from its first bytes) and size (5 MB). The first problem refuses the whole message, naming the file.
 */
export function chatImages(inputs: readonly ChatImageInput[], by: UserId, newId: () => string): { images: ChatImage[] } | { refuse: string } {
  const images: ChatImage[] = [];
  for (const [i, input] of inputs.entries()) {
    const name = baseName(input.name) || "image";
    const no = (why: string) => ({ refuse: `Nothing was sent: “${name}” ${why}` });
    if (i >= MAX_CHAT_IMAGES) return no(`is image ${i + 1}, and a message takes at most ${MAX_CHAT_IMAGES}.`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) return no("did not arrive as base64 bytes.");
    const bytes = Buffer.from(input.data, "base64");
    const media_type = imageType(bytes);
    if (media_type === null) return no("is not a png, jpeg, gif or webp image.");
    if (bytes.length > MAX_IMAGE_BYTES) return no(`is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, and the largest taken is 5 MB.`);
    images.push({ id: `at_${newId()}`, name, media_type, data: input.data, size_bytes: bytes.length, created_by: by });
  }
  return { images };
}

/**
 * The text an image carries, for the egress scan: its file name and every run of printable characters in its bytes
 * (metadata such as a png text chunk or an EXIF comment). Text drawn in the pixels is not read.
 */
export function imageText(image: Pick<ChatImage, "name" | "data">): string {
  const printable = Buffer.from(image.data, "base64").toString("latin1").replace(/[^\x20-\x7e]+/g, "\n");
  return `${image.name}\n${printable}`;
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

/**
 * What `attach` stores: an image's bytes and file name, or a link with an optional label. `size`: a file over the
 * limit, sent as its first bytes only (the CLI and the page never read or send the rest); it is refused for its size.
 */
export type AttachInput = { kind: "image"; bytes: Uint8Array; name: string; size?: number } | { kind: "link"; url: string; label: string | null };

/** The egress scan `attach` runs on a link's text (structurally the EgressScanner's `scan`). */
export interface TextScanner {
  scan(channel: "comment", content: string): Promise<{ clean: true } | { clean: false; findings: readonly { rule: string }[] }>;
}

export interface AttachDeps {
  store: Pick<AttachmentStore, "addAttachment">;
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
    const bad = imageRefusal(input.bytes, Math.max(input.size ?? 0, input.bytes.length));
    if (bad) return { refuse: bad };
    if (input.size !== undefined && input.size !== input.bytes.length) return { refuse: "nothing was attached: the image's bytes are incomplete" };
    const name = baseName(input.name);
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

/** `factory attach`'s usage line. */
export const ATTACH_USAGE = "usage: factory attach <id> <file> | factory attach <id> --link <url> [label]";

export type AttachArgs = { id: string; file: string } | { id: string; url: string; label: string | null };

/** The parsed arguments, or an error line. */
export function parseAttachArgs(args: readonly string[]): AttachArgs | { error: string } {
  const [id, first, ...rest] = args;
  if (!id || !first) return { error: ATTACH_USAGE };
  if (first === "--link") {
    const [url, ...label] = rest;
    return url ? { id, url, label: label.join(" ").trim() || null } : { error: ATTACH_USAGE };
  }
  return rest.length === 0 ? { id, file: first } : { error: ATTACH_USAGE };
}

export interface AttachCliDeps extends Omit<AttachDeps, "store"> {
  store: Pick<FactoryStore, "findWorkItemIds" | "getWorkItem" | "addAttachment" | "listAttachments">;
  auth: Pick<AuthProvider, "authorize">;
  user: UserId;
  /** A file's size and its first bytes (or all of them, when it is no larger than the image limit). */
  read(path: string): Promise<{ size: number; bytes: Uint8Array }>;
  /** The environment the CLI's name is read from (FACTORY_CLI_NAME, else `factory`), for the hint line. */
  env: Readonly<Record<string, string | undefined>>;
}

/** `factory attach`: the item, the owner check, then `attach`. Exit 0 with the stored line, else 1 with the one refusal. */
export async function runAttach(d: AttachCliDeps, a: AttachArgs): Promise<{ code: number; lines: string[] }> {
  const item = await resolveItem(d.store, a.id);
  if ("lines" in item) return item;
  const allowed = await d.auth.authorize({ user_id: d.user }, "approve_spec", { kind: "work_item", id: item.id });
  if (!allowed.allow) return { code: 1, lines: [`nothing was attached: ${allowed.reason}`] };
  let input: Parameters<typeof attach>[2];
  if ("file" in a) {
    const f = await d.read(a.file).catch(() => null);
    if (!f) return { code: 1, lines: [`nothing was attached: cannot read ${a.file}`] };
    // A file over the limit is read as its first bytes only; `attach` refuses it for its size, after the stage.
    input = { kind: "image", bytes: f.bytes, name: a.file, size: f.size };
  } else {
    input = { kind: "link", url: a.url, label: a.label };
  }
  const r = await attach(d, item, input, d.user);
  if ("refuse" in r) return { code: 1, lines: [r.refuse] };
  return { code: 0, lines: [`attached ${attachmentLine(r.attachment)}`, `the next triage run of ${item.id} reads it; \`${cliName(d.env)} revise ${item.id} <text>\` adds context and starts one`] };
}

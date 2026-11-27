import { useQuery } from "@tanstack/react-query";
import { Paperclip } from "lucide-react";
import { type ClipboardEvent, type DragEvent, useEffect, useRef, useState } from "react";
import { chatImage } from "../api/generated.js";
import { ModalPanel } from "../components/ui/dialog.js";
import { FilePicker } from "../components/ui/file-picker.js";
import { ImageThumb, type ThumbState } from "../components/ui/image-thumb.js";
import { t } from "../i18n/index.js";
import { base64Of } from "../lib/bytes.js";

// Images in the chat (design 09-dashboard-chat, 04-chat-agent): the composer's images to send (paste, drop, the attach
// button), a sent message's images above its text, opened larger in a ModalPanel, and a stored turn's images in the
// Runners transcript. The server checks every image again (chat.send); these checks only say early what it refuses.

/** The types chat.send takes; the server checks the bytes. */
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const TYPES = new Set(ACCEPT.split(","));
/** The most images one message takes, and the largest (core/attachments.ts MAX_CHAT_IMAGES, MAX_IMAGE_BYTES). */
const MAX_IMAGES = 5;
const MAX_BYTES = 5 * 1024 * 1024;

/** An image of the message being written: read (its picture and bytes), being read, or refused with the words why. */
interface Pending {
  key: number;
  name: string;
  state: ThumbState;
  url?: string;
  data?: string;
  error?: string;
}

/** An image sent with a message: its name, its picture (a blob: URL) and its bytes, for Try again. */
export interface SentImage {
  name: string;
  url: string;
  data: string;
}

/**
 * The composer's images. `add` takes files from a paste, a drop or the picker: another type, a file over 5 MB or one
 * past the fifth is kept as an error that names it; the rest are read (a spinner until their bytes are in). `take`
 * hands over the read ones and empties the composer. Kept in a ref as well, so a read that ends later finds its row.
 */
export function useComposerImages() {
  const [images, setImages] = useState<Pending[]>([]);
  const now = useRef<Pending[]>([]);
  const next = useRef(0);
  const set = (v: Pending[]) => {
    now.current = v;
    setImages(v);
  };
  const patch = (key: number, p: Partial<Pending>) => set(now.current.map((i) => (i.key === key ? { ...i, ...p } : i)));

  const read = async (key: number, file: File) => {
    try {
      const data = await base64Of(file);
      const url = URL.createObjectURL(file);
      if (now.current.some((i) => i.key === key)) patch(key, { state: "ready", url, data });
      else URL.revokeObjectURL(url);
    } catch {
      patch(key, { state: "error", error: t("chat.imageUnread", { name: file.name }) });
    }
  };

  const add = (files: readonly File[]) => {
    let taken = now.current.filter((i) => i.state !== "error").length;
    const reads: [number, File][] = [];
    const added = files.map((file): Pending => {
      const key = next.current++;
      const name = file.name || t("chat.imageUnnamed");
      if (!TYPES.has(file.type)) return { key, name, state: "error", error: t("chat.imageType", { name }) };
      if (file.size > MAX_BYTES) return { key, name, state: "error", error: t("chat.imageTooBig", { name }) };
      if (taken >= MAX_IMAGES) return { key, name, state: "error", error: t("chat.imageTooMany", { name, max: MAX_IMAGES }) };
      taken++;
      reads.push([key, file]);
      return { key, name, state: "reading" };
    });
    set([...now.current, ...added]);
    for (const [key, file] of reads) void read(key, file);
  };

  const remove = (key: number) => {
    const url = now.current.find((i) => i.key === key)?.url;
    if (url) URL.revokeObjectURL(url);
    set(now.current.filter((i) => i.key !== key));
  };

  /** The read images, in order, for a send; the composer is empty after (their pictures stay, for the sent message). */
  const take = (): SentImage[] => {
    const sent = now.current.flatMap((i) => (i.state === "ready" && i.url && i.data ? [{ name: i.name, url: i.url, data: i.data }] : []));
    set([]);
    return sent;
  };

  const ready = images.filter((i) => i.state === "ready").length;
  const reading = images.some((i) => i.state === "reading");
  return { images, add, remove, take, ready, reading };
}

export type ComposerImages = ReturnType<typeof useComposerImages>;

/** Image files from a paste; empty when the clipboard holds none (then the paste is the text's). */
export const pastedImages = (e: ClipboardEvent): File[] => [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));

/** The drop target's handlers: a drag that carries files marks it (`dragging`), a drop adds them. */
export function useImageDrop(add: (files: File[]) => void) {
  const [dragging, setDragging] = useState(false);
  const carriesFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    dragging,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: (e: DragEvent) => {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        add([...e.dataTransfer.files]);
      },
    },
  };
}

/** The paperclip inside the composer: picks png, jpeg, gif or webp images. */
export function AttachImages({ add, disabled, className }: { add: (files: File[]) => void; disabled: boolean; className?: string }) {
  return (
    <FilePicker label={t("chat.attach")} accept={ACCEPT} multiple disabled={disabled} onFiles={add} className={className}>
      <Paperclip aria-hidden className="size-4" />
    </FilePicker>
  );
}

/** The images to send, above the text box: a thumbnail each with Remove, a spinner while read, and each refusal in words. */
export function ComposerTray({ images, remove }: Pick<ComposerImages, "images" | "remove">) {
  if (images.length === 0) return null;
  const errors = images.flatMap((i) => (i.error ? [{ key: i.key, error: i.error }] : []));
  return (
    <div data-composer-images className="space-y-2 pb-2">
      <ul aria-label={t("chat.imagesToSend")} className="flex flex-wrap gap-3 pt-2 pr-2">
        {images.map((i) => (
          <li key={i.key}>
            <ImageThumb src={i.url} name={i.name} state={i.state} onRemove={() => remove(i.key)} removeLabel={t("chat.imageRemove", { name: i.name })} busyLabel={t("chat.imageReading", { name: i.name })} />
          </li>
        ))}
      </ul>
      {errors.map((e) => (
        <p key={e.key} role="alert" data-raw className="text-xs text-failed wrap-anywhere">{e.error}</p>
      ))}
    </div>
  );
}

/** One image larger, in the shared ModalPanel. */
function ImageViewer({ image, onClose }: { image: { name: string; url: string }; onClose: () => void }) {
  return (
    <ModalPanel title={image.name} onClose={onClose}>
      <img src={image.url} alt={image.name} className="mx-auto max-h-[70vh] max-w-full rounded-box object-contain" />
    </ModalPanel>
  );
}

/** A sent message's images, above its text at the right: a click opens one larger. */
export function SentImages({ images }: { images: readonly { name: string; url: string }[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const shown = open === null ? undefined : images[open];
  return (
    <>
      <ul aria-label={t("chat.yourImages")} className="flex max-w-[85%] flex-wrap justify-end gap-2 pb-2">
        {images.map((image, i) => (
          <li key={i}>
            <ImageThumb src={image.url} name={image.name} onOpen={() => setOpen(i)} openLabel={t("chat.imageOpen", { name: image.name })} />
          </li>
        ))}
      </ul>
      {shown && <ImageViewer image={shown} onClose={() => setOpen(null)} />}
    </>
  );
}

/** A stored image's picture: its bytes read once through chat.image, as a blob: URL freed when it leaves the page. */
function useStoredImage(id: string, media_type: string): string | undefined {
  const q = useQuery({ queryKey: ["chat", "image", id], queryFn: () => chatImage({ id }), staleTime: Infinity });
  const [url, setUrl] = useState<string>();
  const data = q.data?.data;
  useEffect(() => {
    if (data === undefined) return;
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    const u = URL.createObjectURL(new Blob([bytes], { type: media_type }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, media_type]);
  return url;
}

function StoredThumb({ id, name, media_type }: { id: string; name: string; media_type: string }) {
  const url = useStoredImage(id, media_type);
  return <ImageThumb src={url} name={name} state={url ? "ready" : "reading"} busyLabel={t("chat.imageReading", { name })} />;
}

/** A stored message's images (chat.transcript's references), each read through chat.image. */
export function StoredImages({ images }: { images: readonly { id: string; name: string; media_type: string }[] }) {
  return (
    <ul aria-label={t("chat.yourImages")} className="flex flex-wrap gap-2">
      {images.map((i) => (
        <li key={i.id}>
          <StoredThumb {...i} />
        </li>
      ))}
    </ul>
  );
}

import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { postJson } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { ButtonRow } from "../components/ui/button-row.js";
import { Dialog, announceStatus } from "../components/ui/dialog.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Radio } from "../components/ui/radio.js";
import { Textarea } from "../components/ui/textarea.js";
import { t } from "../i18n/index.js";
import { base64Of } from "../lib/bytes.js";

// Add context and Attach on a New or in-triage item (design 02-attachments, design 09-dashboard-item): two buttons on
// the item page, each opening a modal. Add context sends `revise` with the text, as `factory revise <id> <text>` does:
// the controller queues it for one more triage run and answers in the item's thread. Attach posts one image or one link
// to POST /api/v1/attachments, as `factory attach` stores it, and shows the server's refusal in the dialog. The page
// checks nothing itself, so its refusals are the CLI's; a file over 5 MB sends only its first bytes and its size.

/** The attach route (src/ui/attachments-api.ts ATTACH_PATH). */
export const ATTACH_URL = "/api/v1/attachments";
/** The largest image sent whole; a larger one sends its first bytes, which the server refuses for the size. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** The image types the file picker offers; the server checks the bytes. */
const ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
/**
 * Spread on a hidden Input for the file picker, as PASSWORD is for a masked field: Input's typed variants are text,
 * search and number only. A file variant in Input (components.md) is a follow-up; the Choose file Button opens it.
 */
const FILE = { type: "file" } as unknown as { type: "text" };


/** The attach body for the dialog's choice: an image's name, bytes and size (over the limit, its first 16 bytes only), or a link's URL and label. */
export async function attachBody(id: string, choice: { kind: "image"; file: File } | { kind: "link"; url: string; label: string }): Promise<Record<string, unknown>> {
  if (choice.kind === "link") return { id, kind: "link", url: choice.url.trim(), label: choice.label.trim() || null };
  return { id, kind: "image", name: choice.file.name, size: choice.file.size, data: await base64Of(choice.file.size > MAX_IMAGE_BYTES ? choice.file.slice(0, 16) : choice.file) };
}

type Open = "context" | "attach" | null;

/**
 * The item's Add context and Attach buttons (a New or in-triage item, where `/revise` applies) in one ButtonRow with
 * `children` (the item's "…" menu), and the modal each opens. `send` is the item's command sender (`revise` with the text); `token` the page's CSRF token for Attach.
 */
export function AddContextActions({ id, title, token, off, error, send, children }: {
  id: string; title: string; token: string | undefined; off: boolean; error: string | null; send: (text: string) => Promise<boolean>; children?: ReactNode;
}) {
  const [open, setOpen] = useState<Open>(null);
  const back = useRef<HTMLDivElement>(null);
  const focus = { get current() { return back.current?.querySelector<HTMLElement>(`[data-action=${open === "attach" ? "attach" : "add-context"}]`) ?? null; } } as RefObject<HTMLElement | null>;
  return (
    <div ref={back} data-add-context className="mt-2">
      <ButtonRow>
        <Button data-action="add-context" data-item={id} disabled={off} onClick={() => setOpen("context")}>
          {t("attach.addContext")}
        </Button>
        <Button data-action="attach" data-item={id} disabled={off || !token} onClick={() => setOpen("attach")}>
          {t("attach.attach")}
        </Button>
        {children}
      </ButtonRow>
      {open === "context" && (
        <ContextDialog title={`${t("attach.addContext")} ${title}`} busy={off} error={error} returnFocusTo={focus}
          onSend={(text) => void send(text).then((ok) => ok && (announceStatus(t("attach.contextSent")), setOpen(null)))} onClose={() => setOpen(null)} />
      )}
      {open === "attach" && token && <AttachDialog id={id} title={`${t("attach.attach")} ${title}`} token={token} returnFocusTo={focus} onClose={() => setOpen(null)} />}
    </div>
  );
}

export function ContextDialog({ title, busy, error, returnFocusTo, onSend, onClose }: {
  title: string; busy: boolean; error: string | null; returnFocusTo: RefObject<HTMLElement | null>; onSend: (text: string) => void; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const uid = useId();
  return (
    <Dialog title={title} consequence={t("attach.contextConsequence")} confirmLabel={t("attach.sendContext")} confirmDisabled={busy}
      error={error} returnFocusTo={returnFocusTo} onConfirm={() => onSend(text)} onClose={onClose}>
      <Field label={t("attach.contextLabel")} htmlFor={`${uid}-text`}>
        <Textarea id={`${uid}-text`} rows={5} value={text} onChange={(e) => setText(e.target.value)} className="w-full" />
      </Field>
    </Dialog>
  );
}

function AttachDialog({ id, title, token, returnFocusTo, onClose }: { id: string; title: string; token: string; returnFocusTo: RefObject<HTMLElement | null>; onClose: () => void }) {
  const [kind, setKind] = useState<"image" | "link">("image");
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  const uid = useId();
  const ready = kind === "image" ? file !== null : url.trim() !== "";
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = await attachBody(id, kind === "image" ? { kind, file: file! } : { kind, url, label });
      const r = await postJson<{ error?: string }>(ATTACH_URL, token, body);
      if (!r.ok) return setError(r.value.error ?? t("api.http", { status: r.status }));
      announceStatus(t("attach.attached"));
      onClose();
    } catch {
      setError(t("attach.readFailed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={title} consequence={t("attach.attachConsequence")} confirmLabel={t("attach.attach")} confirmDisabled={busy || !ready}
      error={error} returnFocusTo={returnFocusTo} onConfirm={() => void send()} onClose={onClose}>
      <fieldset className="min-w-0">
        <legend className="text-sm font-medium">{t("attach.kind")}</legend>
        <div role="radiogroup" aria-label={t("attach.kind")} className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
          <Radio name="attach-kind" checked={kind === "image"} onChange={() => setKind("image")}>{t("attach.image")}</Radio>
          <Radio name="attach-kind" checked={kind === "link"} onChange={() => setKind("link")}>{t("attach.link")}</Radio>
        </div>
      </fieldset>
      {kind === "image" ? (
        <Field label={t("attach.image")} help={t("attach.imageHelp")}>
          <Input ref={picker} {...FILE} accept={ACCEPT} hidden data-attach-file onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button onClick={() => picker.current?.click()}>{t("attach.chooseFile")}</Button>
            <span className="min-w-0 truncate text-sm text-text-2">{file?.name ?? t("attach.noFile")}</span>
          </div>
        </Field>
      ) : (
        <>
          <Field label={t("attach.url")} htmlFor={`${uid}-url`} help={t("attach.urlHelp")}>
            <Input id={`${uid}-url`} value={url} onChange={(e) => setUrl(e.target.value)} className="w-full" />
          </Field>
          <Field label={t("attach.label")} htmlFor={`${uid}-label`}>
            <Input id={`${uid}-label`} value={label} onChange={(e) => setLabel(e.target.value)} className="w-full" />
          </Field>
        </>
      )}
    </Dialog>
  );
}

import { CircleAlert, LoaderCircle, X } from "lucide-react";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";
import { FOCUS } from "./control.js";

// A small square picture of an image (the chat composer's images to send, a sent message's images). Its height is the
// picture's, so the thumbnail button is `[data-thumb]`, which the button-height rule leaves out (scripts/responsive).

export type ThumbState = "reading" | "ready" | "error";

interface ImageThumbProps {
  /** The picture (a blob: URL); none while it is read or when it could not be. */
  src?: string | undefined;
  /** The file's name: the picture's alt text. */
  name: string;
  state?: ThumbState;
  /** Opens the picture larger; absent: the thumbnail is not a button. */
  onOpen?: (() => void) | undefined;
  openLabel?: string;
  /** Removes it; absent: no remove button. */
  onRemove?: (() => void) | undefined;
  removeLabel?: string;
  /** While reading: what a screen reader hears. */
  busyLabel?: string;
}

/**
 * A 64px square with the image cropped to fill it (`rounded-box`, a 1px `border`): ready, reading (a spinner over a
 * `surface-2` square, `role=status`) or error (a `failed` border and mark; the words are the caller's). With
 * `onRemove`, a 28px round remove Button sits on its top right corner.
 */
export function ImageThumb({ src, name, state = "ready", onOpen, openLabel, onRemove, removeLabel, busyLabel }: ImageThumbProps) {
  const box = cn("relative flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-box border bg-surface-2", state === "error" ? "border-failed" : "border-border");
  const picture = src && state === "ready" ? <img src={src} alt={name} className="size-full object-cover" /> : null;
  return (
    <div data-thumb-state={state} className="relative shrink-0">
      {onOpen && picture ? (
        <button type="button" data-thumb aria-label={openLabel} title={name} onClick={onOpen} className={cn(box, "cursor-zoom-in", FOCUS)}>
          {picture}
        </button>
      ) : (
        <div className={box} title={name}>
          {picture}
          {state === "reading" && (
            <span role="status" className="text-text-3">
              <LoaderCircle aria-hidden className="size-5 motion-safe:animate-spin" />
              <span className="sr-only">{busyLabel}</span>
            </span>
          )}
          {state === "error" && <CircleAlert aria-hidden className="size-5 text-failed" />}
        </div>
      )}
      {onRemove && (
        <Button size="sm" variant="secondary" aria-label={removeLabel} onClick={onRemove} className="absolute -top-2 -right-2 size-7 justify-center rounded-pill! px-0 shadow-sm">
          <X aria-hidden className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

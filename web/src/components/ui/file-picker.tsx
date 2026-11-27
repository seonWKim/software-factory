import { type ReactNode, useRef } from "react";
import { Button } from "./button.js";

// The one file chooser: a Button that opens the system's file picker through a hidden file input, so no view draws a
// raw <input type=file> (tests/design-system.test.ts, raw controls).

interface FilePickerProps {
  /** The Button's name (an icon Button has no visible text). */
  label: string;
  /** The file types offered, as the input's `accept`. */
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  /** The Button's content: an icon. */
  children: ReactNode;
  className?: string | undefined;
}

/** A ghost icon Button that picks files; each pick calls `onFiles` once, and picking the same file again works. */
export function FilePicker({ label, accept, multiple = false, disabled = false, onFiles, children, className }: FilePickerProps) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" size="icon" aria-label={label} title={label} disabled={disabled} className={className} onClick={() => input.current?.click()}>
        {children}
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        tabIndex={-1}
        accept={accept}
        multiple={multiple}
        data-file-picker
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}

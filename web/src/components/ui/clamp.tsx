import { type ComponentProps, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { cn } from "../../lib/cn.js";
import { Button } from "./button.js";

/**
 * Long row text (design-system/components.md, Clamp; decision rule 7 in patterns.md): a paragraph clamped to 2 lines
 * with `line-clamp-2`, and a small ghost "Show more" / "Show less" Button under it only when the text is really cut
 * off. The button opens the full text in place (`aria-expanded`). Extra props (`data-*`, `className` for the text
 * style) go to the paragraph.
 */
export function Clamp({ className, children, ...rest }: ComponentProps<"p">) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () => {
      if (!open) setCut(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, children]);
  return (
    <div className="flex min-w-0 flex-col items-start">
      <p ref={ref} {...rest} className={cn("max-w-full text-pretty wrap-anywhere", !open && "line-clamp-2", className)}>{children}</p>
      {(cut || open) && (
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)} flush>
          {t(open ? "clamp.less" : "clamp.more")}
        </Button>
      )}
    </div>
  );
}

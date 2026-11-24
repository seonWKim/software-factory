// The classes every control of components/ui shares (docs/design/09-brand-and-tokens.md): all from the tokens.

/** Keyboard focus: a 2px outline in the focus token, offset 2px; never the browser's own ring. */
export const FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Disabled: the whole control at opacity 0.5 and a not-allowed cursor; border and text keep their colours. */
export const DISABLED = "disabled:cursor-not-allowed disabled:opacity-50";

/** Select, Textarea and Input: 1px border, radius control, surface background, text-sm, placeholder text-3. */
export const FIELD = `rounded-control border border-border-strong bg-surface text-sm text-text-1 placeholder:text-text-3 ${FOCUS} ${DISABLED}`;

/**
 * The control heights in px (design-system/components.md "Button", "PageToolbar"): Input, Select, a `md` or `icon`
 * Button, a Tab and the SegmentedControl track are 32 (`h-8`, `min-h-8`); a `sm` Button and a segment are 28
 * (`min-h-7`). A PageToolbar's row holds 32px controls only: a `sm` Button inside it is drawn `md` (`InToolbar`).
 */
export const CONTROL_HEIGHT = { md: 32, sm: 28 } as const;

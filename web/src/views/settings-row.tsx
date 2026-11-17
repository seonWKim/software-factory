import type { ReactNode } from "react";
import { Td, Tr } from "../components/ui/parts.js";

/** What a setting controls, under its name; always shown, narrow screens included. */
export function Description({ text }: { text: string }) {
  return <p className="mt-1 max-w-64 text-xs text-pretty text-text-2">{text}</p>;
}

/**
 * The one settings row (design 08-settings): the plain name and its one-line description on the left, the control and
 * its action in the middle, Details on the right, and an optional trailing cell (a reset). It is a row of a Table whose
 * head is the name, value and Details columns (then the trailing one), so below `sm` it becomes a card like any other
 * Table row. The settable keys table and the file keys both draw their rows with it. `attrs` are the row's data
 * attributes (a test or link finds a row by them).
 */
export function SettingsRow({ name, description, control, details, trailing, attrs }: { name: string; description: string; control: ReactNode; details: ReactNode; trailing?: ReactNode; attrs?: { [data: `data-${string}`]: string | undefined } }) {
  return (
    <Tr data-setting-row="" {...attrs}>
      <Td>
        <span className="text-sm font-medium text-pretty">{name}</span>
        <Description text={description} />
      </Td>
      <Td className="min-w-56">{control}</Td>
      <Td className="min-w-32">{details}</Td>
      {trailing !== undefined && <Td>{trailing}</Td>}
    </Tr>
  );
}

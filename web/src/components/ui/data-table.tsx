import type { ReactNode } from "react";
import { Empty, Table, Td, Tr } from "./parts.js";

export interface Column<Row> {
  key: string;
  header: string;
  /** What the cell shows; default is the row's field named `key`. */
  render?(row: Row): ReactNode;
  /** Right-align the column as numbers. Left out, a column whose values are all numbers is aligned that way. */
  numeric?: boolean;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === false || v === "";

/**
 * A Table built from columns and rows. Number cells are right-aligned in tabular-nums; a column that is empty in
 * every row is left out; below `sm` Table shows one card per row. With no rows it shows `empty` instead.
 */
export function DataTable<Row extends object>({ columns, rows, rowKey, label, empty }: { columns: readonly Column<Row>[]; rows: readonly Row[]; rowKey(row: Row): string; label: string; empty: ReactNode }) {
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  const value = (c: Column<Row>, row: Row): unknown => (c.render ? c.render(row) : (row as Record<string, unknown>)[c.key]);
  const shown = columns.filter((c) => rows.some((row) => !isEmpty(value(c, row))));
  const numeric = shown.map((c) => c.numeric ?? rows.map((row) => value(c, row)).filter((v) => !isEmpty(v)).every((v) => typeof v === "number"));
  return (
    <Table label={label} head={shown.map((c) => c.header)} numeric={numeric}>
      {rows.map((row) => (
        <Tr key={rowKey(row)}>
          {shown.map((c, i) => {
            const v = value(c, row);
            return (
              <Td key={c.key} className={numeric[i] ? "tabular-nums sm:text-right" : ""}>
                {v as ReactNode}
              </Td>
            );
          })}
        </Tr>
      ))}
    </Table>
  );
}

import type { ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { Table, Td, Tr } from "./parts.js";
import { EmptyState } from "./notice.js";

export interface Column<Row> {
  key: string;
  header: string;
  /** What the cell shows; default is the row's field named `key`. */
  render?(row: Row): ReactNode;
  /** Right-align the column as numbers. Left out, a column whose values are all numbers is aligned that way. */
  numeric?: boolean;
  /** Classes for this column's cells (a width cap, no-wrap, a muted colour). */
  className?: string;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === false || v === "";

/**
 * A Table built from columns and rows. Number cells are right-aligned in tabular-nums; a column that is empty in
 * every row is left out; below `sm` Table shows one card per row. With no rows it shows `empty` instead.
 * With `dataKey` each row carries `data-key` set to its `rowKey`, for links and tests that find a row by it.
 */
export function DataTable<Row extends object>({ columns, rows, rowKey, label, empty, dataKey }: { columns: readonly Column<Row>[]; rows: readonly Row[]; rowKey(row: Row): string; label: string; empty: ReactNode; dataKey?: boolean }) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  const value = (c: Column<Row>, row: Row): unknown => (c.render ? c.render(row) : (row as Record<string, unknown>)[c.key]);
  const shown = columns.filter((c) => rows.some((row) => !isEmpty(value(c, row))));
  const numeric = shown.map((c) => c.numeric ?? rows.map((row) => value(c, row)).filter((v) => !isEmpty(v)).every((v) => typeof v === "number"));
  return (
    <Table label={label} head={shown.map((c) => c.header)} numeric={numeric}>
      {rows.map((row) => (
        <Tr key={rowKey(row)} {...(dataKey ? { "data-key": rowKey(row) } : {})}>
          {shown.map((c, i) => {
            const v = value(c, row);
            return (
              <Td key={c.key} className={cn(numeric[i] && "tabular-nums sm:text-right", c.className)}>
                {v as ReactNode}
              </Td>
            );
          })}
        </Tr>
      ))}
    </Table>
  );
}

/** One point of a Chart: `value` sets its bar's height, `caption` is its short label on the axis, `text` says it in words. */
export interface ChartPoint {
  key: string;
  value: number;
  caption: string;
  text: string;
}

/**
 * A small bar chart from plain elements on token colours (as the Efficiency tab's MiniChart): one bar per point, a bar's
 * height its `value` over `max` (default: the largest value), the first and last captions under it. Every point is also
 * text, in a list named `label`: the point's `text` in the bar's title and for screen readers. No points: nothing drawn.
 */
export function Chart({ label, points, max }: { label: string; points: readonly ChartPoint[]; max?: number }) {
  if (points.length === 0) return null;
  const top = max ?? Math.max(...points.map((p) => p.value), 0);
  const pct = (n: number): string => `${top <= 0 ? 0 : Math.min(100, Math.max(0, (n / top) * 100))}%`;
  return (
    <div data-chart={label} className="min-w-0">
      <ol aria-label={label} className="flex h-24 items-end gap-px">
        {points.map((p) => (
          <li key={p.key} title={p.text} className="flex h-full min-w-0 flex-1 items-end">
            <span className="sr-only">{p.text}</span>
            <span aria-hidden className="block w-full rounded-t-control bg-accent" style={{ height: pct(p.value) }} />
          </li>
        ))}
      </ol>
      <div aria-hidden className="mt-1 flex justify-between gap-2 text-xs text-text-2 tabular-nums">
        <span>{points[0]!.caption}</span>
        <span>{points.at(-1)!.caption}</span>
      </div>
    </div>
  );
}

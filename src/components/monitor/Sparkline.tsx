interface SparklineProps {
  /** Series values, oldest first. Nulls render as gaps. */
  values: (number | null)[];
  /** Colour class for the trace (uses currentColor). */
  className?: string;
  /** Fixed vertical domain; defaults to the data range. */
  min?: number;
  max?: number;
  height?: number;
}

/**
 * Tiny inline trend trace — no axes, no interaction. Sized to its container so
 * it stays readable on a phone-width drawer.
 */
export function Sparkline({ values, className, min, max, height = 28 }: SparklineProps) {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length < 2) {
    return <div style={{ height }} className="flex items-center text-[11px] text-muted-foreground">Collecting…</div>;
  }
  const lo = min ?? Math.min(...nums);
  const hi = max ?? Math.max(...nums);
  const span = hi - lo || 1;
  const w = 100;
  const stepX = w / Math.max(1, values.length - 1);

  const segments: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      return;
    }
    const x = i * stepX;
    const y = height - ((v - lo) / span) * (height - 4) - 2;
    current.push(`${current.length ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`);
  });
  if (current.length > 1) segments.push(current.join(" "));

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      height={height}
      className={`w-full ${className ?? "text-signal"}`}
      role="img"
      aria-hidden
    >
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      ))}
    </svg>
  );
}

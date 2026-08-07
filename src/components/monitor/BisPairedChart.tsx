import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import type { BisDriftSeriesPoint } from "@/lib/eeg/bis-drift.functions";
import { cn } from "@/lib/utils";

const WINDOWS = [30, 60, 120, 200] as const;

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : null);

/**
 * Side-by-side trace of the last N paired readings: the open index as
 * published, the commercial BIS value transcribed at the bedside, and — when a
 * correction is active — the corrected index the app now displays.
 */
export function BisPairedChart({ series }: { series: BisDriftSeriesPoint[] }) {
  const [n, setN] = useState<number>(60);
  const hasCorrection = series.some((p) => p.corrected != null);

  const rows = useMemo(() => {
    const tail = series.slice(-n);
    return tail.map((p, i) => ({
      i: i + 1,
      "Commercial BIS": p.bis,
      "Open index (raw)": p.raw,
      ...(hasCorrection ? { "Open index (corrected)": p.corrected } : {}),
      recordedAt: p.recordedAt,
    }));
  }, [series, n, hasCorrection]);

  const stats = useMemo(() => {
    const tail = series.slice(-n);
    const rawErr = tail.map((p) => Math.abs(p.raw - p.bis));
    const corrErr = tail
      .filter((p) => p.corrected != null)
      .map((p) => Math.abs((p.corrected as number) - p.bis));
    return { raw: mean(rawErr), corrected: mean(corrErr), n: tail.length };
  }, [series, n]);

  if (series.length < 2) {
    return (
      <p className="text-[11px] text-muted-foreground">
        A side-by-side comparison appears once at least two paired readings have been filed.
      </p>
    );
  }

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Open index vs commercial BIS — last {stats.n} paired readings
        </h3>
        <div className="ml-auto flex items-center gap-1">
          {WINDOWS.filter((w) => w <= Math.max(30, series.length)).map((w) => (
            <Button
              key={w}
              size="sm"
              variant={n === w ? "secondary" : "ghost"}
              className={cn("h-7 px-2 text-[11px]")}
              onClick={() => setN(w)}
            >
              {w}
            </Button>
          ))}
        </div>
      </div>

      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 6, right: 8, bottom: 4, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="i"
              tick={{ fontSize: 11 }}
              stroke="var(--muted-foreground)"
              label={{
                value: "paired reading (oldest → newest)",
                position: "insideBottom",
                offset: -2,
                style: { fontSize: 10, fill: "var(--muted-foreground)" },
              }}
            />
            <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} stroke="var(--muted-foreground)" />
            <Tooltip
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
              labelFormatter={(v) => `Reading ${v}`}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={60} stroke="var(--muted-foreground)" strokeDasharray="2 4" />
            <ReferenceLine y={40} stroke="var(--muted-foreground)" strokeDasharray="2 4" />
            <Line
              type="monotone"
              dataKey="Commercial BIS"
              stroke="var(--muted-foreground)"
              strokeWidth={2}
              dot={false}
              connectNulls
            />
            <Line
              type="monotone"
              dataKey="Open index (raw)"
              stroke="var(--caution)"
              strokeDasharray="4 3"
              dot={false}
              connectNulls
            />
            {hasCorrection ? (
              <Line
                type="monotone"
                dataKey="Open index (corrected)"
                stroke="var(--signal)"
                strokeWidth={2}
                dot={false}
                connectNulls
              />
            ) : null}
          </LineChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-muted-foreground">
        Mean absolute difference from the monitor over this window:{" "}
        {stats.raw == null ? "—" : `${stats.raw.toFixed(1)} index points raw`}
        {stats.corrected == null ? "" : ` · ${stats.corrected.toFixed(1)} corrected`}. Dashed
        guides mark the 40–60 window.
      </p>
    </div>
  );
}

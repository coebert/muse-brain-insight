import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";

import { Button } from "@/components/ui/button";
import { agreementMetrics, type AlignedPair } from "@/lib/eeg/agreement";
import type { BisDriftSeriesPoint } from "@/lib/eeg/bis-drift.functions";
import { cn } from "@/lib/utils";

const WINDOWS = [30, 60, 120, 200] as const;

const f = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);

/**
 * Bland-Altman agreement plot for the last N paired readings: the mean of the
 * two methods on x, their difference on y, with bias and 95 % limits of
 * agreement drawn in. The reference is always the commercial monitor, so a
 * positive difference means the app reads light compared with BIS.
 *
 * OpenIBIS (pre-correction) is always plotted; COEBIS is overlaid once a
 * learned correction is active, so the shift in bias is visible directly.
 */
export function BisBlandAltmanChart({ series }: { series: BisDriftSeriesPoint[] }) {
  const [n, setN] = useState<number>(60);
  const [showCoebis, setShowCoebis] = useState(true);
  const hasCorrection = series.some((p) => p.corrected != null);

  const { rawPoints, coebisPoints, raw, coebis } = useMemo(() => {
    const tail = series.slice(-n);
    const toPoints = (get: (p: BisDriftSeriesPoint) => number | null) =>
      tail
        .map((p) => {
          const v = get(p);
          if (v == null) return null;
          return { x: (v + p.bis) / 2, y: v - p.bis, bis: p.bis, value: v };
        })
        .filter((p): p is { x: number; y: number; bis: number; value: number } => p !== null);

    const toPairs = (get: (p: BisDriftSeriesPoint) => number | null): AlignedPair[] =>
      tail
        .map((p, i) => {
          const v = get(p);
          return v == null ? null : { t: i, reference: p.bis, test: v };
        })
        .filter((p): p is AlignedPair => p !== null);

    const rawPts = toPoints((p) => p.raw);
    const corrPts = toPoints((p) => p.corrected);
    return {
      rawPoints: rawPts,
      coebisPoints: corrPts,
      raw: rawPts.length >= 3 ? agreementMetrics(toPairs((p) => p.raw)) : null,
      coebis: corrPts.length >= 3 ? agreementMetrics(toPairs((p) => p.corrected)) : null,
    };
  }, [series, n]);

  if (series.length < 3) {
    return (
      <p className="text-[11px] text-muted-foreground">
        A Bland-Altman plot appears once at least three paired readings have been filed.
      </p>
    );
  }

  const overlay = hasCorrection && showCoebis && coebisPoints.length >= 3;

  return (
    <div className="space-y-2 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Bland-Altman — OpenIBIS (pre-correction) vs commercial BIS
        </h3>
        <div className="ml-auto flex items-center gap-1">
          {hasCorrection ? (
            <Button
              size="sm"
              variant={showCoebis ? "secondary" : "ghost"}
              className="h-7 px-2 text-[11px]"
              onClick={() => setShowCoebis((v) => !v)}
            >
              COEBIS overlay
            </Button>
          ) : null}
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
          <ScatterChart margin={{ top: 6, right: 12, bottom: 8, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              type="number"
              dataKey="x"
              domain={[0, 100]}
              tick={{ fontSize: 11 }}
              stroke="var(--muted-foreground)"
              label={{
                value: "mean of app index and commercial BIS",
                position: "insideBottom",
                offset: -4,
                style: { fontSize: 10, fill: "var(--muted-foreground)" },
              }}
            />
            <YAxis
              type="number"
              dataKey="y"
              tick={{ fontSize: 11 }}
              stroke="var(--muted-foreground)"
              label={{
                value: "app − BIS",
                angle: -90,
                position: "insideLeft",
                offset: 20,
                style: { fontSize: 10, fill: "var(--muted-foreground)" },
              }}
            />
            <ZAxis range={[28, 28]} />
            <Tooltip
              cursor={{ strokeDasharray: "3 3" }}
              contentStyle={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
              formatter={(value: number, name: string) => [value.toFixed(1), name]}
              labelFormatter={() => ""}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke="var(--muted-foreground)" />
            {raw ? (
              <>
                <ReferenceLine
                  y={raw.bias}
                  stroke="var(--caution)"
                  strokeWidth={1.5}
                  label={{
                    value: `bias ${f(raw.bias)}`,
                    position: "insideTopRight",
                    style: { fontSize: 10, fill: "var(--caution)" },
                  }}
                />
                <ReferenceLine y={raw.loaUpper} stroke="var(--caution)" strokeDasharray="4 3" />
                <ReferenceLine y={raw.loaLower} stroke="var(--caution)" strokeDasharray="4 3" />
              </>
            ) : null}
            <Scatter name="OpenIBIS − BIS" data={rawPoints} fill="var(--caution)" />
            {overlay ? (
              <Scatter name="COEBIS − BIS" data={coebisPoints} fill="var(--signal)" />
            ) : null}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[11px] text-muted-foreground">
        OpenIBIS bias {f(raw?.bias)} index points (95 % limits {f(raw?.loaLower)} to{" "}
        {f(raw?.loaUpper)}) over {raw?.n ?? 0} paired readings
        {coebis
          ? ` · COEBIS bias ${f(coebis.bias)} (limits ${f(coebis.loaLower)} to ${f(coebis.loaUpper)})`
          : ""}
        . Positive values mean the app reads lighter than the monitor. A bias away from zero is a
        systematic offset; wide limits mean the disagreement varies case to case.
      </p>
    </div>
  );
}

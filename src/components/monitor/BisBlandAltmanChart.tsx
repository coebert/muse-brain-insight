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
import type { ActiveAlignment, BisDriftSeriesPoint } from "@/lib/eeg/bis-drift.functions";
import { cn } from "@/lib/utils";

const WINDOWS = [30, 60, 120, 200] as const;

const f = (v: number | null | undefined, d = 1) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(d);

interface TrendFit {
  slope: number;
  intercept: number;
  r2: number;
  line: { x: number; y: number }[];
}

/** Least-squares fit of difference on mean, to expose proportional bias. */
function fitTrend(pts: { x: number; y: number }[]): TrendFit | null {
  if (pts.length < 3) return null;
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n;
  const my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of pts) {
    sxx += (p.x - mx) ** 2;
    sxy += (p.x - mx) * (p.y - my);
    syy += (p.y - my) ** 2;
  }
  if (sxx <= 0) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  const r2 = syy <= 0 ? 0 : (sxy * sxy) / (sxx * syy);
  const xs = pts.map((p) => p.x);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  return {
    slope,
    intercept,
    r2,
    line: [
      { x: x0, y: intercept + slope * x0 },
      { x: x1, y: intercept + slope * x1 },
    ],
  };
}

/**
 * Bland-Altman agreement plot for the last N paired readings: the mean of the
 * two methods on x, their difference on y, with bias and 95 % limits of
 * agreement drawn in. The reference is always the commercial monitor, so a
 * positive difference means the app reads light compared with BIS.
 *
 * OpenIBIS (pre-correction) is always plotted; COEBIS is overlaid once a
 * learned correction is active, so the shift in bias is visible directly.
 */
export function BisBlandAltmanChart({
  series,
  active,
}: {
  series: BisDriftSeriesPoint[];
  active?: ActiveAlignment | null;
}) {
  const [n, setN] = useState<number>(60);
  const [showCoebis, setShowCoebis] = useState(true);
  const hasCorrection = series.some((p) => p.corrected != null);

  const fittedAt = active?.createdAt ? new Date(active.createdAt) : null;
  const fittedLabel =
    fittedAt && !Number.isNaN(fittedAt.getTime())
      ? `${fittedAt.toLocaleDateString()} at ${fittedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
      : null;
  const knotCount = active?.knots?.length ?? 0;

  const { rawPoints, coebisPoints, raw, coebis, rawTrend, coebisTrend } = useMemo(() => {
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
      rawTrend: fitTrend(rawPts),
      coebisTrend: fitTrend(corrPts),
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
            {rawTrend ? (
              <Scatter
                name="OpenIBIS trend"
                data={rawTrend.line}
                fill="transparent"
                line={{ stroke: "var(--caution)", strokeWidth: 2 }}
                shape={() => <g />}
                legendType="line"
                isAnimationActive={false}
              />
            ) : null}
            {overlay ? (
              <Scatter name="COEBIS − BIS" data={coebisPoints} fill="var(--signal)" />
            ) : null}
            {overlay && coebisTrend ? (
              <Scatter
                name="COEBIS trend"
                data={coebisTrend.line}
                fill="transparent"
                line={{ stroke: "var(--signal)", strokeWidth: 2 }}
                shape={() => <g />}
                legendType="line"
                isAnimationActive={false}
              />
            ) : null}
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-border bg-muted/30 p-2.5">
          <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            OpenIBIS (pre-correction)
          </p>
          <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[11px] text-muted-foreground uppercase">Bias</p>
              <p className="metric-value text-sm">{f(raw?.bias)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase">95 % LOA</p>
              <p className="metric-value text-sm">
                {f(raw?.loaLower)} to {f(raw?.loaUpper)}
              </p>
            </div>
            <div>
              <p className="text-[11px] text-muted-foreground uppercase">Paired</p>
              <p className="metric-value text-sm">{raw?.n ?? 0}</p>
            </div>
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            Trend: slope {f(rawTrend?.slope, 3)} per index point, R² {f(rawTrend?.r2, 2)}
          </p>
        </div>

        {coebis && coebisPoints.length >= 3 ? (
          <div className="rounded-md border border-border bg-muted/30 p-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              COEBIS
            </p>
            <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[11px] text-muted-foreground uppercase">Bias</p>
                <p className="metric-value text-sm">{f(coebis.bias)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase">95 % LOA</p>
                <p className="metric-value text-sm">
                  {f(coebis.loaLower)} to {f(coebis.loaUpper)}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground uppercase">Paired</p>
                <p className="metric-value text-sm">{coebis.n}</p>
              </div>
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Trend: slope {f(coebisTrend?.slope, 3)} per index point, R² {f(coebisTrend?.r2, 2)}
            </p>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/30 p-2.5">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              COEBIS — not shown for this window
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {!active
                ? "No COEBIS model has been fitted yet. The knots are fitted automatically once enough paired readings across enough cases show a clear, consistent offset; until then only the OpenIBIS index is plotted."
                : coebisPoints.length === 0
                  ? `A COEBIS model is active, but none of the last ${n} paired readings carry a corrected value, so there is nothing to plot here.`
                  : `A COEBIS model is active, but only ${coebisPoints.length} of the last ${n} paired readings carry a corrected value; at least 3 are needed for bias and limits of agreement.`}
            </p>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {fittedLabel
                ? `Knots last fitted ${fittedLabel} (${knotCount} ${knotCount === 1 ? "knot" : "knots"}, model ${active?.modelVersion ?? "—"}, from ${active?.nPoints ?? 0} readings across ${active?.nSessions ?? 0} cases).`
                : "Knots have never been fitted."}
            </p>
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Positive values mean the app reads lighter than the monitor. A bias away from zero is a
        systematic offset; wide limits mean the disagreement varies case to case. A trend slope away
        from zero means proportional bias — the disagreement grows with depth — and R² shows how
        much of the scatter that trend explains.
      </p>
    </div>
  );
}

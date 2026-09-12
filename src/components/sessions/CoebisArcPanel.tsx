import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity } from "lucide-react";

import {
  AWAKE_INDEX,
  DEEP_INDEX,
  PHASE_TEXT,
  buildCaseArc,
  type ArcSample,
} from "@/lib/eeg/case-arc";
import type { CaseObservation } from "@/lib/eeg/case-observations";
import { formatClock, formatDuration } from "@/lib/eeg/format";

const PHASE_FILL: Record<string, string> = {
  induction: "hsl(var(--signal) / 0.07)",
  maintenance: "transparent",
  emergence: "hsl(var(--warning, var(--signal)) / 0.07)",
};

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const one = (v: number | null) => (v == null ? "—" : v.toFixed(1));

/**
 * How the COEBIS score moved across one case, split into induction,
 * maintenance and emergence, with each stretch graded on its own.
 */
export function CoebisArcPanel({
  samples,
  observations,
}: {
  samples: ArcSample[];
  observations: CaseObservation[];
}) {
  const arc = useMemo(() => buildCaseArc(samples, observations), [samples, observations]);

  if (!arc.hasIndex) {
    return (
      <section className="panel px-4 py-6 text-sm text-muted-foreground">
        No depth score was stored for this case, so there is no history to draw.
      </section>
    );
  }

  const data = arc.samples.map((s) => ({
    t: s.t,
    index: s.index,
    suppression: s.suppression,
    sef: s.sef,
  }));

  return (
    <section className="panel space-y-3 px-3 py-3 sm:px-4">
      <header>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4 text-signal" aria-hidden />
          COEBIS history
        </h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          The depth score across the whole anaesthesia arc. Phase edges come from the state tags
          recorded at the bedside where there are any, and otherwise from the score settling below{" "}
          {AWAKE_INDEX} and rising back over it.
        </p>
      </header>

      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: -16 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            {arc.phases.map((p) => (
              <ReferenceArea
                key={`${p.name}-${p.start}`}
                x1={p.start}
                x2={p.end}
                fill={PHASE_FILL[p.name] ?? "transparent"}
                stroke="none"
                label={{ value: PHASE_TEXT[p.name], position: "insideTop", fontSize: 10 }}
              />
            ))}
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(v: number) => formatClock(v)}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
            />
            <YAxis
              domain={[0, 100]}
              stroke="hsl(var(--muted-foreground))"
              fontSize={11}
              width={36}
            />
            <ReferenceLine y={AWAKE_INDEX} strokeDasharray="4 4" stroke="hsl(var(--border))" />
            <ReferenceLine y={DEEP_INDEX} strokeDasharray="4 4" stroke="hsl(var(--border))" />
            {arc.markers.map((m, i) => (
              <ReferenceLine
                key={`${m.t}-${i}`}
                x={m.t}
                stroke="hsl(var(--muted-foreground))"
                strokeDasharray="2 4"
              />
            ))}
            <Area
              type="monotone"
              dataKey="suppression"
              name="Suppression %"
              stroke="none"
              fill="hsl(var(--critical) / 0.25)"
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="index"
              name="COEBIS"
              stroke="hsl(var(--signal))"
              dot={false}
              strokeWidth={2}
              connectNulls
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="sef"
              name="SEF95 (Hz)"
              stroke="hsl(var(--muted-foreground))"
              dot={false}
              strokeWidth={1}
              connectNulls
              isAnimationActive={false}
            />
            <Tooltip
              contentStyle={{
                background: "hsl(var(--card))",
                border: "1px solid hsl(var(--border))",
                fontSize: 12,
              }}
              labelFormatter={(v) => formatClock(Number(v))}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        {arc.phases.map((p) => (
          <div key={`${p.name}-${p.start}`} className="rounded-md border border-border/60 p-3">
            <p className="text-xs font-medium">
              {PHASE_TEXT[p.name]}{" "}
              <span className="text-muted-foreground">
                · {formatDuration(p.seconds)}
                {p.source === "index" ? " · from the score" : " · from your tags"}
              </span>
            </p>
            <div className="mt-2 space-y-1 text-xs text-muted-foreground">
              <p>
                Average score <span className="font-mono text-foreground">{one(p.mean)}</span>, low{" "}
                <span className="font-mono text-foreground">{one(p.min)}</span>, high{" "}
                <span className="font-mono text-foreground">{one(p.max)}</span>
              </p>
              <p>
                In the {DEEP_INDEX}–{AWAKE_INDEX} band{" "}
                <span className="font-mono text-foreground">{pct(p.inBand)}</span> of the time
              </p>
              <p>
                Below {DEEP_INDEX} for{" "}
                <span className="font-mono text-foreground">{formatDuration(p.secondsDeep)}</span>
                {p.secondsSuppressed > 0
                  ? `, suppressed for ${formatDuration(p.secondsSuppressed)}`
                  : ""}
              </p>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        {arc.timeToUnconscious != null
          ? `Down to the unconscious band ${formatDuration(arc.timeToUnconscious)} after the recording started. `
          : "The score never settled below the awake line in this recording. "}
        {arc.emergenceSeconds != null
          ? `Coming back up took the last ${formatDuration(arc.emergenceSeconds)}. `
          : ""}
        {arc.overall
          ? `Across the whole case the average was ${one(arc.overall.mean)}, with ${formatDuration(
              arc.overall.secondsDeep,
            )} below ${DEEP_INDEX}.`
          : ""}
      </p>

      {arc.markers.length ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">Marks on the trace</p>
          {arc.markers.slice(0, 30).map((m, i) => (
            <p key={`${m.t}-${i}`} className="text-xs text-muted-foreground">
              <span className="font-mono">{formatClock(m.t)}</span> — {m.text}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

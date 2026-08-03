import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Cpu, Target } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { ModelReliability } from "@/lib/eeg/reliability";

function pct(v: number | null | undefined): string {
  return v == null ? "—" : `${Math.round(v * 100)}%`;
}

const VERDICT_STYLE: Record<ModelReliability["verdict"], { label: string; cls: string }> = {
  "well-calibrated": { label: "Well calibrated", cls: "border-signal/50 text-signal" },
  "over-confident": { label: "Over-confident", cls: "border-critical/50 text-critical" },
  "under-confident": { label: "Under-confident", cls: "border-caution/50 text-caution" },
  "insufficient-data": { label: "Too few verdicts", cls: "border-border text-muted-foreground" },
};

/** Dual-track gauge: claimed strength above, observed hit rate below. */
function Meter({ predicted, observed }: { predicted: number | null; observed: number | null }) {
  const p = Math.round((predicted ?? 0) * 100);
  const o = Math.round((observed ?? 0) * 100);
  const over = observed != null && predicted != null && observed < predicted;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
          Claimed
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-muted-foreground/70" style={{ width: `${p}%` }} />
        </div>
        <span className="metric-value w-10 text-right text-xs">{pct(predicted)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
          Observed
        </span>
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full ${over ? "bg-critical" : "bg-marker"}`}
            style={{ width: `${o}%` }}
          />
        </div>
        <span className="metric-value w-10 text-right text-xs">{pct(observed)}</span>
      </div>
    </div>
  );
}

function ModelCard({ m }: { m: ModelReliability }) {
  const style = VERDICT_STYLE[m.verdict];
  return (
    <div className="rounded-md border border-border/70 bg-card/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Cpu className="h-3.5 w-3.5 text-marker" aria-hidden />
        <span className="text-sm font-medium">{m.model}</span>
        <Badge variant="outline" className={`text-xs ${style.cls}`}>
          {style.label}
        </Badge>
        <span className="metric-value ml-auto text-xs text-muted-foreground">
          {m.graded} graded · gap{" "}
          {m.gap == null ? "—" : `${m.gap > 0 ? "+" : ""}${Math.round(m.gap * 100)} pts`}
        </span>
      </div>
      <div className="mt-2">
        <Meter predicted={m.meanPredicted} observed={m.observed} />
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span className="metric-value">ECE {pct(m.expectedCalibrationError)}</span>
        <span className="metric-value">
          Brier {m.brier == null ? "—" : m.brier.toFixed(3)}
        </span>
        {m.unlabelledShare > 0 ? (
          <span>{pct(m.unlabelledShare)} without recorded confidence</span>
        ) : null}
      </div>
      <ul className="mt-2 space-y-1">
        {m.bins
          .filter((b) => b.count > 0)
          .map((b) => (
            <li key={b.key} className="flex items-center gap-2 text-xs">
              <span className="w-24 shrink-0 text-muted-foreground">
                {b.label.replace(" confidence", "")}
              </span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary"
                  style={{ width: `${Math.round((b.observed ?? 0) * 100)}%` }}
                />
              </div>
              <span className="metric-value w-28 text-right text-muted-foreground">
                {pct(b.predicted)} → {pct(b.observed)} (n={b.count})
              </span>
            </li>
          ))}
      </ul>
    </div>
  );
}

/**
 * Confidence meter and reliability breakdown: predicted alert strength versus
 * observed outcomes, per model version and over time.
 */
export function ConfidenceMeter({ models }: { models: ModelReliability[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const active = useMemo(
    () => models.find((m) => m.model === selected) ?? models[0] ?? null,
    [models, selected],
  );

  const trendRows = (active?.trend ?? []).map((p) => ({
    period: p.period.slice(5),
    Claimed: p.predicted == null ? null : Math.round(p.predicted * 100),
    Observed: p.observed == null ? null : Math.round(p.observed * 100),
    graded: p.graded,
  }));

  return (
    <section className="panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Target className="h-3.5 w-3.5 text-marker" aria-hidden /> Confidence meter &amp;
          reliability
        </h2>
        {models.length > 1 ? (
          <div className="ml-auto flex flex-wrap gap-1">
            {models.map((m) => (
              <Button
                key={m.model}
                size="sm"
                variant={active?.model === m.model ? "secondary" : "ghost"}
                className="h-7 text-xs"
                onClick={() => setSelected(m.model)}
              >
                {m.model}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        How strongly each model version claimed its alerts were right, against how often you
        confirmed them.
      </p>

      {models.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No graded alerts with a recorded model version yet.
        </p>
      ) : (
        <>
          <div className="mt-3 space-y-2">
            {models.map((m) => (
              <ModelCard key={m.model} m={m} />
            ))}
          </div>

          {active && trendRows.length > 1 ? (
            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Claimed vs observed over time — {active.model}
              </h3>
              <div className="mt-2 h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trendRows}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis
                      dataKey="period"
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      domain={[0, 100]}
                      unit="%"
                      tick={{ fontSize: 11 }}
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <Tooltip
                      contentStyle={{
                        background: "hsl(var(--card))",
                        border: "1px solid hsl(var(--border))",
                        fontSize: 12,
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="Claimed"
                      stroke="hsl(var(--muted-foreground))"
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                    />
                    <Line
                      type="monotone"
                      dataKey="Observed"
                      stroke="hsl(var(--marker))"
                      dot={false}
                      connectNulls
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
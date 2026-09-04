/**
 * COEBIS against the real monitor, side by side, one acquisition lineage at a
 * time.
 *
 * A single pooled agreement figure can look good while hiding a setup where
 * the model tracks badly, so each lineage gets its own prediction-vs-reality
 * timeline, its own agreement numbers, and the open index on the same
 * readings for reference. Lineages are never merged.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Activity, Loader2 } from "lucide-react";

import { getLineageComparison } from "@/lib/eeg/lineage-comparison.functions";
import type { ComparisonSample, LineageComparison } from "@/lib/eeg/lineage-comparison";
import { cn } from "@/lib/utils";

const plain = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
const signed = (v: number | null | undefined, dp = 2) =>
  v == null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(dp)}`;
const pct = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "—" : `${Math.round(v * 100)}%`;
const day = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
};

const W = 640;
const H = 130;
const PAD = 6;

function path(samples: ComparisonSample[], pick: (s: ComparisonSample) => number | null) {
  const n = samples.length;
  if (n < 2) return "";
  let d = "";
  let open = false;
  samples.forEach((s, i) => {
    const v = pick(s);
    if (v == null || !Number.isFinite(v)) {
      open = false;
      return;
    }
    const x = PAD + (i / (n - 1)) * (W - PAD * 2);
    const y = PAD + (1 - Math.min(100, Math.max(0, v)) / 100) * (H - PAD * 2);
    d += `${open ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `;
    open = true;
  });
  return d.trim();
}

function Timeline({ lineage, showRaw }: { lineage: LineageComparison; showRaw: boolean }) {
  const s = lineage.series;
  if (s.length < 2) {
    return (
      <p className="text-xs text-muted-foreground">
        Only {s.length} paired reading{s.length === 1 ? "" : "s"} on this setup — not enough to draw
        a timeline.
      </p>
    );
  }
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-32 w-full rounded-md bg-muted/30"
      role="img"
      aria-label={`Monitor versus COEBIS over time for ${lineage.lineageKey}`}
    >
      {[20, 40, 60, 80].map((g) => {
        const y = PAD + (1 - g / 100) * (H - PAD * 2);
        return (
          <line
            key={g}
            x1={PAD}
            x2={W - PAD}
            y1={y}
            y2={y}
            className="stroke-border"
            strokeWidth={g === 40 || g === 60 ? 1 : 0.5}
            strokeDasharray={g === 40 || g === 60 ? "4 3" : "2 4"}
          />
        );
      })}
      {showRaw && (
        <path
          d={path(s, (p) => p.raw)}
          fill="none"
          className="stroke-muted-foreground/60"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      <path d={path(s, (p) => p.bis)} fill="none" className="stroke-foreground" strokeWidth={1.5} />
      <path d={path(s, (p) => p.coebis)} fill="none" className="stroke-primary" strokeWidth={1.5} />
    </svg>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/60 px-2 py-1.5">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-medium tabular-nums">{value}</p>
      {hint ? <p className="text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function LineageCard({ lineage, showRaw }: { lineage: LineageComparison; showRaw: boolean }) {
  const c = lineage.coebis;
  return (
    <article className="space-y-3 rounded-lg border border-border bg-card/50 p-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium">
            {lineage.lineageKey === "unattributed" ? "Unattributed readings" : lineage.lineageKey}
          </h4>
          <p className="text-[11px] text-muted-foreground">
            {lineage.points} paired readings · {lineage.cases} case
            {lineage.cases === 1 ? "" : "s"} · {day(lineage.firstAt)} – {day(lineage.lastAt)}
            {lineage.monitors.length ? ` · monitor: ${lineage.monitors.join(", ")}` : ""}
          </p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            !lineage.hasModel
              ? "bg-muted text-muted-foreground"
              : lineage.sufficient
                ? "bg-primary/15 text-primary"
                : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
          )}
        >
          {!lineage.hasModel
            ? "No fitted model"
            : lineage.sufficient
              ? `Live model v${lineage.modelVersion ?? "?"} · ${lineage.modelFamily}`
              : "Insufficient data"}
        </span>
      </header>

      <Timeline lineage={lineage} showRaw={showRaw} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Bias" value={signed(c?.bias ?? null, 1)} hint="COEBIS − monitor" />
        <Stat label="MAE" value={plain(c?.mae ?? null, 1)} hint={`open index ${plain(lineage.raw.mae, 1)}`} />
        <Stat label="Within 5" value={pct(c?.within5 ?? null)} hint={`open ${pct(lineage.raw.within5)}`} />
        <Stat label="CCC" value={plain(c?.ccc ?? null)} hint={`open ${plain(lineage.raw.ccc)}`} />
        <Stat
          label="MAE gain"
          value={signed(lineage.maeGain, 2)}
          hint="vs open index, same readings"
        />
      </div>

      <p className="text-xs text-muted-foreground">{lineage.verdict}</p>
    </article>
  );
}

export function LineageComparisonPanel() {
  const fetchComparison = useServerFn(getLineageComparison);
  const [showRaw, setShowRaw] = useState(true);
  const { data, isLoading, error } = useQuery({
    queryKey: ["lineage-comparison"],
    queryFn: () => fetchComparison(),
    staleTime: 60_000,
  });

  const lineages = useMemo(() => data?.lineages ?? [], [data]);

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          <Activity className="mt-0.5 h-4 w-4 text-primary" aria-hidden />
          <div>
            <h3 className="text-sm font-semibold">Prediction vs reality, by lineage</h3>
            <p className="text-xs text-muted-foreground">
              Each acquisition setup scored against the monitor it was actually paired with, under
              its own live model. Setups are never pooled.
            </p>
          </div>
        </div>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={showRaw}
            onChange={(e) => setShowRaw(e.target.checked)}
            className="h-3.5 w-3.5 accent-current"
          />
          Show open index
        </label>
      </header>

      <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 bg-foreground" /> Monitor
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-5 bg-primary" /> COEBIS
        </span>
        {showRaw ? (
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-5 bg-muted-foreground/60" /> Open index
          </span>
        ) : null}
      </div>

      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Loading paired readings…
        </p>
      ) : error ? (
        <p className="text-xs text-destructive">
          Could not load the comparison: {(error as Error).message}
        </p>
      ) : !lineages.length ? (
        <p className="text-xs text-muted-foreground">
          No paired monitor readings recorded yet. Enter commercial monitor values during a case, or
          import reference data, and each setup will appear here.
        </p>
      ) : (
        <div className="space-y-3">
          {lineages.map((l) => (
            <LineageCard key={l.lineageKey} lineage={l} showRaw={showRaw} />
          ))}
        </div>
      )}
    </section>
  );
}

export default LineageComparisonPanel;

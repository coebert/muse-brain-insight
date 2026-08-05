import { useState } from "react";
import { ChevronDown, Gauge } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";
import type { ParameterInfoKey } from "@/lib/eeg/parameter-info";
import type { AssessmentUncertainty, UncertaintyReport } from "@/lib/eeg/uncertainty";
import { cn } from "@/lib/utils";

const BAND_STYLE: Record<AssessmentUncertainty["band"], { cls: string; label: string }> = {
  high: { cls: "border-signal/50 text-signal", label: "High confidence" },
  moderate: { cls: "border-caution/50 text-caution", label: "Moderate confidence" },
  low: { cls: "border-critical/50 text-critical", label: "Low confidence" },
};

const BAR_TONE: Record<AssessmentUncertainty["band"], string> = {
  high: "bg-signal",
  moderate: "bg-caution",
  low: "bg-critical",
};

const INFO_KEY: Record<AssessmentUncertainty["key"], ParameterInfoKey> = {
  spectral: "sef95",
  suppression: "sr",
  seizure: "seizure",
};

/** Signed horizontal bar: supporting factors grow right, weakening ones left. */
function FactorBar({ impact }: { impact: number }) {
  const pct = Math.min(50, Math.abs(impact) * 50);
  const positive = impact >= 0;
  return (
    <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <span className="absolute inset-y-0 left-1/2 w-px bg-border" />
      <span
        className={cn(
          "absolute inset-y-0 rounded-full",
          positive ? "left-1/2 bg-signal/80" : "right-1/2 bg-critical/80",
        )}
        style={{ width: `${Math.max(1.5, pct)}%` }}
      />
    </div>
  );
}

function AssessmentCard({ a }: { a: AssessmentUncertainty }) {
  const [open, setOpen] = useState(false);
  const band = BAND_STYLE[a.band];
  return (
    <div className="panel min-w-0 px-3 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="flex min-w-0 items-center gap-1.5 text-xs tracking-[0.12em] text-muted-foreground uppercase">
          <span className="truncate">{a.label}</span>
          <ParameterInfo parameter={INFO_KEY[a.key]} />
        </p>
        <Badge variant="outline" className={cn("shrink-0 text-[10px]", band.cls)}>
          {(a.confidence * 100).toFixed(0)} %
        </Badge>
      </div>

      <p className="metric-value mt-1 text-2xl leading-none">
        {a.value}
        {a.unit ? <span className="ml-1 text-sm text-muted-foreground">{a.unit}</span> : null}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {a.interval
          ? `95 % CI ${a.interval.low.toFixed(a.key === "seizure" ? 2 : a.key === "spectral" ? 1 : 0)}–${a.interval.high.toFixed(
              a.key === "seizure" ? 2 : a.key === "spectral" ? 1 : 0,
            )}${a.unit ? ` ${a.unit}` : ""} · ${a.samples} epoch(s) / ${a.windowSeconds} s`
          : "No interval yet — insufficient clean EEG."}
      </p>

      <div className="mt-2">
        <div className="flex items-center justify-between text-[10px] tracking-wide text-muted-foreground uppercase">
          <span className="flex items-center gap-1.5">
            Model confidence
            <ParameterInfo parameter="confidence" />
          </span>
          <span>{band.label}</span>
        </div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-all duration-500", BAR_TONE[a.band])}
            style={{ width: `${Math.max(2, a.confidence * 100)}%` }}
          />
        </div>
      </div>

      <Button
        size="sm"
        variant="ghost"
        className="mt-2 h-8 w-full justify-between px-2 text-xs"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        Contributing factors
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
      </Button>

      {open ? (
        <div className="mt-1 space-y-2.5">
          <p className="text-xs text-muted-foreground">{a.summary}</p>
          {a.factors.map((f) => (
            <div key={f.key} className="space-y-1">
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="min-w-0 truncate text-foreground">{f.label}</span>
                <span className="metric-value shrink-0 text-muted-foreground">{f.value}</span>
              </div>
              <FactorBar impact={f.impact} />
              <p className="text-[11px] leading-snug text-muted-foreground/80">{f.meaning}</p>
            </div>
          ))}
          {a.interval ? (
            <p className="text-[11px] text-muted-foreground/70">Method: {a.interval.method}.</p>
          ) : null}
          {a.caveats.length ? (
            <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground/80">
              {a.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export interface AssessmentConfidencePanelProps {
  report: UncertaintyReport;
}

/**
 * Shows the model's confidence, 95 % interval and the factors driving each of
 * the three headline assessments, so the displayed numbers can be judged rather
 * than simply believed.
 */
export function AssessmentConfidencePanel({ report }: AssessmentConfidencePanelProps) {
  return (
    <section className="space-y-2">
      <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        <Gauge className="size-3.5" />
        Assessment confidence &amp; intervals
      </h2>
      <div className="grid gap-3 md:grid-cols-3">
        <AssessmentCard a={report.spectral} />
        <AssessmentCard a={report.suppression} />
        <AssessmentCard a={report.seizure} />
      </div>
    </section>
  );
}

/**
 * The confidence score behind the COEBIS number, and the data-sufficiency
 * checks that produced it — so a clinician can see exactly why the model is
 * still provisional rather than just being told that it is.
 */
import { AlertTriangle, Check, CircleSlash, Minus } from "lucide-react";

import {
  evaluateCoebisSufficiency,
  type CheckStatus,
  type CoebisSufficiency,
} from "@/lib/eeg/coebis-sufficiency";
import type { BisDriftAnalysis } from "@/lib/eeg/bis-drift";
import type { LineageGate, LineageSummary } from "@/lib/eeg/model-lineage";
import { cn } from "@/lib/utils";

const TONE_TEXT: Record<CoebisSufficiency["tone"], string> = {
  signal: "text-signal",
  caution: "text-caution",
  critical: "text-critical",
  default: "text-muted-foreground",
};

const TONE_BG: Record<CoebisSufficiency["tone"], string> = {
  signal: "bg-signal",
  caution: "bg-caution",
  critical: "bg-critical",
  default: "bg-muted-foreground",
};

const STATUS_STYLE: Record<CheckStatus, { icon: typeof Check; className: string; label: string }> = {
  pass: { icon: Check, className: "text-signal", label: "Passed" },
  partial: { icon: Minus, className: "text-caution", label: "Partly met" },
  fail: { icon: AlertTriangle, className: "text-critical", label: "Not met" },
  "n/a": { icon: CircleSlash, className: "text-muted-foreground", label: "Not applicable" },
};

export function CoebisSufficiencyPanel({
  analysis,
  active,
  lineage,
  className,
}: {
  analysis: BisDriftAnalysis | null | undefined;
  active?:
    | { gain: number; offset: number; nPoints: number; maeBefore: number | null; maeAfter: number | null }
    | null;
  /** Acquisition setups behind the training data, and the gate on this device. */
  lineage?: { summary?: LineageSummary | null; gate?: LineageGate | null } | null;
  className?: string;
}) {
  const s = evaluateCoebisSufficiency(analysis, active ?? null, lineage ?? null);

  return (
    <section className={cn("rounded-md border border-border", className)}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <h3 className="text-xs font-semibold">Model confidence</h3>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[11px] font-medium",
            s.tier === "confirmed"
              ? "bg-signal/15 text-signal"
              : s.tier === "provisional"
                ? "bg-caution/15 text-caution"
                : "bg-muted text-muted-foreground",
          )}
        >
          {s.tier === "confirmed" ? "Confirmed" : s.tier === "provisional" ? "Provisional" : "No model"}
        </span>
        <span className={cn("ml-auto text-[11px] font-medium", TONE_TEXT[s.tone])}>
          {s.checks.length ? `${s.passed}/${s.checks.length} checks passed` : "No checks yet"}
        </span>
      </header>

      <div className="space-y-3 px-3 py-2.5">
        <p className="text-xs text-muted-foreground">{s.headline}</p>

        {s.components.length ? (
          <div>
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Confidence by dimension
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              Reported separately rather than blended into one number — strength in one dimension
              does not compensate for absent evidence in another.
            </p>
            <ul className="mt-1.5 space-y-1.5">
              {s.components.map((c) => {
                const pct = c.value == null ? null : Math.round(c.value * 100);
                const tone: CoebisSufficiency["tone"] =
                  pct == null ? "default" : pct >= 75 ? "signal" : pct >= 50 ? "caution" : "critical";
                return (
                  <li key={c.key}>
                    <div className="flex items-baseline gap-2">
                      <span className="text-xs font-medium">{c.label}</span>
                      <span className={cn("ml-auto text-[11px] font-medium", TONE_TEXT[tone])}>
                        {pct == null ? "not yet judgeable" : `${pct} %`}
                      </span>
                    </div>
                    <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full transition-all", TONE_BG[tone])}
                        style={{ width: `${pct ?? 0}%` }}
                      />
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{c.detail}</p>
                    <p className="text-[11px] text-muted-foreground/70">{c.limitation}</p>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {s.missing.length ? (
          <div className="rounded-md border border-border/70 px-2.5 py-2">
            <p className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
              Not established yet
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
              {s.missing.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {s.checks.length ? (
          <ul className="space-y-1.5">
            {s.checks.map((c) => {
              const style = STATUS_STYLE[c.status];
              const Icon = style.icon;
              return (
                <li key={c.id} className="flex gap-2">
                  <Icon
                    className={cn("mt-0.5 size-3.5 shrink-0", style.className)}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <p className="text-xs font-medium">
                      {c.label}{" "}
                      <span className={cn("text-[11px] font-normal", style.className)}>
                        · {style.label}
                      </span>
                    </p>
                    <p className="text-[11px] text-muted-foreground">{c.detail}</p>
                    <p className="text-[11px] text-muted-foreground/70">Needs: {c.requirement}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}

        {s.nextStep ? (
          <p className="rounded-md bg-muted/40 px-2.5 py-2 text-[11px] text-muted-foreground">
            {s.nextStep}
          </p>
        ) : null}
      </div>
    </section>
  );
}
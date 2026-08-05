import { useState } from "react";
import { ChevronDown, Info } from "lucide-react";

import { confidenceWord, type SeizureEvidence } from "@/lib/eeg/seizure-evidence";
import { cn } from "@/lib/utils";

function toneFor(confidence: number): { chip: string; bar: string; text: string } {
  const word = confidenceWord(confidence);
  if (word === "high")
    return { chip: "border-signal/50 bg-signal/15 text-signal", bar: "bg-signal", text: "text-signal" };
  if (word === "moderate")
    return {
      chip: "border-caution/50 bg-caution/15 text-caution",
      bar: "bg-caution",
      text: "text-caution",
    };
  return {
    chip: "border-critical/50 bg-critical/15 text-critical",
    bar: "bg-critical",
    text: "text-critical",
  };
}

/** Compact confidence chip — safe to place inline next to an event title. */
export function SeizureConfidenceChip({
  evidence,
  className,
}: {
  evidence: SeizureEvidence;
  className?: string;
}) {
  const tone = toneFor(evidence.confidence);
  return (
    <span
      className={cn(
        "metric-value inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] tracking-[0.08em] uppercase",
        tone.chip,
        className,
      )}
      title={`AI confidence ${(evidence.confidence * 100).toFixed(0)} % — ${confidenceWord(
        evidence.confidence,
      )}. ${evidence.explanation}`}
    >
      AI {(evidence.confidence * 100).toFixed(0)}%
      <span className="opacity-70">{confidenceWord(evidence.confidence)}</span>
    </span>
  );
}

/**
 * Interpretable "why did this fire?" panel for a seizure-suspicion event:
 * confidence, the weighted feature contributions behind the score, the signal
 * context and the caveats that would make it a false positive.
 */
export function SeizureEvidenceCard({ evidence }: { evidence: SeizureEvidence }) {
  const [open, setOpen] = useState(false);
  const tone = toneFor(evidence.confidence);

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-muted/20">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        <Info className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Why this fired
            <SeizureConfidenceChip evidence={evidence} />
          </span>
          {!open ? (
            <span className="mt-0.5 line-clamp-2 block text-xs text-foreground/80">
              {evidence.explanation}
            </span>
          ) : null}
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open ? (
        <div className="space-y-3 border-t border-border/70 px-2.5 py-2 text-xs">
          <p className="text-foreground/90">{evidence.explanation}</p>

          <div className="space-y-2">
            {evidence.features.map((f) => (
              <div key={f.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-foreground">{f.label}</span>
                  <span className="metric-value text-muted-foreground">
                    {f.value} · {(f.share * 100).toFixed(0)} % of score
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full", tone.bar)}
                    style={{ width: `${Math.max(2, f.share * 100)}%` }}
                  />
                </div>
                <p className="mt-0.5 text-muted-foreground">{f.meaning}</p>
              </div>
            ))}
          </div>

          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-muted-foreground">
            <Row
              label="Peak score"
              value={`${evidence.peakScore.toFixed(2)} (threshold ${evidence.threshold.toFixed(2)})`}
            />
            <Row
              label="Epochs"
              value={`${evidence.epochsObserved} seen / ${evidence.epochsRequired} required`}
            />
            <Row label="Signal quality" value={`${(evidence.signalQuality * 100).toFixed(0)} %`} />
            <Row label="EMG index" value={`${(evidence.emgIndex * 100).toFixed(0)} %`} />
          </dl>

          <div>
            <p className="text-[10px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">
              Interpret with care
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-muted-foreground">
              {evidence.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>

          <p className={cn("text-[10px]", tone.text)}>
            Confidence reflects signal quality and baseline maturity, not diagnostic certainty —
            decision support only.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] tracking-[0.1em] uppercase">{label}</dt>
      <dd className="metric-value truncate text-foreground/90">{value}</dd>
    </div>
  );
}

import { useState } from "react";
import {
  Activity,
  BrainCircuit,
  ChevronDown,
  ChevronRight,
  Gauge,
  Microscope,
  MessageSquareQuote,
  SignalLow,
  Waves,
  Zap,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type {
  AlertEvidence,
  AlertFeedbackInfluence,
  AlertPriorFeedback,
} from "@/lib/eeg/interpret.functions";
import type { AlertTuningEffect } from "@/lib/eeg/alert-tuning";

const DIRECTION_LABEL: Record<string, string> = {
  high: "↑ high",
  low: "↓ low",
  rising: "↗ rising",
  falling: "↘ falling",
  unstable: "∿ unstable",
  normal: "→ within range",
};

type FeatureKind = "spectral" | "suppression" | "seizure" | "depth" | "quality" | "other";

const KIND_META: Record<FeatureKind, { icon: LucideIcon; label: string; className: string }> = {
  spectral: { icon: Waves, label: "Spectral", className: "text-foreground" },
  suppression: { icon: Activity, label: "Suppression", className: "text-warning" },
  seizure: { icon: Zap, label: "Ictal", className: "text-critical" },
  depth: { icon: Gauge, label: "Depth", className: "text-foreground" },
  quality: { icon: SignalLow, label: "Signal quality", className: "text-muted-foreground" },
  other: { icon: BrainCircuit, label: "Other", className: "text-foreground" },
};

/** Classifies an AI-named feature into a clinical metric family. */
function featureKind(feature: string): FeatureKind {
  const f = feature.toLowerCase();
  if (/(usable|quality|artefact|artifact|gating|reliab|emg|electrode|dropout|contact)/.test(f))
    return "quality";
  if (/(suppress|bsr|isoelectric|burst)/.test(f)) return "suppression";
  if (/(seizure|ictal|rhythmic|spike|periodic)/.test(f)) return "seizure";
  if (/(depth|qcon|qnox|bis)/.test(f)) return "depth";
  if (/(sef|entropy|alpha|beta|delta|theta|power|spectral|frequency)/.test(f)) return "spectral";
  return "other";
}

const INFLUENCE_META: Record<
  AlertFeedbackInfluence["adjustment"],
  { label: string; className: string }
> = {
  raised_bar: {
    label: "Evidential bar raised",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  reinforced: {
    label: "Reinforced by your feedback",
    className: "border-success/40 bg-success/10 text-success",
  },
  reworded: { label: "Reframed after feedback", className: "border-border bg-muted/40" },
  downgraded: {
    label: "Downgraded after feedback",
    className: "border-warning/40 bg-warning/10 text-warning",
  },
  none: { label: "No prior feedback applied", className: "border-border bg-muted/30" },
};

function clock(t: number): string {
  const m = Math.floor(Math.max(0, t) / 60);
  const s = Math.floor(Math.max(0, t) % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function windowLabel(e: AlertEvidence): string {
  const a = e.windowStartSeconds;
  const b = e.windowEndSeconds;
  if (a == null && b == null) return "whole session";
  if (a != null && b != null) {
    const dur = Math.max(0, b - a);
    return `${clock(a)}–${clock(b)} (${dur >= 60 ? `${Math.round(dur / 60)} min` : `${Math.round(dur)} s`})`;
  }
  return `from ${clock((a ?? b) as number)}`;
}

/** Shows the exact contributing EEG features behind an AI alert and how feedback shaped it. */
export function AlertEvidencePanel({
  evidence,
  feedbackInfluence,
  priorFeedback,
  tuning,
}: {
  evidence?: AlertEvidence[] | undefined;
  feedbackInfluence?: AlertFeedbackInfluence | null;
  priorFeedback?: AlertPriorFeedback | null;
  tuning?: AlertTuningEffect | null;
}) {
  const [open, setOpen] = useState(false);
  const hasFeedback = Boolean(feedbackInfluence || priorFeedback || tuning);
  if (!evidence?.length && !hasFeedback) return null;

  const items = evidence ?? [];
  const qualityFlags = items.filter((e) => featureKind(e.feature) === "quality");
  const influence = feedbackInfluence ?? null;
  const influenceMeta = influence ? INFLUENCE_META[influence.adjustment] : null;

  return (
    <div className="mt-2 rounded-md border border-border/70 bg-background/50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
      >
        {open ? (
          <ChevronDown className="h-3 w-3" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3" aria-hidden />
        )}
        <Microscope className="h-3 w-3" aria-hidden />
        Why this alert · {items.length} contributing feature{items.length === 1 ? "" : "s"}
        {qualityFlags.length ? (
          <span className="metric-value rounded-full border border-border bg-muted/50 px-1.5 py-0.5 text-[9px] normal-case tracking-normal">
            {qualityFlags.length} quality flag{qualityFlags.length > 1 ? "s" : ""}
          </span>
        ) : null}
        {influenceMeta && influence?.adjustment !== "none" ? (
          <span
            className={`metric-value rounded-full border px-1.5 py-0.5 text-[9px] normal-case tracking-normal ${influenceMeta.className}`}
          >
            {influenceMeta.label}
          </span>
        ) : null}
        {tuning && (tuning.originalConfidence || tuning.originalSeverity) ? (
          <span className="metric-value rounded-full border border-marker/40 bg-marker/10 px-1.5 py-0.5 text-[9px] normal-case tracking-normal text-marker">
            Auto-tuned
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="space-y-2 border-t border-border/70 px-2.5 py-2">
          <ul className="space-y-2">
            {items.map((e, i) => {
              const kind = featureKind(e.feature);
              const meta = KIND_META[kind];
              const Icon = meta.icon;
              return (
                <li
                  key={`${e.feature}-${i}`}
                  className={kind === "quality" ? "rounded-sm bg-muted/40 px-1.5 py-1" : undefined}
                >
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <Icon
                      className={`h-3 w-3 shrink-0 self-center ${meta.className}`}
                      aria-hidden
                    />
                    <span className="text-xs font-medium text-foreground">{e.feature}</span>
                    <span className="metric-value text-xs text-foreground">{e.value}</span>
                    <span className="metric-value text-xs uppercase tracking-wide text-muted-foreground">
                      {DIRECTION_LABEL[e.direction] ?? e.direction}
                    </span>
                    {e.expected ? (
                      <span className="metric-value text-xs text-muted-foreground">
                        vs {e.expected}
                      </span>
                    ) : null}
                    <span className="metric-value ml-auto text-xs text-muted-foreground">
                      {windowLabel(e)}
                    </span>
                  </div>
                  <div
                    className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
                    role="img"
                    aria-label={`Contribution ${Math.round(e.weight * 100)}%`}
                  >
                    <div
                      className={`h-full rounded-full ${kind === "quality" ? "bg-muted-foreground" : "bg-marker"}`}
                      style={{
                        width: `${Math.round(Math.max(0.04, Math.min(1, e.weight)) * 100)}%`,
                      }}
                    />
                  </div>
                  {e.note ? (
                    <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{e.note}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          {hasFeedback ? (
            <div
              className={`rounded-md border px-2 py-1.5 ${influenceMeta?.className ?? "border-border bg-muted/30"}`}
            >
              <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide">
                <MessageSquareQuote className="h-3 w-3" aria-hidden />
                {influenceMeta?.label ?? "Your feedback on this alert"}
              </div>
              {influence?.note ? (
                <p className="mt-0.5 text-xs leading-snug">{influence.note}</p>
              ) : null}
              {priorFeedback ? (
                <p className="metric-value mt-0.5 text-xs opacity-90">
                  Prior verdicts: {priorFeedback.correct} correct · {priorFeedback.incorrect}{" "}
                  incorrect
                  {priorFeedback.reasons.length
                    ? ` — reasons given: ${priorFeedback.reasons.join("; ")}`
                    : ""}
                </p>
              ) : null}
              {tuning ? (
                <p className="metric-value mt-0.5 text-xs opacity-90">
                  Adaptive tuning: {tuning.note} Confidence weight ×
                  {tuning.confidenceWeight.toFixed(2)}, evidence bar {tuning.evidenceBar}.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { memo } from "react";
import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "caution" | "critical" | "signal";
  pulse?: boolean;
  /** 0–1 confidence in this metric; renders a small quality bar. */
  confidence?: number | undefined;
  /** Metric is currently gated out by signal quality — show it as untrusted. */
  unreliable?: boolean | undefined;
  /** Metric is usable but degraded by artefact. */
  degraded?: boolean | undefined;
  /** Why the metric is unreliable/degraded (tooltip). */
  reliabilityReasons?: string[] | undefined;
}

const toneClass: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-foreground",
  signal: "text-signal",
  caution: "text-caution",
  critical: "text-critical",
};

function confidenceTone(c: number): { bar: string; text: string; word: string } {
  if (c >= 0.75) return { bar: "bg-signal", text: "text-signal", word: "high" };
  if (c >= 0.45) return { bar: "bg-caution", text: "text-caution", word: "moderate" };
  return { bar: "bg-critical", text: "text-critical", word: "low" };
}

function MetricTileInner({
  label,
  value,
  unit,
  hint,
  tone = "default",
  pulse,
  confidence,
  unreliable,
  degraded,
  reliabilityReasons,
}: Props) {
  const conf = confidence == null ? null : confidenceTone(confidence);
  const reasonText = reliabilityReasons?.length ? reliabilityReasons.join(" · ") : undefined;
  return (
    <div
      className={cn(
        "panel px-3 py-3 sm:px-4",
        pulse && "alert-pulse border-critical",
        unreliable && "border-dashed border-muted-foreground/50",
      )}
      {...(reasonText ? { title: reasonText } : {})}
    >
      <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground sm:text-xs sm:tracking-[0.14em]">
        {label}
      </p>
      <p
        className={cn(
          "metric-value mt-1 text-2xl leading-none sm:text-3xl",
          toneClass[tone],
          unreliable && "text-muted-foreground opacity-60",
        )}
      >
        {value}
        {unit ? (
          <span className="ml-1 text-sm text-muted-foreground sm:text-base">{unit}</span>
        ) : null}
      </p>
      {unreliable || degraded ? (
        <p
          className={cn(
            "mt-1 inline-flex rounded-sm px-1.5 py-0.5 text-[9px] font-semibold tracking-[0.14em] uppercase",
            unreliable ? "bg-critical/15 text-critical" : "bg-caution/15 text-caution",
          )}
        >
          {unreliable ? "Unreliable" : "Degraded"}
        </p>
      ) : null}
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      {reasonText ? (
        <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">{reasonText}</p>
      ) : null}
      {conf && confidence != null ? (
        <div
          className="mt-2"
          title={`Confidence ${(confidence * 100).toFixed(0)} % — ${conf.word}, based on live signal quality`}
        >
          <div className="flex items-center justify-between text-xs tracking-wide text-muted-foreground uppercase">
            <span>Confidence</span>
            <span className={cn("metric-value", conf.text)}>{(confidence * 100).toFixed(0)} %</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all duration-500", conf.bar)}
              style={{ width: `${Math.max(2, confidence * 100)}%` }}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export const MetricTile = memo(MetricTileInner);

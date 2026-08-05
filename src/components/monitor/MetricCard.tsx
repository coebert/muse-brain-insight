import { memo } from "react";
import { cn } from "@/lib/utils";
import { ParameterInfo } from "@/components/monitor/ParameterInfo";
import type { ParameterInfoKey } from "@/lib/eeg/parameter-info";

/** Clinical tone shared by every metric readout in the app. */
export type MetricTone = "default" | "caution" | "critical" | "signal";

export const metricToneText: Record<MetricTone, string> = {
  default: "text-foreground",
  signal: "text-signal",
  caution: "text-caution",
  critical: "text-critical",
};

/** Bedside variant dims the default label so the coloured values dominate. */
const bedsideToneText: Record<MetricTone, string> = {
  ...metricToneText,
  default: "text-muted-foreground",
};

const bedsideToneBorder: Record<MetricTone, string> = {
  default: "border-border",
  signal: "border-signal/50",
  caution: "border-caution/50",
  critical: "border-critical/60",
};

export interface MetricCardProps {
  label: string;
  value: string;
  unit?: string | undefined;
  /** Secondary line under the value. */
  hint?: string | undefined;
  tone?: MetricTone | undefined;
  pulse?: boolean | undefined;
  /** 0–1 confidence in this metric; renders a small quality bar (tile only). */
  confidence?: number | undefined;
  /** Metric is currently gated out by signal quality — show it as untrusted. */
  unreliable?: boolean | undefined;
  /** Metric is usable but degraded by artefact. */
  degraded?: boolean | undefined;
  /** Why the metric is unreliable/degraded (tooltip). */
  reliabilityReasons?: string[] | undefined;
  /** Opens an explanation of significance, physiology and reliability. */
  info?: ParameterInfoKey | undefined;
  /** `tile` = dashboard grid card, `bedside` = fullscreen monitor numeric. */
  size?: "tile" | "bedside";
}

function confidenceTone(c: number): { bar: string; text: string; word: string } {
  if (c >= 0.75) return { bar: "bg-signal", text: "text-signal", word: "high" };
  if (c >= 0.45) return { bar: "bg-caution", text: "text-caution", word: "moderate" };
  return { bar: "bg-critical", text: "text-critical", word: "low" };
}

function MetricCardInner({
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
  info,
  size = "tile",
}: MetricCardProps) {
  const reasonText = reliabilityReasons?.length ? reliabilityReasons.join(" · ") : undefined;

  if (size === "bedside") {
    return (
      <div
        className={cn(
          "flex min-w-0 flex-col justify-center rounded-lg border bg-[rgb(8,16,34)] px-3 py-2",
          bedsideToneBorder[tone],
          pulse && "alert-pulse border-critical",
          unreliable && "border-dashed border-muted-foreground/50",
        )}
        {...(reasonText ? { title: reasonText } : {})}
      >
        <p className="flex items-center gap-1.5 text-xs tracking-[0.16em] text-muted-foreground uppercase">
          {label}
          {info ? <ParameterInfo parameter={info} /> : null}
          {unreliable ? (
            <span className="rounded-sm bg-critical/15 px-1 py-px text-[9px] tracking-normal text-critical">
              unreliable
            </span>
          ) : null}
        </p>
        <p
          className={cn(
            "metric-value leading-none",
            bedsideToneText[tone],
            unreliable && "text-muted-foreground opacity-60",
          )}
        >
          <span className="text-[clamp(1.6rem,5.5vmin,3rem)]">{value}</span>
          {unit ? <span className="ml-1 text-sm text-muted-foreground">{unit}</span> : null}
        </p>
        {hint ? <p className="truncate text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    );
  }

  const conf = confidence == null ? null : confidenceTone(confidence);
  return (
    <div
      className={cn(
        "panel px-3 py-3 sm:px-4",
        pulse && "alert-pulse border-critical",
        unreliable && "border-dashed border-muted-foreground/50",
      )}
      {...(reasonText ? { title: reasonText } : {})}
    >
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-[0.12em] text-muted-foreground sm:text-xs sm:tracking-[0.14em]">
        <span className="min-w-0">{label}</span>
        {info ? <ParameterInfo parameter={info} /> : null}
      </p>
      <p
        className={cn(
          "metric-value mt-1 text-2xl leading-none sm:text-3xl",
          metricToneText[tone],
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
            <span className="flex items-center gap-1.5">
              Confidence
              <ParameterInfo parameter="confidence" />
            </span>
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

export const MetricCard = memo(MetricCardInner);

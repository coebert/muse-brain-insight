import { memo } from "react";
import { cn } from "@/lib/utils";
import type { HemiMetrics } from "@/hooks/useEegMonitor";

interface Props {
  metrics: HemiMetrics | null;
  compact?: boolean;
  className?: string;
}

const GRADE_TONE: Record<HemiMetrics["qualityGrade"], string> = {
  good: "border-normal/50 bg-normal/15 text-normal",
  fair: "border-caution/50 bg-caution/15 text-caution",
  poor: "border-critical/50 bg-critical/15 text-critical",
};

/**
 * Per-hemisphere trust indicator: electrode-pair signal quality plus the
 * confidence attached to that side's spectral metrics.
 */
function HemiQualityBadgeInner({ metrics, compact = false, className }: Props) {
  if (!metrics) return null;
  const flat = metrics.flat;
  const grade = flat ? "poor" : metrics.qualityGrade;
  const conf = Math.round(metrics.spectralConfidence * 100);
  const quality = Math.round(metrics.qualityScore * 100);
  const title = flat
    ? "Electrode off / flat signal"
    : metrics.reasons.length
      ? metrics.reasons.join(" · ")
      : "Clean signal";

  return (
    <div
      title={title}
      className={cn(
        "metric-value flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-xs tracking-[0.08em] uppercase backdrop-blur-sm",
        GRADE_TONE[grade],
        className,
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          grade === "good" ? "bg-normal" : grade === "fair" ? "bg-caution" : "bg-critical",
        )}
      />
      <span>{flat ? "No signal" : grade}</span>
      {!compact && <span className="opacity-70">Q {quality}%</span>}
      <span className="opacity-70">Conf {flat ? 0 : conf}%</span>
    </div>
  );
}

export const HemiQualityBadge = memo(HemiQualityBadgeInner);

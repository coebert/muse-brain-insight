/**
 * Small confidence chip shown next to the COEBIS number: how well the active
 * correction fits the paired commercial-BIS readings it was learned from.
 */
import { computeCoebisFitQuality } from "@/lib/eeg/coebis-fit-quality";
import type { BisAlignment } from "@/lib/eeg/depth";
import { cn } from "@/lib/utils";

const TONE_CLASS: Record<string, string> = {
  signal: "bg-signal/15 text-signal",
  caution: "bg-caution/15 text-caution",
  critical: "bg-critical/15 text-critical",
  default: "bg-muted text-muted-foreground",
};

export function CoebisFitBadge({
  model,
  className,
  compact = false,
}: {
  model: BisAlignment | null;
  className?: string;
  compact?: boolean;
}) {
  const q = computeCoebisFitQuality(model);
  return (
    <span
      title={q.detail}
      className={cn(
        "inline-flex max-w-full flex-wrap items-center gap-1 rounded-sm px-1 py-px text-[11px] font-medium tracking-normal",
        TONE_CLASS[q.tone] ?? TONE_CLASS["default"],
        className,
      )}
    >
      {compact ? q.label.replace(" fit", "") : q.label}
      {q.inFitPercent != null ? <span className="opacity-80">{q.inFitPercent}% in ±5</span> : null}
      {model?.provisional ? (
        <span className="rounded-sm bg-caution/20 px-1 text-caution" title="Fitted on early data — indicative only">
          prov
        </span>
      ) : null}
    </span>
  );
}

/** Text line for tile hints: "Fit: good · bias +1.2 · MAE 3.4 · n = 84 · ~86% in ±5". */
export function coebisFitHint(model: BisAlignment | null): string {
  const q = computeCoebisFitQuality(model);
  const inFit = q.inFitPercent == null ? "" : ` · ~${q.inFitPercent}% in ±5`;
  const prov = model?.provisional ? " · provisional (early data)" : "";
  return `${q.label} · ${q.residualSummary}${inFit}${prov}`;
}

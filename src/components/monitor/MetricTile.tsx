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

export function MetricTile({
  label,
  value,
  unit,
  hint,
  tone = "default",
  pulse,
  confidence,
}: Props) {
  const conf = confidence == null ? null : confidenceTone(confidence);
  return (
    <div className={cn("panel px-3 py-3 sm:px-4", pulse && "alert-pulse border-critical")}>
      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground sm:text-[11px] sm:tracking-[0.14em]">
        {label}
      </p>
      <p className={cn("metric-value mt-1 text-2xl leading-none sm:text-3xl", toneClass[tone])}>
        {value}
        {unit ? <span className="ml-1 text-sm text-muted-foreground sm:text-base">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
      {conf && confidence != null ? (
        <div
          className="mt-2"
          title={`Confidence ${(confidence * 100).toFixed(0)} % — ${conf.word}, based on live signal quality`}
        >
          <div className="flex items-center justify-between text-[10px] tracking-wide text-muted-foreground uppercase">
            <span>Confidence</span>
            <span className={cn("metric-value", conf.text)}>
              {(confidence * 100).toFixed(0)} %
            </span>
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
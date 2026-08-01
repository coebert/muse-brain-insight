import { cn } from "@/lib/utils";

interface Props {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "default" | "caution" | "critical" | "signal";
  pulse?: boolean;
}

const toneClass: Record<NonNullable<Props["tone"]>, string> = {
  default: "text-foreground",
  signal: "text-signal",
  caution: "text-caution",
  critical: "text-critical",
};

export function MetricTile({ label, value, unit, hint, tone = "default", pulse }: Props) {
  return (
    <div className={cn("panel px-4 py-3", pulse && "alert-pulse border-critical")}>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className={cn("metric-value mt-1 text-3xl leading-none", toneClass[tone])}>
        {value}
        {unit ? <span className="ml-1 text-base text-muted-foreground">{unit}</span> : null}
      </p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
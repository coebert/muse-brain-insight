import { Battery, BatteryFull, BatteryLow, BatteryMedium, BatteryWarning } from "lucide-react";

import { cn } from "@/lib/utils";

interface Props {
  /** Latest charge reported by the headband, or null when unknown. */
  percent: number | null;
  /** True while the headband link is up; a stale reading is shown dimmed. */
  connected: boolean;
  className?: string;
}

/**
 * Battery charge of the paired Muse 2, kept in view so a case is never lost to
 * a flat headband. Colour follows clinical urgency: low charge is a caution,
 * critically low is a destructive warning.
 */
export function BatteryIndicator({ percent, connected, className }: Props) {
  if (percent == null) return null;

  const tone =
    percent < 15
      ? "border-destructive/50 text-destructive"
      : percent < 30
        ? "border-caution/60 text-caution"
        : "border-border text-muted-foreground";
  const Icon =
    percent < 15 ? BatteryWarning : percent < 30 ? BatteryLow : percent < 70 ? BatteryMedium : BatteryFull;

  return (
    <span
      role="status"
      aria-label={`Headband battery ${percent} percent${connected ? "" : " (last known)"}`}
      title={connected ? "Muse 2 battery" : "Muse 2 battery — last known reading"}
      className={cn(
        "metric-value inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs",
        tone,
        !connected && "opacity-60",
        className,
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {percent}%
      {percent < 15 ? <span className="hidden sm:inline">· charge soon</span> : null}
    </span>
  );
}

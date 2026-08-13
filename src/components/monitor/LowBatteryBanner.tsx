import { BatteryWarning, BellRing, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BATTERY_THRESHOLD_CHOICES, notificationsSupported } from "@/lib/eeg/battery-alert";
import { cn } from "@/lib/utils";

interface Props {
  percent: number | null;
  threshold: number;
  critical: boolean;
  notify: boolean;
  permission: NotificationPermission | "unsupported";
  onThresholdChange: (v: number) => void;
  onNotifyChange: (v: boolean) => void;
  onDismiss: () => void;
}

/**
 * Bedside low-battery strip. Stays up while the headband is below the
 * clinician's threshold so a case is never lost to a flat Muse 2.
 */
export function LowBatteryBanner({
  percent,
  threshold,
  critical,
  notify,
  permission,
  onThresholdChange,
  onNotifyChange,
  onDismiss,
}: Props) {
  const canNotify = notificationsSupported();
  return (
    <section
      role="status"
      aria-label="Headband battery alert"
      className={cn(
        "panel flex flex-wrap items-center gap-x-3 gap-y-2 border-l-4 px-3 py-2 sm:px-4",
        critical ? "border-critical bg-critical/10 text-critical" : "border-caution bg-caution/10 text-caution",
      )}
    >
      <BatteryWarning className="size-4 shrink-0" aria-hidden />
      <span className="text-sm font-semibold text-foreground">
        Headband battery {percent}%
      </span>
      <span className="text-xs text-muted-foreground">
        {critical
          ? "Critically low — charge or swap the Muse 2 now to avoid losing the case."
          : `At or below your ${threshold}% alert level. Plan a charge or swap.`}
      </span>

      <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        Alert at
        <select
          value={threshold}
          onChange={(e) => onThresholdChange(Number(e.target.value))}
          className="metric-value min-h-8 rounded border border-border bg-background px-1.5 py-1 text-xs text-foreground"
        >
          {BATTERY_THRESHOLD_CHOICES.map((v) => (
            <option key={v} value={v}>
              {v}%
            </option>
          ))}
        </select>
      </label>

      {canNotify ? (
        <Button
          size="sm"
          variant={notify && permission === "granted" ? "secondary" : "outline"}
          onClick={() => onNotifyChange(!(notify && permission === "granted"))}
          title={
            permission === "denied"
              ? "Browser notifications are blocked for this site"
              : "Also raise a browser notification"
          }
          disabled={permission === "denied"}
        >
          <BellRing className="size-4" />
          {notify && permission === "granted" ? "Notifications on" : "Notify me"}
        </Button>
      ) : null}

      <Button size="sm" variant="ghost" aria-label="Dismiss battery alert" onClick={onDismiss}>
        <X className="size-4" />
      </Button>
    </section>
  );
}

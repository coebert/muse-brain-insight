import { Button } from "@/components/ui/button";
import {
  BATTERY_THRESHOLD_CHOICES,
  notificationsSupported,
  useBatteryAlert,
} from "@/lib/eeg/battery-alert";

/**
 * Settings control for the Muse 2 low-battery alert: the threshold and whether
 * a browser notification accompanies the on-screen banner.
 */
export function BatteryAlertPanel() {
  const alert = useBatteryAlert(null, false);
  const canNotify = notificationsSupported();

  return (
    <section className="panel mt-6 px-4 py-4">
      <h2 className="text-sm font-semibold">Headband battery alert</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        A banner appears on the monitor when the paired Muse 2 reports a charge at or below this
        level, so a case is never lost to a flat headband.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        Alert at
        <select
          value={alert.threshold}
          onChange={(e) => alert.setThreshold(Number(e.target.value))}
          className="metric-value min-h-9 rounded border border-border bg-background px-2 py-1 text-sm"
        >
          {BATTERY_THRESHOLD_CHOICES.map((v) => (
            <option key={v} value={v}>
              {v}%
            </option>
          ))}
        </select>
      </label>

      {canNotify ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={alert.notify && alert.permission === "granted" ? "secondary" : "outline"}
            disabled={alert.permission === "denied"}
            onClick={() => void alert.setNotify(!(alert.notify && alert.permission === "granted"))}
          >
            {alert.notify && alert.permission === "granted"
              ? "Browser notifications on"
              : "Enable browser notifications"}
          </Button>
          <span className="text-xs text-muted-foreground">
            {alert.permission === "denied"
              ? "Blocked by the browser for this site."
              : "Repeats at most every 10 minutes while the charge stays low."}
          </span>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          This browser does not support notifications; the on-screen banner is still shown.
        </p>
      )}
    </section>
  );
}

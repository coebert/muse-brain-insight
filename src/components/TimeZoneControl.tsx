import { Globe } from "lucide-react";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  COMMON_TIME_ZONES,
  DEVICE_ZONE_LABEL,
  STORAGE_TIME_ZONE,
  deviceTimeZone,
  timeZoneAbbreviation,
  timeZoneOffsetLabel,
  useTimeZonePreference,
} from "@/lib/eeg/timezone";

/**
 * Compact zone switcher for list/report headers. Changing it only re-renders
 * timestamps — stored case times remain UTC instants.
 */
export function TimeZoneControl({ className }: { className?: string }) {
  const { preference, zone, abbreviation, offsetLabel, setPreference } = useTimeZonePreference();
  const device = deviceTimeZone();
  const options = Array.from(new Set([...COMMON_TIME_ZONES, zone]));

  return (
    <div className={`flex flex-wrap items-center gap-2 text-xs ${className ?? ""}`}>
      <span className="flex items-center gap-1 text-muted-foreground">
        <Globe className="size-3.5" aria-hidden />
        Times shown in
      </span>
      <Select value={preference} onValueChange={setPreference}>
        <SelectTrigger
          className="h-8 w-[15rem] text-xs"
          aria-label="Timezone used to display case times"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="device">
            {DEVICE_ZONE_LABEL} — {device}
          </SelectItem>
          {options.map((z) => (
            <SelectItem key={z} value={z}>
              {z} · {timeZoneOffsetLabel(z)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="metric-value rounded-full bg-muted px-2 py-0.5 text-muted-foreground">
        {abbreviation} · {offsetLabel}
      </span>
      <span className="text-muted-foreground">
        Stored in {STORAGE_TIME_ZONE} — display only
      </span>
    </div>
  );
}

/** Fuller explanation for the settings page. */
export function TimeZonePanel() {
  const { zone, abbreviation, offsetLabel } = useTimeZonePreference();
  return (
    <section className="panel mt-6 px-4 py-4">
      <h2 className="text-sm font-semibold">Case timestamps</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Every case start, finish and event time is recorded as a {STORAGE_TIME_ZONE} instant, so
        records stay comparable across sites and daylight-saving changes. Choosing a different zone
        below re-renders those instants in that zone; the stored values are never altered.
      </p>
      <div className="mt-3">
        <TimeZoneControl />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Currently displaying in <span className="metric-value">{zone}</span> ({abbreviation},{" "}
        {offsetLabel}).
      </p>
    </section>
  );
}

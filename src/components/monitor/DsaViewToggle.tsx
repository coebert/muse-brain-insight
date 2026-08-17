import type { DsaView } from "@/hooks/useEegMonitor";
import { cn } from "@/lib/utils";

const OPTIONS: { key: DsaView; label: string }[] = [
  { key: "bilateral", label: "Bilateral" },
  { key: "combined", label: "Combined" },
  { key: "overlay", label: "Overlay" },
];

/** One segmented DSA layout control, shared by the dashboard and full screen. */
export function DsaViewToggle({
  value,
  onChange,
  size = "md",
  full = false,
}: {
  value: DsaView;
  onChange: (next: DsaView) => void;
  size?: "sm" | "md";
  /** Stretch to fill the available width (dashboard header row). */
  full?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label="DSA layout"
      className={cn(
        "inline-flex rounded-md border border-border bg-card/70 p-0.5",
        full && "flex w-full",
      )}
    >
      {OPTIONS.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={cn(
            "rounded px-2 text-xs font-medium transition-colors",
            size === "sm" ? "min-h-8" : "min-h-11 sm:min-h-9",
            full && "flex-1",
            value === o.key
              ? "bg-signal/15 text-signal"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

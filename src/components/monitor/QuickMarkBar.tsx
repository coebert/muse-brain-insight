import { useCallback, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Eye,
  PauseCircle,
  Scissors,
  Syringe,
  Wind,
  Zap,
  type LucideIcon,
} from "lucide-react";

import { formatClock } from "@/lib/eeg/format";
import {
  quickMarkerTemplates,
  recordMarkerUse,
  type MarkerIconKey,
  type MarkerMode,
  type MarkerTemplate,
} from "@/lib/eeg/marker-presets";
import { cn } from "@/lib/utils";

const ICONS: Record<MarkerIconKey, LucideIcon> = {
  syringe: Syringe,
  scissors: Scissors,
  activity: Activity,
  zap: Zap,
  wind: Wind,
  eye: Eye,
  pause: PauseCircle,
  alert: AlertTriangle,
};

const TONE: Record<MarkerTemplate["tone"], string> = {
  marker: "hover:border-marker hover:text-marker",
  signal: "hover:border-signal hover:text-signal",
  caution: "hover:border-caution hover:text-caution",
  critical: "hover:border-critical hover:text-critical",
};

/**
 * One-tap marker templates. Each button places its marker immediately at its
 * own default timestamp — drugs and stimuli at the case clock, observations
 * back-dated to when they were realistically seen — so nothing has to be typed
 * or chosen mid-case. Order adapts to what this clinician actually uses.
 */
export function QuickMarkBar({
  mode,
  elapsed,
  running,
  onMark,
  onMore,
  className,
  size = "default",
}: {
  mode: MarkerMode;
  elapsed: number;
  running: boolean;
  onMark: (label: string, backdateSeconds?: number) => void;
  onMore?: () => void;
  className?: string;
  size?: "default" | "compact";
}) {
  // Snapshot the order once per mount so buttons never move under a thumb
  // mid-tap; recency is picked up next time the bar mounts.
  const [templates, setTemplates] = useState<MarkerTemplate[]>(() => quickMarkerTemplates(mode));
  const [modeSeen, setModeSeen] = useState(mode);
  if (modeSeen !== mode) {
    setModeSeen(mode);
    setTemplates(quickMarkerTemplates(mode));
  }

  const place = useCallback(
    (template: MarkerTemplate) => {
      onMark(template.label, template.defaultBackdate);
      recordMarkerUse(template.id);
    },
    [onMark],
  );

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {templates.map((template) => {
        const Icon = ICONS[template.icon];
        const stamp = Math.max(0, elapsed - template.defaultBackdate);
        return (
          <button
            key={template.id}
            type="button"
            disabled={!running}
            onClick={() => place(template)}
            title={
              running
                ? `Marks "${template.label}" at ${formatClock(stamp)}${
                    template.defaultBackdate ? ` (−${template.defaultBackdate}s)` : ""
                  }`
                : "Start a case to mark events"
            }
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-border font-medium text-foreground transition-colors disabled:opacity-40 disabled:hover:border-border disabled:hover:text-foreground",
              size === "compact"
                ? "min-h-11 px-2.5 text-xs sm:min-h-9"
                : "min-h-11 px-3 text-xs sm:min-h-10",
              TONE[template.tone],
            )}
          >
            <Icon className="size-3.5 shrink-0" aria-hidden />
            <span className="whitespace-nowrap">{template.label}</span>
            {template.defaultBackdate ? (
              <span className="metric-value text-[11px] text-muted-foreground">
                −{template.defaultBackdate}s
              </span>
            ) : null}
          </button>
        );
      })}

      {onMore ? (
        <button
          type="button"
          onClick={onMore}
          className={cn(
            "rounded-full border border-dashed border-border font-medium text-muted-foreground transition-colors hover:text-foreground",
            size === "compact"
              ? "min-h-11 px-2.5 text-xs sm:min-h-9"
              : "min-h-11 px-3 text-xs sm:min-h-10",
          )}
        >
          More…
        </button>
      ) : null}
    </div>
  );
}

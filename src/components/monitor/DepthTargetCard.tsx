/**
 * Phase 5 — age- and patient-adjusted depth target.
 *
 * Commercial BIS shows 40–60 for everyone. This card derives a suggested
 * window from the age, frailty, regimen and context recorded for the case,
 * explains why, and applies it to the alert window with one tap.
 */
import { Target } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  formatWindow,
  recommendDepthWindow,
  type DepthTargetInputs,
} from "@/lib/eeg/depth-targets";
import type { DepthWindowPrefs } from "@/hooks/useDepthWindowAlerts";

export function DepthTargetCard({
  inputs,
  prefs,
  setPrefs,
}: {
  inputs: DepthTargetInputs;
  prefs: DepthWindowPrefs;
  setPrefs: (next: Partial<DepthWindowPrefs>) => void;
}) {
  const rec = recommendDepthWindow(inputs);
  const matches = prefs.low === rec.low && prefs.high === rec.high;

  return (
    <div className="rounded-lg border border-border bg-card/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Target className="h-4 w-4 text-signal" />
          <p className="text-sm font-semibold text-foreground">
            Suggested target {formatWindow(rec.low, rec.high)}
          </p>
        </div>
        {matches ? (
          <span className="rounded-sm bg-signal/15 px-1.5 py-px text-[11px] font-medium text-signal">
            In use
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setPrefs({ low: rec.low, high: rec.high, enabled: true })}
          >
            Use this window
          </Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {rec.label}
        {rec.isDefault ? " · no patient-specific adjustment applied" : " · patient-adjusted"}
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-muted-foreground">
        {rec.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {rec.caveats.length ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-caution">
          {rec.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

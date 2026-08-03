import { HeartPulse, Info } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import { formatDuration } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";
import type { DepthWindowPrefs, DepthWindowStatus } from "@/hooks/useDepthWindowAlerts";

export interface DepthWindowPanelProps {
  depthWindow: {
    prefs: DepthWindowPrefs;
    setPrefs: (next: Partial<DepthWindowPrefs>) => void;
    status: DepthWindowStatus;
    breachSeconds: number;
  };
  depthIndex: number | null | undefined;
}

/**
 * Out-of-window depth alert banner plus the OpenIBIS explainer with the
 * configurable target-window popover.
 */
export function DepthWindowPanel({ depthWindow, depthIndex }: DepthWindowPanelProps) {
  return (
    <>
      {depthWindow.prefs.enabled &&
      (depthWindow.status === "below" || depthWindow.status === "above") ? (
        <Alert
          className={cn(
            depthWindow.status === "below"
              ? "border-critical/50 bg-critical/10"
              : "border-caution/50 bg-caution/10",
          )}
        >
          <Info
            className={cn(
              "size-4",
              depthWindow.status === "below" ? "text-critical" : "text-caution",
            )}
          />
          <AlertTitle className="text-foreground">
            Depth index {depthWindow.status === "below" ? "below" : "above"} target window (
            {depthWindow.prefs.low}–{depthWindow.prefs.high})
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            OpenIBIS {depthIndex ?? "—"} for {formatDuration(Math.round(depthWindow.breachSeconds))}{" "}
            —{" "}
            {depthWindow.status === "below"
              ? "possible excessive hypnotic depth / burst suppression risk."
              : "possible light anaesthesia — consider awareness risk."}
          </AlertDescription>
        </Alert>
      ) : null}

      <Alert className="border-signal/30 bg-signal/5">
        <Info className="size-4 text-signal" />
        <AlertTitle className="flex flex-wrap items-center justify-between gap-2 text-foreground">
          <span>About the depth index (OpenIBIS)</span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Configure depth index alert window"
                className="flex min-h-[36px] items-center gap-1.5 rounded-md border border-border px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              >
                <HeartPulse className="h-4 w-4" />
                <span className="metric-value">
                  {depthWindow.prefs.enabled
                    ? `Alert outside ${depthWindow.prefs.low}–${depthWindow.prefs.high}`
                    : "Alerts off"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <p className="text-sm font-semibold">Depth index alert window</p>
              <p className="mt-1 text-xs font-normal text-muted-foreground">
                Raises a visual alert when OpenIBIS stays outside the target window. Saved on this
                device.
              </p>
              <div className="mt-3 flex items-center justify-between gap-2">
                <label className="text-xs font-medium">Enable alerts</label>
                <Button
                  type="button"
                  size="sm"
                  variant={depthWindow.prefs.enabled ? "default" : "outline"}
                  onClick={() => depthWindow.setPrefs({ enabled: !depthWindow.prefs.enabled })}
                >
                  {depthWindow.prefs.enabled ? "On" : "Off"}
                </Button>
              </div>
              <div className="mt-3 flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium">Lower bound</label>
                <span className="metric-value text-xs text-muted-foreground">
                  {depthWindow.prefs.low}
                </span>
              </div>
              <Slider
                className="mt-2"
                min={10}
                max={90}
                step={1}
                value={[depthWindow.prefs.low]}
                onValueChange={([v]) => depthWindow.setPrefs({ low: v ?? 40 })}
              />
              <div className="mt-3 flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium">Upper bound</label>
                <span className="metric-value text-xs text-muted-foreground">
                  {depthWindow.prefs.high}
                </span>
              </div>
              <Slider
                className="mt-2"
                min={20}
                max={100}
                step={1}
                value={[depthWindow.prefs.high]}
                onValueChange={([v]) => depthWindow.setPrefs({ high: v ?? 60 })}
              />
              <div className="mt-3 flex items-baseline justify-between gap-2">
                <label className="text-xs font-medium">Must persist for</label>
                <span className="metric-value text-xs text-muted-foreground">
                  {depthWindow.prefs.dwellSeconds} s
                </span>
              </div>
              <Slider
                className="mt-2"
                min={0}
                max={180}
                step={5}
                value={[depthWindow.prefs.dwellSeconds]}
                onValueChange={([v]) => depthWindow.setPrefs({ dwellSeconds: v ?? 30 })}
              />
              <div className="mt-3 flex items-center justify-between gap-2">
                <label className="text-xs font-medium">Only when signal reliable</label>
                <Button
                  type="button"
                  size="sm"
                  variant={depthWindow.prefs.requireReliable ? "default" : "outline"}
                  onClick={() =>
                    depthWindow.setPrefs({
                      requireReliable: !depthWindow.prefs.requireReliable,
                    })
                  }
                >
                  {depthWindow.prefs.requireReliable ? "On" : "Off"}
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </AlertTitle>
        <AlertDescription className="text-muted-foreground">
          <p>
            OpenIBIS is an open, peer-reviewed re-implementation of the BIS-style processed EEG
            depth-of-anaesthesia index. It combines beta/alpha ratio, spectral edge frequency,
            burst-suppression burden and relative slow-wave power into a single 0–100 score.
          </p>
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            <li>
              <span className="font-medium text-foreground">Optimal general anaesthesia:</span>{" "}
              roughly 40–60 (light surgical anaesthesia / adequate hypnotic effect for most
              procedures). Your alert window is currently {depthWindow.prefs.low}–
              {depthWindow.prefs.high}.
            </li>
            <li>
              <span className="font-medium text-foreground">Below ~40:</span> increasing probability
              of deep hypnosis / burst suppression.
            </li>
            <li>
              <span className="font-medium text-foreground">Above ~60:</span> lighter anaesthesia
              with higher probability of awareness or movement response.
            </li>
            <li>
              Values are gated by signal quality; during artefact or EMG the tile is marked
              unreliable rather than reported.
            </li>
          </ul>
        </AlertDescription>
      </Alert>
    </>
  );
}

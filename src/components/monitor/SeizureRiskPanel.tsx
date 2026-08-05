import { Activity, Bell, Loader2, Sparkles, TrendingUp, X } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import type { SeizureTrendPrefs, SeizureTrendState } from "@/lib/eeg/seizure-trend";
import type { SeizureTrendAlert } from "@/hooks/useSeizureRiskAlerts";
import { cn } from "@/lib/utils";

export interface SeizureRiskPanelProps {
  prefs: SeizureTrendPrefs;
  setPrefs: (patch: Partial<SeizureTrendPrefs>) => void;
  trend: SeizureTrendState;
  alerts: SeizureTrendAlert[];
  dismiss: (id: string) => void;
}

const STATUS_TONE: Record<SeizureTrendState["status"], string> = {
  unknown: "border-border bg-muted/20",
  low: "border-signal/30 bg-signal/5",
  watch: "border-caution/50 bg-caution/10",
  elevated: "border-critical/50 bg-critical/10",
};

const LIKELIHOOD_TONE: Record<string, string> = {
  probable: "text-critical",
  possible: "text-caution",
  unlikely: "text-muted-foreground",
};

function pct(v: number): string {
  return `${(v * 100).toFixed(0)} %`;
}

/**
 * Live seizure-risk trend status, the configurable alert thresholds, and the
 * real-time AI read for each threshold crossing during the case.
 */
export function SeizureRiskPanel({ prefs, setPrefs, trend, alerts, dismiss }: SeizureRiskPanelProps) {
  return (
    <div className="space-y-3">
      <Alert className={cn(STATUS_TONE[trend.status])}>
        <Activity
          className={cn(
            "size-4",
            trend.status === "elevated"
              ? "text-critical"
              : trend.status === "watch"
                ? "text-caution"
                : "text-signal",
          )}
        />
        <AlertTitle className="flex flex-wrap items-center justify-between gap-2 text-foreground">
          <span>
            Seizure-risk trend —{" "}
            {trend.status === "unknown"
              ? "waiting for usable EEG"
              : trend.status === "elevated"
                ? "above threshold"
                : trend.status === "watch"
                  ? "watch"
                  : "low"}
          </span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Configure seizure-risk trend alerts"
                className="flex min-h-[36px] items-center gap-1.5 rounded-md border border-border px-2 text-xs font-normal text-muted-foreground hover:text-foreground"
              >
                <Bell className="h-4 w-4" />
                <span className="metric-value">
                  {prefs.enabled ? `Alert ≥ ${pct(prefs.riskThreshold)}` : "Alerts off"}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <p className="text-sm font-semibold">Seizure-risk trend alerts</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Alerts when the smoothed risk trend crosses your thresholds. Saved on this device.
              </p>
              <div className="mt-3 space-y-4">
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span>Trend alerting</span>
                  <Switch
                    checked={prefs.enabled}
                    onCheckedChange={(v) => setPrefs({ enabled: v })}
                    aria-label="Enable seizure-risk trend alerts"
                  />
                </label>
                <label className="flex items-center justify-between gap-3 text-xs">
                  <span>AI interpretation of each alert</span>
                  <Switch
                    checked={prefs.aiEnabled}
                    onCheckedChange={(v) => setPrefs({ aiEnabled: v })}
                    aria-label="Enable AI interpretation of trend alerts"
                  />
                </label>
                <Setting
                  label="Risk threshold"
                  value={pct(prefs.riskThreshold)}
                  min={10}
                  max={95}
                  step={1}
                  current={prefs.riskThreshold * 100}
                  onChange={(v) => setPrefs({ riskThreshold: v / 100 })}
                  hint="Smoothed risk that counts as elevated."
                />
                <Setting
                  label="Dwell before alert"
                  value={`${prefs.dwellSeconds} s`}
                  min={0}
                  max={300}
                  step={5}
                  current={prefs.dwellSeconds}
                  onChange={(v) => setPrefs({ dwellSeconds: v })}
                  hint="Time above threshold before alerting."
                />
                <Setting
                  label="Rate-of-rise limit"
                  value={`${(prefs.riseThreshold * 100).toFixed(0)} %/min`}
                  min={2}
                  max={100}
                  step={1}
                  current={prefs.riseThreshold * 100}
                  onChange={(v) => setPrefs({ riseThreshold: v / 100 })}
                  hint="Escalation alert even below the risk level."
                />
                <Setting
                  label="Trend window"
                  value={`${Math.round(prefs.trendWindowSeconds / 60)} min`}
                  min={1}
                  max={30}
                  step={1}
                  current={Math.round(prefs.trendWindowSeconds / 60)}
                  onChange={(v) => setPrefs({ trendWindowSeconds: v * 60 })}
                  hint="Window used for smoothing and rate of rise."
                />
                <Setting
                  label="Minimum signal quality"
                  value={pct(prefs.minQuality)}
                  min={0}
                  max={90}
                  step={5}
                  current={prefs.minQuality * 100}
                  onChange={(v) => setPrefs({ minQuality: v / 100 })}
                  hint="Noisier epochs are excluded from the trend."
                />
                <Setting
                  label="AI cooldown"
                  value={`${Math.round(prefs.cooldownSeconds / 60)} min`}
                  min={1}
                  max={30}
                  step={1}
                  current={Math.round(prefs.cooldownSeconds / 60)}
                  onChange={(v) => setPrefs({ cooldownSeconds: v * 60 })}
                  hint="Minimum gap between AI reads."
                />
              </div>
            </PopoverContent>
          </Popover>
        </AlertTitle>
        <AlertDescription className="text-muted-foreground">
          <span className="metric-value">
            Risk {pct(trend.risk)} · rise {trend.risePerMinute >= 0 ? "+" : ""}
            {(trend.risePerMinute * 100).toFixed(0)} %/min · {pct(trend.aboveFraction)} of window
            above threshold
            {trend.aboveSeconds > 0 ? ` · ${formatDuration(Math.round(trend.aboveSeconds))} above` : ""}
          </span>
          <span className="mt-0.5 block text-xs">
            Signal {pct(trend.quality)} · seizure-metric confidence {pct(trend.confidence)} · EMG{" "}
            {pct(trend.emg)}
            {trend.quality < prefs.minQuality + 0.1
              ? " — trend may be artefact-limited at this signal quality."
              : ""}
          </span>
        </AlertDescription>
      </Alert>

      {alerts.length ? (
        <ScrollArea className="max-h-72">
          <ul className="space-y-2 pr-2">
            {alerts
              .slice()
              .reverse()
              .map((a) => (
                <li
                  key={a.id}
                  className={cn(
                    "rounded-md border p-2.5",
                    a.assessment?.severity === "critical"
                      ? "border-critical/50 bg-critical/10"
                      : a.assessment?.severity === "advisory"
                        ? "border-border bg-muted/20"
                        : "border-caution/50 bg-caution/10",
                  )}
                >
                  <div className="flex items-start gap-2">
                    <TrendingUp className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">
                        {a.trigger === "sustained"
                          ? `Risk ${pct(a.risk)} sustained above threshold`
                          : `Risk rising ${(a.risePerMinute * 100).toFixed(0)} %/min`}
                      </p>
                      <p className="metric-value text-xs text-muted-foreground">
                        {formatClock(a.t)} · signal {pct(a.quality)}
                      </p>

                      {a.aiState === "pending" ? (
                        <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" aria-hidden /> AI reading the
                          trend…
                        </p>
                      ) : null}
                      {a.aiState === "error" ? (
                        <p className="mt-1.5 text-xs text-critical">{a.aiError}</p>
                      ) : null}
                      {a.aiState === "off" ? (
                        <p className="mt-1.5 text-xs text-muted-foreground">
                          AI read skipped (disabled or within cooldown).
                        </p>
                      ) : null}

                      {a.assessment ? (
                        <div className="mt-2 space-y-1.5 text-xs">
                          <p className="flex flex-wrap items-center gap-1.5 font-medium text-foreground">
                            <Sparkles className="size-3.5 text-signal" aria-hidden />
                            {a.assessment.headline}
                          </p>
                          <p className={cn("metric-value", LIKELIHOOD_TONE[a.assessment.likelihood])}>
                            {a.assessment.likelihood} ictal activity · {a.assessment.confidence}{" "}
                            confidence
                          </p>
                          <p className="text-muted-foreground">{a.assessment.detail}</p>
                          {a.assessment.actions.length ? (
                            <ul className="list-disc space-y-0.5 pl-4 text-foreground/90">
                              {a.assessment.actions.map((x) => (
                                <li key={x}>{x}</li>
                              ))}
                            </ul>
                          ) : null}
                          {a.assessment.supporting.length ? (
                            <p className="metric-value text-muted-foreground">
                              {a.assessment.supporting.join(" · ")}
                            </p>
                          ) : null}
                          {a.assessment.caveats.length ? (
                            <p className="text-muted-foreground">
                              Caveats: {a.assessment.caveats.join("; ")}
                            </p>
                          ) : null}
                          <p className="text-[10px] text-muted-foreground">
                            Decision support only — not a diagnosis.
                          </p>
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7 shrink-0"
                      aria-label="Dismiss alert"
                      onClick={() => dismiss(a.id)}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </li>
              ))}
          </ul>
        </ScrollArea>
      ) : null}
    </div>
  );
}

function Setting({
  label,
  value,
  min,
  max,
  step,
  current,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  onChange: (v: number) => void;
  hint: string;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span>{label}</span>
        <span className="metric-value text-muted-foreground">{value}</span>
      </div>
      <Slider
        className="mt-2"
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([v]) => onChange(v ?? current)}
        aria-label={label}
      />
      <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}

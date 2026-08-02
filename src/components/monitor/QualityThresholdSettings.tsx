import { RotateCcw, SlidersHorizontal } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Slider } from "@/components/ui/slider";
import type { QualityThresholds } from "@/lib/eeg/coverage";

interface Field {
  key: keyof QualityThresholds;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  /** Percent-style fields are stored 0–1 but shown 0–100. */
  percent?: boolean;
}

const FIELDS: Field[] = [
  {
    key: "windowCoverageInsufficient",
    label: "Alert window — insufficient below",
    hint: "EEG epochs present inside the alert window",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "windowCoveragePartial",
    label: "Alert window — partial below",
    hint: "Flags windows with thin but usable coverage",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "windowGapCadences",
    label: "Alert window gap limit",
    hint: "Missing run, in epoch intervals, that flags a window",
    min: 1,
    max: 20,
    step: 1,
  },
  {
    key: "evidenceIncompleteMax",
    label: "Evidence — insufficient above",
    hint: "Share of features without value, weight or time window",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "sessionCoverageInsufficient",
    label: "Session — insufficient below",
    hint: "Whole-recording epoch coverage",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "sessionCoveragePartial",
    label: "Session — partial below",
    hint: "Whole-recording epoch coverage",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "sessionGapCadences",
    label: "Session gap limit",
    hint: "Missing run, in epoch intervals, that flags the session",
    min: 1,
    max: 60,
    step: 1,
  },
  {
    key: "spectrumMissingMax",
    label: "Missing spectra — insufficient above",
    hint: "Epochs stored without a spectrum (no DSA to review)",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
  {
    key: "metricPresenceMin",
    label: "Metric present in at least",
    hint: "Below this, a metric is reported as missing",
    min: 0,
    max: 1,
    step: 0.05,
    percent: true,
  },
];

/** Popover of clinician-tunable thresholds that drive data-quality flags. */
export function QualityThresholdSettings({
  thresholds,
  onChange,
  onReset,
}: {
  thresholds: QualityThresholds;
  onChange: (patch: Partial<QualityThresholds>) => void;
  onReset: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal className="size-4" /> Quality thresholds
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[70vh] w-80 overflow-y-auto">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold">Data-quality thresholds</p>
          <Button variant="ghost" size="sm" onClick={onReset}>
            <RotateCcw className="size-3.5" /> Reset
          </Button>
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Sets when alert windows and the session are flagged as partial or insufficient. Saved on
          this device.
        </p>
        <div className="mt-3 space-y-4">
          {FIELDS.map((f) => {
            const value = thresholds[f.key];
            return (
              <div key={f.key}>
                <div className="flex items-baseline justify-between gap-2">
                  <label className="text-xs font-medium">{f.label}</label>
                  <span className="metric-value text-xs text-muted-foreground">
                    {f.percent ? `${Math.round(value * 100)} %` : `${value}×`}
                  </span>
                </div>
                <Slider
                  className="mt-2"
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  value={[value]}
                  onValueChange={([v]) => onChange({ [f.key]: v ?? value })}
                />
                <p className="mt-1 text-[10px] text-muted-foreground">{f.hint}</p>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { DETECTION_PRESETS, matchPreset, type AnalysisSettings } from "@/lib/eeg/analysis";
import { formatDuration } from "@/lib/eeg/format";

interface Props {
  settings: AnalysisSettings;
  /** Live burst-suppression readout shown against the limits below. */
  suppression?: {
    /** Current suppression ratio (%) over the configured window. */
    ratio: number | null;
    /** Peak suppression ratio (%) so far this case. */
    maxRatio: number;
    /** Cumulative suppressed time this case, in seconds. */
    seconds: number;
  };
  /** Applies a patch and records the reason in the case audit trail. */
  onApply: (patch: Partial<AnalysisSettings>, description: string) => void;
}

interface SliderRowProps {
  label: string;
  value: string;
  min: number;
  max: number;
  step: number;
  current: number;
  hint?: string;
  onChange: (value: number) => void;
}

function SliderRow({ label, value, min, max, step, current, hint, onChange }: SliderRowProps) {
  return (
    <div>
      <div className="flex justify-between text-xs text-muted-foreground">
        <Label className="text-xs">{label}</Label>
        <span className="metric-value">{value}</span>
      </div>
      <Slider
        className="mt-3"
        min={min}
        max={max}
        step={step}
        value={[current]}
        onValueChange={([v]) => onChange(v ?? current)}
      />
      {hint ? <p className="mt-2 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Sensitivity presets and the individual detection / trend-alert limits. */
export function DetectionThresholds({ settings, suppression, onApply }: Props) {
  const activePreset = matchPreset(settings);

  return (
    <div className="panel px-3 py-4 sm:px-4">
      <h2 className="text-sm font-semibold">Detection thresholds</h2>
      {suppression ? (
        <div className="mt-3 grid grid-cols-3 gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              SR ({settings.srWindowSeconds}s)
            </p>
            <p className="metric-value text-sm">
              {suppression.ratio == null ? "—" : `${suppression.ratio.toFixed(0)} %`}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Peak SR</p>
            <p className="metric-value text-sm">{suppression.maxRatio.toFixed(0)} %</p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Suppression time
            </p>
            <p className="metric-value text-sm">{formatDuration(suppression.seconds)}</p>
          </div>
        </div>
      ) : null}
      <div className="mt-3">
        <Label className="text-xs text-muted-foreground">Sensitivity preset</Label>
        <div className="mt-2 flex flex-wrap gap-2">
          {DETECTION_PRESETS.map((p) => (
            <Button
              key={p.key}
              size="sm"
              variant={activePreset === p.key ? "default" : "outline"}
              title={p.description}
              onClick={() => onApply(p.settings, `Sensitivity preset set to ${p.label}`)}
            >
              {p.label}
            </Button>
          ))}
          {activePreset === "custom" && (
            <span className="self-center text-xs text-muted-foreground">Custom</span>
          )}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {DETECTION_PRESETS.find((p) => p.key === activePreset)?.description ??
            "Manually tuned thresholds."}
        </p>
      </div>
      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <SliderRow
          label="Suppression amplitude"
          value={`${settings.suppressionThresholdUv} µV`}
          min={3}
          max={20}
          step={1}
          current={settings.suppressionThresholdUv}
          onChange={(v) =>
            onApply({ suppressionThresholdUv: v }, `Suppression amplitude set to ${v} µV`)
          }
        />
        <SliderRow
          label="Suppression ratio window"
          value={`${settings.srWindowSeconds} s`}
          min={30}
          max={300}
          step={30}
          current={settings.srWindowSeconds}
          onChange={(v) =>
            onApply({ srWindowSeconds: v }, `Suppression ratio window set to ${v} s`)
          }
        />
        <SliderRow
          label="Seizure alert threshold"
          value={settings.seizureThreshold.toFixed(2)}
          min={0.3}
          max={0.9}
          step={0.01}
          current={settings.seizureThreshold}
          onChange={(v) =>
            onApply({ seizureThreshold: v }, `Seizure threshold set to ${v.toFixed(2)}`)
          }
        />
        <SliderRow
          label="Alert persistence"
          value={`${settings.seizureEpochs} s`}
          min={1}
          max={10}
          step={1}
          current={settings.seizureEpochs}
          hint="Consecutive 1 s epochs above threshold before an alert is raised."
          onChange={(v) => onApply({ seizureEpochs: v }, `Alert persistence set to ${v} s`)}
        />
        <div className="border-t border-border pt-4">
          <h3 className="text-xs font-semibold">Trend alerts</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Depth-index swings and new or worsening burst suppression are timestamped in the event
            log and marked on the DSA timeline.
          </p>
        </div>
        <SliderRow
          label="Depth drop alert"
          value={`−${settings.depthDropUnits} units`}
          min={5}
          max={40}
          step={1}
          current={settings.depthDropUnits}
          onChange={(v) => onApply({ depthDropUnits: v }, `Depth drop alert set to ${v} units`)}
        />
        <SliderRow
          label="Depth rise alert"
          value={`+${settings.depthRiseUnits} units`}
          min={5}
          max={40}
          step={1}
          current={settings.depthRiseUnits}
          onChange={(v) => onApply({ depthRiseUnits: v }, `Depth rise alert set to ${v} units`)}
        />
        <SliderRow
          label="Depth trend window"
          value={`${settings.depthTrendSeconds} s`}
          min={30}
          max={300}
          step={15}
          current={settings.depthTrendSeconds}
          hint="Change is measured across this window; one alert per window at most."
          onChange={(v) => onApply({ depthTrendSeconds: v }, `Depth trend window set to ${v} s`)}
        />
        <SliderRow
          label="New burst suppression at"
          value={`${settings.bsrAlertPercent} % SR`}
          min={1}
          max={50}
          step={1}
          current={settings.bsrAlertPercent}
          onChange={(v) => onApply({ bsrAlertPercent: v }, `Burst suppression alert set to ${v} %`)}
        />
        <SliderRow
          label="Worsening step"
          value={`+${settings.bsrWorseningPercent} % SR`}
          min={2}
          max={30}
          step={1}
          current={settings.bsrWorseningPercent}
          hint="Re-alerts each time the suppression ratio climbs a further step."
          onChange={(v) =>
            onApply({ bsrWorseningPercent: v }, `Suppression worsening step set to ${v} %`)
          }
        />
      </div>
    </div>
  );
}

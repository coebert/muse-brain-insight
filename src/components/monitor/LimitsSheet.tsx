import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import type { CaseControls } from "@/components/monitor/case-controls";

function Row({
  label,
  value,
  live,
  children,
}: {
  label: string;
  value: string;
  live?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <span className="metric-value text-xs text-muted-foreground">
          {value}
          {live ? <span className="ml-2 text-signal">now {live}</span> : null}
        </span>
      </div>
      {children}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border p-3">
      <h3 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Every threshold that can raise an alarm, in one place, so limits can be
 * checked in a single pass before knife-to-skin.
 */
export function LimitsSheet({ controls }: { controls: CaseControls }) {
  const { settings, onSettingsChange, depthWindow, sqi, live } = controls;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {controls.limitsOffDefault ? (
          <Badge variant="outline" className="border-caution/50 text-caution">
            Off default limits
          </Badge>
        ) : (
          <Badge variant="outline" className="text-muted-foreground">
            {controls.mode === "icu" ? "ICU" : "Anaesthesia"} defaults
          </Badge>
        )}
        <Button variant="outline" size="sm" className="min-h-11" onClick={controls.onResetLimits}>
          Reset to {controls.mode === "icu" ? "ICU" : "anaesthesia"} defaults
        </Button>
      </div>

      <Group title="Depth">
        <div className="flex items-center justify-between py-1.5">
          <span className="text-xs text-foreground">Out-of-window alerts</span>
          <Switch
            checked={depthWindow.prefs.enabled}
            onCheckedChange={(v) => depthWindow.setPrefs({ enabled: v })}
          />
        </div>
        <Row
          label="Target window"
          value={`${depthWindow.prefs.low}–${depthWindow.prefs.high}`}
          live={live.depthIndex != null ? String(live.depthIndex) : undefined}
        >
          <Slider
            min={10}
            max={90}
            step={1}
            value={[depthWindow.prefs.low, depthWindow.prefs.high]}
            onValueChange={([low, high]) => depthWindow.setPrefs({ low, high })}
          />
        </Row>
        <Row label="Dwell before alerting" value={`${depthWindow.prefs.dwellSeconds} s`}>
          <Slider
            min={5}
            max={180}
            step={5}
            value={[depthWindow.prefs.dwellSeconds]}
            onValueChange={([v]) => depthWindow.setPrefs({ dwellSeconds: v })}
          />
        </Row>
        <Row label="Depth fall alert" value={`${settings.depthDropUnits} units`}>
          <Slider
            min={5}
            max={40}
            step={1}
            value={[settings.depthDropUnits]}
            onValueChange={([v]) => onSettingsChange({ depthDropUnits: v }, `Depth fall ${v}`)}
          />
        </Row>
        <Row label="Depth rise alert" value={`${settings.depthRiseUnits} units`}>
          <Slider
            min={5}
            max={40}
            step={1}
            value={[settings.depthRiseUnits]}
            onValueChange={([v]) => onSettingsChange({ depthRiseUnits: v }, `Depth rise ${v}`)}
          />
        </Row>
        <Row label="Trend window" value={`${settings.depthTrendSeconds} s`}>
          <Slider
            min={30}
            max={300}
            step={10}
            value={[settings.depthTrendSeconds]}
            onValueChange={([v]) =>
              onSettingsChange({ depthTrendSeconds: v }, `Trend window ${v}s`)
            }
          />
        </Row>
      </Group>

      <Group title="Suppression">
        <Row label="Suppression amplitude floor" value={`${settings.suppressionThresholdUv} µV`}>
          <Slider
            min={3}
            max={20}
            step={1}
            value={[settings.suppressionThresholdUv]}
            onValueChange={([v]) =>
              onSettingsChange({ suppressionThresholdUv: v }, `Suppression floor ${v} µV`)
            }
          />
        </Row>
        <Row
          label="Suppression ratio window"
          value={`${settings.srWindowSeconds} s`}
          live={live.suppressionRatio != null ? `${live.suppressionRatio}%` : undefined}
        >
          <Slider
            min={30}
            max={300}
            step={10}
            value={[settings.srWindowSeconds]}
            onValueChange={([v]) => onSettingsChange({ srWindowSeconds: v }, `SR window ${v}s`)}
          />
        </Row>
        <Row label="Burden alert" value={`${settings.bsrAlertPercent}%`}>
          <Slider
            min={1}
            max={60}
            step={1}
            value={[settings.bsrAlertPercent]}
            onValueChange={([v]) => onSettingsChange({ bsrAlertPercent: v }, `BSR alert ${v}%`)}
          />
        </Row>
        <Row label="Worsening step" value={`${settings.bsrWorseningPercent}%`}>
          <Slider
            min={1}
            max={40}
            step={1}
            value={[settings.bsrWorseningPercent]}
            onValueChange={([v]) =>
              onSettingsChange({ bsrWorseningPercent: v }, `BSR worsening ${v}%`)
            }
          />
        </Row>
      </Group>

      <Group title="Seizure">
        <Row
          label="Seizure score threshold"
          value={settings.seizureThreshold.toFixed(2)}
          live={live.seizureScore != null ? live.seizureScore.toFixed(2) : undefined}
        >
          <Slider
            min={0.3}
            max={0.95}
            step={0.01}
            value={[settings.seizureThreshold]}
            onValueChange={([v]) =>
              onSettingsChange({ seizureThreshold: v }, `Seizure threshold ${v.toFixed(2)}`)
            }
          />
        </Row>
        <Row label="Consecutive epochs" value={`${settings.seizureEpochs}`}>
          <Slider
            min={1}
            max={10}
            step={1}
            value={[settings.seizureEpochs]}
            onValueChange={([v]) => onSettingsChange({ seizureEpochs: v }, `Seizure epochs ${v}`)}
          />
        </Row>
      </Group>

      <Group title="Signal">
        <Row
          label="Signal-quality floor"
          value={`${sqi.threshold}%`}
          live={live.sqi != null ? `${live.sqi}%` : undefined}
        >
          <Slider
            min={10}
            max={90}
            step={5}
            value={[sqi.threshold]}
            onValueChange={([v]) => sqi.setThreshold(v)}
          />
        </Row>
      </Group>
    </div>
  );
}

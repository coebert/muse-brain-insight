import { useEffect, useMemo } from "react";
import { Minimize2, TriangleAlert } from "lucide-react";

import { TrendLine } from "@/components/monitor/TrendLine";
import { WaveformStrip } from "@/components/monitor/WaveformStrip";
import { Button } from "@/components/ui/button";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { HemiDsaPanel } from "@/components/monitor/HemiDsaPanel";
import { DsaMarkerRail } from "@/components/monitor/DsaMarkerRail";
import { MetricCard, metricToneText, type MetricTone } from "@/components/monitor/MetricCard";
import {
  type DsaView,
  type HemiEvent,
  type HemiLatest,
  type HemiSpectra,
} from "@/hooks/useEegMonitor";
import { COMPOSITE_BAND_LABEL, NOCICEPTION_BAND_LABEL } from "@/lib/eeg/composite";
import { DEPTH_STATE_LABEL, depthTone } from "@/lib/eeg/depth";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

interface Props {
  epochs: Epoch[];
  hemiSpectra: HemiSpectra[];
  hemiLatest: HemiLatest | null;
  hemiEvents: HemiEvent[];
  latest: Epoch | null;
  waveform: Float64Array;
  elapsed: number;
  sourceName: string;
  streaming: boolean;
  modeLabel: string;
  windowMinutes: number;
  markers: DetectedEvent[];
  suppressionSeconds: number;
  suppressionThresholdUv: number;
  dsaView: DsaView;
  onDsaViewChange: (view: DsaView) => void;
  onExit: () => void;
}

/** Bedside-monitor layout: one screen, large numerics, trends and DSA. */
export function FullscreenMonitor({
  epochs,
  hemiSpectra,
  hemiLatest,
  hemiEvents,
  latest,
  waveform,
  elapsed,
  sourceName,
  streaming,
  modeLabel,
  windowMinutes,
  markers,
  suppressionSeconds,
  suppressionThresholdUv,
  dsaView,
  onDsaViewChange,
  onExit,
}: Props) {
  // Enter the browser's fullscreen mode where allowed, and mirror Esc/F11 exits.
  useEffect(() => {
    const el = document.documentElement;
    let wasFullscreen = false;
    void el.requestFullscreen?.({ navigationUI: "hide" }).catch(() => undefined);
    const onChange = () => {
      // Only close the view when the browser leaves a fullscreen we actually entered
      // (Esc / F11); a rejected request must not bounce the user back.
      if (document.fullscreenElement) wasFullscreen = true;
      else if (wasFullscreen) onExit();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExit();
    };
    document.addEventListener("fullscreenchange", onChange);
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener("fullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
      if (document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    };
  }, [onExit]);

  const windowSeconds = windowMinutes * 60;
  const visible = useMemo(() => epochs.slice(-windowSeconds), [epochs, windowSeconds]);
  const markerRail = useMemo(
    () => markers.map((m) => ({ t: m.t, label: m.detail, tone: "marker" as const })),
    [markers],
  );
  const depthTrend = useMemo(() => visible.map((e) => e.depth.index), [visible]);
  const srTrend = useMemo(() => visible.map((e) => e.suppressionRatio), [visible]);
  const sefTrend = useMemo(() => visible.map((e) => e.sef95), [visible]);

  const depth = latest?.depth;
  const dTone: MetricTone = depth ? (depthTone(depth.state) as MetricTone) : "default";
  const srValue = latest?.suppressionRatio ?? 0;
  const srTone: MetricTone = srValue >= 40 ? "critical" : srValue >= 10 ? "caution" : "signal";
  const quality = latest?.quality;
  const qualityTone: MetricTone =
    quality?.grade === "poor" ? "critical" : quality?.grade === "fair" ? "caution" : "signal";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span
          className={cn(
            "metric-value rounded-full border px-2 py-0.5 text-xs",
            streaming ? "border-signal/50 text-signal" : "border-border text-muted-foreground",
          )}
        >
          {streaming ? `${sourceName} · live` : "not streaming"}
        </span>
        <span className="metric-value text-sm">{formatClock(elapsed)}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{modeLabel} mode</span>
        <span
          className={cn("metric-value ml-auto text-xs", metricToneText[qualityTone])}
          title={quality?.reasons.join(", ")}
        >
          Signal {quality ? `${Math.round(quality.score * 100)} %` : "—"}
        </span>
        <Button size="sm" variant="outline" onClick={onExit}>
          <Minimize2 className="size-4" /> Exit
        </Button>
      </div>

      {latest?.seizureAlert ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-critical/60 bg-critical/15 px-3 py-1.5 text-critical">
          <TriangleAlert className="size-4 shrink-0" />
          <span className="text-xs font-semibold">
            Possible seizure activity — score {latest.seizureScore.toFixed(2)}
          </span>
        </div>
      ) : null}

      {/* Bedside grid */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 overflow-auto p-2 lg:grid-cols-[minmax(0,1fr)_260px] lg:overflow-hidden short:grid-cols-[minmax(0,1fr)_180px]! short:overflow-hidden!">
        {/* Traces */}
        <div className="grid min-h-0 grid-rows-[auto_minmax(0,1.6fr)_minmax(0,1fr)] gap-2 short:grid-rows-[auto_minmax(0,1fr)]!">
          <div className="overflow-hidden rounded-lg border border-border bg-[rgb(8,16,34)]">
            <div className="flex items-center justify-between px-2 pt-1">
              <span className="text-xs tracking-[0.16em] text-muted-foreground uppercase">EEG</span>
              <span className="metric-value text-xs text-muted-foreground">
                {latest ? `${latest.amplitudeUv.toFixed(0)} µV p-p` : "—"}
              </span>
            </div>
            <div className="h-[70px] sm:h-[90px] short:h-[60px]!">
              <WaveformStrip
                data={waveform}
                suppressionThresholdUv={suppressionThresholdUv}
                suppressed={latest?.isSuppressed ?? false}
              />
            </div>
          </div>

          <div className="relative min-h-[140px] overflow-hidden rounded-lg border border-border bg-[rgb(8,16,34)]">
            <span className="absolute top-1 left-2 z-10 text-xs tracking-[0.16em] text-muted-foreground uppercase">
              DSA · {windowMinutes} min
            </span>
            <Button
              size="sm"
              variant="outline"
              className="absolute top-1 right-2 z-10 h-7 px-2 text-xs"
              onClick={() =>
                onDsaViewChange(
                  dsaView === "bilateral"
                    ? "combined"
                    : dsaView === "combined"
                      ? "overlay"
                      : "bilateral",
                )
              }
            >
              {dsaView === "bilateral"
                ? "Combined view"
                : dsaView === "combined"
                  ? "Overlay view"
                  : "Bilateral view"}
            </Button>
            <HemiDsaPanel
              hemiSpectra={hemiSpectra}
              hemiLatest={hemiLatest}
              hemiEvents={hemiEvents}
              dsaView={dsaView}
              windowSeconds={windowSeconds}
              elapsed={elapsed}
              compact
            />
            <DsaMarkerRail markers={markerRail} elapsed={elapsed} windowSeconds={windowSeconds} />
          </div>

          <div className="grid min-h-[110px] grid-cols-1 gap-2 sm:grid-cols-2 short:hidden!">
            <div className="overflow-hidden rounded-lg border border-border bg-[rgb(8,16,34)]">
              <div className="flex items-center justify-between px-2 pt-1">
                <span className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
                  Depth trend (0–100)
                </span>
                <span className="metric-value text-xs text-signal">{depth?.index ?? "—"}</span>
              </div>
              <div className="h-[calc(100%-18px)] min-h-[70px]">
                <TrendLine
                  values={depthTrend}
                  min={0}
                  max={100}
                  band={[40, 60]}
                  color="rgb(56,214,175)"
                />
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-border bg-[rgb(8,16,34)]">
              <div className="flex items-center justify-between px-2 pt-1">
                <span className="text-xs tracking-[0.16em] text-muted-foreground uppercase">
                  SEF95 / SR
                </span>
                <span className="metric-value text-xs text-muted-foreground">
                  {latest ? `${latest.sef95.toFixed(1)} Hz · ${srValue.toFixed(0)} %` : "—"}
                </span>
              </div>
              <div className="relative h-[calc(100%-18px)] min-h-[70px]">
                <TrendLine values={sefTrend} min={0} max={30} color="rgb(120,200,90)" />
                <div className="pointer-events-none absolute inset-0">
                  <TrendLine
                    values={srTrend}
                    min={0}
                    max={100}
                    color="rgb(245,190,40)"
                    transparent
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Numerics column */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-1 lg:content-start short:grid-cols-1! short:content-start! short:overflow-y-auto!">
          <div className="col-span-2 lg:col-span-1 short:col-span-1!">
            <MetricCard
              size="bedside"
              label="Depth index"
              value={depth?.index != null ? String(depth.index) : "—"}
              hint={
                depth
                  ? depth.held
                    ? `Held ${depth.heldSeconds.toFixed(0)} s`
                    : DEPTH_STATE_LABEL[depth.state]
                  : "Awaiting data"
              }
              tone={dTone}
              unreliable={latest ? !latest.depthReliability.reliable : false}
            />
          </div>
          <MetricCard
              size="bedside"
            label="Suppression ratio"
            value={latest ? srValue.toFixed(0) : "—"}
            unit="%"
            hint={`Supp. time ${formatDuration(suppressionSeconds)}`}
            tone={srTone}
          />
          <MetricCard
              size="bedside"
            label="SEF 95"
            value={latest ? latest.sef95.toFixed(1) : "—"}
            unit="Hz"
            hint={latest ? `Entropy ${latest.entropy.state.toFixed(2)}` : undefined}
          />
          <MetricCard
              size="bedside"
            label="qCON-like"
            value={latest?.composite.cIndex != null ? String(latest.composite.cIndex) : "—"}
            hint={latest ? COMPOSITE_BAND_LABEL[latest.composite.cBand] : undefined}
          />
          <MetricCard
              size="bedside"
            label="qNOX-like"
            value={latest?.composite.nIndex != null ? String(latest.composite.nIndex) : "—"}
            hint={latest ? NOCICEPTION_BAND_LABEL[latest.composite.nBand] : undefined}
          />
          <div className="col-span-2 lg:col-span-1 short:col-span-1!">
            <MetricCard
              size="bedside"
              label="Seizure score"
              value={latest ? latest.seizureScore.toFixed(2) : "—"}
              hint={latest?.seizureAlert ? "Rhythmic discharges" : "Below alert threshold"}
              tone={latest?.seizureAlert ? "critical" : "default"}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Minimize2, Moon, Sun, TriangleAlert } from "lucide-react";

import { CaseActionBar, type CaseSheet } from "@/components/monitor/CaseActionBar";
import { ConnectionStatusBadge } from "@/components/monitor/ConnectionStatusBadge";
import type { ConnectionStatusView } from "@/lib/eeg/connection-status";
import { TciStatusStrip } from "@/components/monitor/TciStatusStrip";
import { DsaViewToggle } from "@/components/monitor/DsaViewToggle";
import { useDeviceTuning } from "@/hooks/useDeviceTuning";
import { AlarmBanner } from "@/components/monitor/AlarmBanner";
import type { CaseControls } from "@/components/monitor/case-controls";
import { QuickMarkBar } from "@/components/monitor/QuickMarkBar";
import { TrendLine } from "@/components/monitor/TrendLine";
import { LiveWaveform } from "@/components/monitor/LiveWaveform";
import type { WaveformStore } from "@/lib/eeg/waveform-store";
import { Button } from "@/components/ui/button";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { alignSeries } from "@/lib/eeg/gaps";
import { HemiDsaPanel } from "@/components/monitor/HemiDsaPanel";
import { DsaMarkerRail } from "@/components/monitor/DsaMarkerRail";
import { CoebisTrend } from "@/components/monitor/CoebisTrend";
import { CoebisFitBadge, coebisFitHint } from "@/components/monitor/CoebisFitBadge";
import { MetricCard, metricToneText, type MetricTone } from "@/components/monitor/MetricCard";
import { suppressionTone } from "@/lib/eeg/derivations";
import {
  type DsaView,
  type HemiEvent,
  type HemiLatest,
  type HemiSpectra,
} from "@/hooks/useEegMonitor";
import { COMPOSITE_BAND_LABEL, NOCICEPTION_BAND_LABEL } from "@/lib/eeg/composite";
import { describeCoebisModel, useCoebisModel } from "@/hooks/useCoebisModel";
import { DEPTH_STATE_LABEL, depthTone } from "@/lib/eeg/depth";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { cn } from "@/lib/utils";

interface Props {
  epochs: Epoch[];
  hemiSpectra: HemiSpectra[];
  hemiLatest: HemiLatest | null;
  hemiEvents: HemiEvent[];
  latest: Epoch | null;
  waveformStore: WaveformStore;
  elapsed: number;
  /** Wall-clock case start, used for timestamped trend ticks. */
  startedAtMs?: number | null;
  sourceName: string;
  streaming: boolean;
  /** Live link state, so a dropout is visible on the fullscreen screen too. */
  connection?: ConnectionStatusView | undefined;
  modeLabel: string;
  windowMinutes: number;
  markers: DetectedEvent[];
  suppressionSeconds: number;
  suppressionThresholdUv: number;
  dsaView: DsaView;
  onDsaViewChange: (view: DsaView) => void;
  /** Live-case controls; when supplied the bedside action bar is rendered. */
  controls?: CaseControls | undefined;
  /** Raw headband signal, shown in the depth trend when no valid depth is available. */
  archive?: import("@/lib/eeg/raw-archive").RawArchive | null;
  profile?: import("@/lib/eeg/device-profile").DeviceProfile | null;
  onExit: () => void;
}

/** Bedside-monitor layout: one screen, large numerics, trends and DSA. */
export function FullscreenMonitor({
  epochs,
  hemiSpectra,
  hemiLatest,
  hemiEvents,
  latest,
  waveformStore,
  elapsed,
  sourceName,
  startedAtMs,
  streaming,
  connection,
  modeLabel,
  windowMinutes,
  markers,
  suppressionSeconds,
  suppressionThresholdUv,
  dsaView,
  onDsaViewChange,
  controls,
  archive = null,
  profile = null,
  onExit,
}: Props) {
  // Latest COEBIS fit, so the bedside tile names the model it is showing.
  const coebisModel = useCoebisModel();
  // Only offer the layouts the connected montage can actually draw.
  const tuning = useDeviceTuning();
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

  const [sheet, setSheet] = useState<CaseSheet>(null);
  const windowSeconds = windowMinutes * 60;
  const visible = useMemo(() => epochs.slice(-windowSeconds), [epochs, windowSeconds]);
  const markerRail = useMemo(
    () => markers.map((m) => ({ t: m.t, label: m.detail, tone: "marker" as const })),
    [markers],
  );
  // Trends are aligned to a per-second timeline: seconds with no epoch stay
  // null so the line breaks over a dropout instead of joining across it.
  const depthTrend = useMemo(
    () =>
      alignSeries<Epoch, number>(
        visible,
        (e) => e.t,
        (e) => e.depth.index,
      ),
    [visible],
  );
  const srTrend = useMemo(
    () =>
      alignSeries<Epoch, number>(
        visible,
        (e) => e.t,
        (e) => e.suppressionRatio,
      ),
    [visible],
  );
  const sefTrend = useMemo(
    () =>
      alignSeries<Epoch, number>(
        visible,
        (e) => e.t,
        (e) => e.sef95,
      ),
    [visible],
  );

  const depth = latest?.depth;
  const dTone: MetricTone = depth ? (depthTone(depth.state) as MetricTone) : "default";
  const srValue = latest?.suppressionRatio ?? 0;
  const srTone: MetricTone = suppressionTone(latest ? srValue : null);
  const quality = latest?.quality;
  const qualityTone: MetricTone =
    quality?.grade === "poor" ? "critical" : quality?.grade === "fair" ? "caution" : "signal";

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
      {/* Status bar */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        {connection ? (
          <ConnectionStatusBadge status={connection} />
        ) : (
          <span
            className={cn(
              "metric-value rounded-full border px-2 py-0.5 text-xs",
              streaming ? "border-signal/50 text-signal" : "border-border text-muted-foreground",
            )}
          >
            {streaming ? `${sourceName} · live` : "not streaming"}
          </span>
        )}
        <span className="metric-value text-sm">{formatClock(elapsed)}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{modeLabel} mode</span>
        <span
          className={cn("metric-value ml-auto text-xs", metricToneText[qualityTone])}
          title={quality?.reasons.join(", ")}
        >
          Signal {quality ? `${Math.round(quality.score * 100)} %` : "—"}
        </span>
        {controls ? (
          <Button
            size="sm"
            variant="ghost"
            aria-label={controls.dim ? "Undim display" : "Dim display for theatre"}
            onClick={() => controls.onDimChange(!controls.dim)}
          >
            {controls.dim ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>
        ) : null}
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

      {controls && controls.alarms.alarms.length ? (
        <div className="shrink-0 px-2 pt-2">
          <AlarmBanner
            alarms={controls.alarms.alarms}
            audioEnabled={controls.alarms.audioEnabled}
            muted={controls.alarms.muted}
            muteRemaining={controls.alarms.muteRemaining}
            onAcknowledge={controls.alarms.acknowledge}
            onAcknowledgeAll={controls.alarms.acknowledgeAll}
            onAcknowledgeSide={controls.alarms.acknowledgeSide}
            onPauseAudio={controls.alarms.pauseAudio}
            onResumeAudio={controls.alarms.resumeAudio}
            onToggleAudio={() => controls.alarms.setAudioEnabled(!controls.alarms.audioEnabled)}
          />
        </div>
      ) : null}

      {controls ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-2 pt-2">
          <div className="min-w-[14rem] flex-1">
            <TciStatusStrip infusions={controls?.infusions ?? []} onOpen={() => setSheet("tci")} />
          </div>
          <QuickMarkBar
            mode={controls.mode}
            elapsed={controls.elapsed}
            running={controls.running}
            onMark={controls.onMark}
            onMore={() => setSheet("mark")}
            size="compact"
          />
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
              <LiveWaveform
                store={waveformStore}
                suppressionThresholdUv={suppressionThresholdUv}
                suppressed={latest?.isSuppressed ?? false}
              />
            </div>
          </div>

          <div className="relative min-h-[140px] overflow-hidden rounded-lg border border-border bg-[rgb(8,16,34)]">
            <span className="absolute top-1 left-2 z-10 text-xs tracking-[0.16em] text-muted-foreground uppercase">
              DSA · {windowMinutes} min
            </span>
            <div className="absolute top-1 right-2 z-10">
              <DsaViewToggle
                value={dsaView}
                onChange={onDsaViewChange}
                available={tuning.dsaViews}
                size="sm"
              />
            </div>
            <HemiDsaPanel
              hemiSpectra={hemiSpectra}
              hemiLatest={hemiLatest}
              hemiEvents={hemiEvents}
              dsaView={dsaView}
              windowSeconds={windowSeconds}
              elapsed={elapsed}
              infusions={controls?.infusions ?? []}
              compact
            />
            <DsaMarkerRail markers={markerRail} elapsed={elapsed} windowSeconds={windowSeconds} />
          </div>

          <div className="grid min-h-[110px] grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 short:hidden!">
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
                  unit=""
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
                <TrendLine
                  values={sefTrend}
                  min={0}
                  max={30}
                  color="rgb(120,200,90)"
                  unit="Hz"
                  precision={1}
                />
                <div className="pointer-events-none absolute inset-0">
                  <TrendLine
                    values={srTrend}
                    min={0}
                    max={100}
                    color="rgb(245,190,40)"
                    transparent
                    inspectable={false}
                  />
                </div>
              </div>
            </div>
            <CoebisTrend
              epochs={epochs}
              elapsed={elapsed}
              windowMinutes={windowMinutes}
              startedAtMs={startedAtMs ?? null}
              compact
              archive={archive}
              profile={profile}
            />
          </div>
        </div>

        {/* Numerics column */}
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-1 lg:content-start short:grid-cols-1! short:content-start! short:overflow-y-auto!">
          <div className="col-span-2 lg:col-span-1 short:col-span-1!">
            <MetricCard
              size="bedside"
              label="Depth index (OpenIBIS)"
              info="depth"
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
          <div className="col-span-2 lg:col-span-1 short:col-span-1!">
            <MetricCard
              size="bedside"
              label="COEBIS"
              info="coebis"
              value={depth?.coebis != null ? String(depth.coebis) : "—"}
              hint={
                depth?.coebis != null
                  ? `OpenIBIS ${depth.index ?? "—"} · ${describeCoebisModel(coebisModel)} · ${coebisFitHint(coebisModel)}`
                  : describeCoebisModel(coebisModel)
              }
              badge={<CoebisFitBadge model={coebisModel} compact />}
              tone={dTone}
              unreliable={latest ? !latest.depthReliability.reliable : false}
            />
          </div>
          <MetricCard
            size="bedside"
            label="Suppression ratio"
            info="sr"
            value={latest ? srValue.toFixed(0) : "—"}
            unit="%"
            hint={`Supp. time ${formatDuration(suppressionSeconds)}`}
            tone={srTone}
          />
          <MetricCard
            size="bedside"
            label="SEF 95"
            info="sef95"
            value={latest ? latest.sef95.toFixed(1) : "—"}
            unit="Hz"
            hint={latest ? `Entropy ${latest.entropy.state.toFixed(2)}` : undefined}
          />
          <MetricCard
            size="bedside"
            label="qCON-like"
            info="cIndex"
            value={latest?.composite.cIndex != null ? String(latest.composite.cIndex) : "—"}
            hint={latest ? COMPOSITE_BAND_LABEL[latest.composite.cBand] : undefined}
          />
          <MetricCard
            size="bedside"
            label="qNOX-like"
            info="nIndex"
            value={latest?.composite.nIndex != null ? String(latest.composite.nIndex) : "—"}
            hint={latest ? NOCICEPTION_BAND_LABEL[latest.composite.nBand] : undefined}
          />
          <div className="col-span-2 lg:col-span-1 short:col-span-1!">
            <MetricCard
              size="bedside"
              label="Seizure score"
              info="seizure"
              value={latest ? latest.seizureScore.toFixed(2) : "—"}
              hint={latest?.seizureAlert ? "Rhythmic discharges" : "Below alert threshold"}
              tone={latest?.seizureAlert ? "critical" : "default"}
            />
          </div>
        </div>
      </div>

      {controls ? (
        <>
          <div className="h-14 shrink-0" />
          <CaseActionBar controls={controls} open={sheet} onOpenChange={setSheet} />
          {controls.dim ? (
            <button
              type="button"
              aria-label="Undim display"
              onClick={() => controls.onDimChange(false)}
              className="fixed inset-0 z-[60] cursor-pointer bg-black/60"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

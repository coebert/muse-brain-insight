import { createFileRoute, Link } from "@tanstack/react-router";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bluetooth,
  CircleStop,
  FlaskConical,
  Maximize2,
  Moon,
  MoreVertical,
  Plus,
  SignalLow,
  Sun,
  Save,
  Trash2,
  Undo2,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DsaChart, DsaLegend } from "@/components/monitor/DsaChart";
import { MonitorErrorBoundary } from "@/components/monitor/MonitorErrorBoundary";
import { AppNav } from "@/components/AppNav";
import { AlarmBanner } from "@/components/monitor/AlarmBanner";
import { useDsaViewPreference } from "@/lib/eeg/dsa-view-pref";
import { FullscreenMonitor } from "@/components/monitor/FullscreenMonitor";
import { EventLog } from "@/components/monitor/EventLog";
import { AiInsightPanel } from "@/components/monitor/AiInsightPanel";
import { TciResponsePanel } from "@/components/monitor/TciResponsePanel";
import { MetricsGrid } from "@/components/monitor/MetricsGrid";
import { CoebisModelPicker } from "@/components/monitor/CoebisModelPicker";
import { CoebisUnavailableBanner } from "@/components/monitor/CoebisUnavailableBanner";
import { CoebisTrend } from "@/components/monitor/CoebisTrend";
import { CoebisExplainPanel } from "@/components/monitor/CoebisExplainPanel";
import { CoebisVsBisPanel } from "@/components/monitor/CoebisVsBisPanel";
import { ageBand } from "@/lib/eeg/save";
import { CaseDialogs } from "@/components/monitor/CaseDialogs";
import { DetectionThresholds } from "@/components/monitor/DetectionThresholds";
import { useCaseAi } from "@/hooks/useCaseAi";
import { CoebisV2LivePanel } from "@/components/monitor/CoebisV2LivePanel";
import { HeadbandTracePanel } from "@/components/monitor/HeadbandTracePanel";

import { DepthWindowPanel } from "@/components/monitor/DepthWindowPanel";
import { SeizureRiskPanel } from "@/components/monitor/SeizureRiskPanel";
import { SeizureAlertCards } from "@/components/monitor/SeizureAlertCards";
import { SeizureValidationPanel } from "@/components/monitor/SeizureValidationPanel";
import { AssessmentConfidencePanel } from "@/components/monitor/AssessmentConfidencePanel";
import { useClinicalDerivations } from "@/hooks/useClinicalDerivations";
import { SignalQualityPanel } from "@/components/monitor/SignalQualityPanel";
import { SqiTrend } from "@/components/monitor/SqiTrend";
import { LiveWaveform } from "@/components/monitor/LiveWaveform";
import { RawChannelViewer } from "@/components/monitor/RawChannelViewer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useAuth } from "@/hooks/useAuth";
import { useAlarms, type AlarmCondition } from "@/hooks/useAlarms";
import { useMarkerAlerts } from "@/hooks/useMarkerAlerts";
import { useSqiAlerts } from "@/hooks/useSqiAlerts";
import { useSeizureRiskAlerts, type SeizureTrendAlert } from "@/hooks/useSeizureRiskAlerts";
import { useDepthWindowAlerts, type DepthWindowTransition } from "@/hooks/useDepthWindowAlerts";
import { useCoebisModel } from "@/hooks/useCoebisModel";
import { useEegMonitor } from "@/hooks/useEegMonitor";
import { HemiDsaPanel } from "@/components/monitor/HemiDsaPanel";
import { DsaMarkerRail } from "@/components/monitor/DsaMarkerRail";
import { DsaViewToggle } from "@/components/monitor/DsaViewToggle";
import {
  MODES,
  defaultWindowMinutes,
  modeConfig,
  type MonitorMode,
} from "@/components/monitor/monitor-modes";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { DETECTION_PRESETS } from "@/lib/eeg/analysis";
import { SIDE_LABEL, type AlarmSide } from "@/lib/eeg/alarms";
import { EMPTY_CASE_META, type CaseMeta } from "@/lib/eeg/case-meta";
import { setActiveDepthCalibration } from "@/lib/eeg/depth";
import { loadStoredCalibration } from "@/lib/eeg/calibration";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { isWebBluetoothAvailable } from "@/lib/eeg/muse";
import { channelLabel } from "@/lib/eeg/device-profile";
import { useDeviceProfile } from "@/hooks/useDeviceProfile";
import { useDeviceTuning } from "@/hooks/useDeviceTuning";
import { resolveDsaView } from "@/lib/eeg/device-tuning";
import { DeviceOptimisationPanel } from "@/components/monitor/DeviceOptimisationPanel";
import { TciPanel } from "@/components/monitor/TciPanel";
import { CaseActionBar, type CaseSheet } from "@/components/monitor/CaseActionBar";
import { QuickMarkBar } from "@/components/monitor/QuickMarkBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TciStatusStrip } from "@/components/monitor/TciStatusStrip";
import { CHECKLIST_ITEMS, type ChecklistKey } from "@/components/monitor/PreCaseChecklist";
import { loadCaseStartup, nextCaseCode, saveCaseStartup } from "@/lib/eeg/case-startup";
import type { CaseControls } from "@/components/monitor/case-controls";
import { summariseInfusions, type TciInfusion } from "@/lib/eeg/tci";
import { summariseBis, type BisReading } from "@/lib/eeg/bis";
import { BisPanel } from "@/components/monitor/BisPanel";
import { BisAgreementPanel } from "@/components/monitor/BisAgreementPanel";
import { useCaseSession } from "@/components/monitor/CaseSessionProvider";
import { CaseStatusWidget } from "@/components/monitor/CaseStatusWidget";
import { BatteryIndicator } from "@/components/monitor/BatteryIndicator";
import { LowBatteryBanner } from "@/components/monitor/LowBatteryBanner";
import { ConnectionStatusBadge } from "@/components/monitor/ConnectionStatusBadge";
import { deriveConnectionStatus } from "@/lib/eeg/connection-status";
import { useBatteryAlert } from "@/lib/eeg/battery-alert";
import { useBatteryHealth } from "@/lib/eeg/battery-health";
import { MONITOR_JUMP, focusMonitorSection, type MonitorJumpTarget } from "@/lib/monitor-jump";
import { ChannelCompletenessPanel } from "@/components/monitor/ChannelCompletenessPanel";
import { AcquisitionLineagePanel } from "@/components/monitor/AcquisitionLineagePanel";
import { SeizureThresholdPanel } from "@/components/monitor/SeizureThresholdPanel";
import { ChannelStateTimeline } from "@/components/monitor/ChannelStateTimeline";
import { StreamIntegrityPanel } from "@/components/monitor/StreamIntegrityPanel";
import { BleDiagnosticsPanel } from "@/components/monitor/BleDiagnosticsPanel";
import { BleIdentifyPanel } from "@/components/monitor/BleIdentifyPanel";
import { LiveSpectrumPanel } from "@/components/monitor/LiveSpectrumPanel";

import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/")({
  head: () => ({
    meta: [
      { title: "CortexTrace — Muse 2 depth-of-anaesthesia EEG monitor" },
      {
        name: "description",
        content:
          "Stream Muse 2 EEG at the bedside: live density spectral array, burst-suppression ratio and time, and rhythmic seizure-activity detection for theatre and ICU.",
      },
      { property: "og:title", content: "CortexTrace — Muse 2 depth-of-anaesthesia EEG monitor" },
      {
        property: "og:description",
        content:
          "Density spectral array, suppression ratio and seizure detection from a Muse 2 headband, with anonymised session records.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Monitor,
});

function Monitor() {
  // The whole case lives above the router outlet, so streaming, alarms and
  // everything recorded survive navigating to Cases, Trends or Settings.
  const session = useCaseSession();
  // The montage actually being streamed drives every channel picker below.
  const deviceProfile = useDeviceProfile();
  // What the app switches on or holds back for the headset now streaming.
  const tuning = useDeviceTuning();
  const {
    monitor,
    user,
    windowMinutes,
    setWindowMinutes,
    mode,
    selectMode,
    saveOpen,
    setSaveOpen,
    caseOpen,
    setCaseOpen,
    bleSupported,
    endOpen,
    setEndOpen,
    discardOpen,
    setDiscardOpen,
    caseState,
    testing,
    startIntent,
    requestTestSession,
    endTesting,
    tab,
    setTab,
    fullscreen,
    setFullscreen,
    caseSheet,
    setCaseSheet,
    checklist,
    setChecklist,
    dim,
    setDim,
    saving,
    saved,
    hasUnfiledData,
    markers,
    setMarkers,
    infusions,
    setInfusions,
    bisReadings,
    setBisReadings,
    markerText,
    setMarkerText,
    meta,
    setMeta,
    dsaView: requestedDsaView,
    setDsaView,
    summary,
    streaming,
    reconnecting,
    caseRunning,
    icuMode,
    activeMode,
    derived,
    latest,
    allEvents,
    uncertainty,
    srTone,
    seizureAlert,
    sessionStartedAtMs,
    usedCaseCodes,
    dsaMarkerRail,
    ai,
    audit,
    alarms,
    markerAlerts,
    sqiAlerts,
    depthWindow,
    seizureRisk,
    applySettings,
    startCase,
    endCase,
    discardCase,
    requestNewCase,
    addMarker,
    addMarkerAt,
    caseControls,
    handleSave,
  } = session;

  const batteryHealth = useBatteryHealth(monitor.batteryPercent);
  // Live COEBIS fit driving the tiered comparison against the commercial monitor.
  const coebisModel = useCoebisModel();
  // Covariates of the case on screen: drive the patient-adjusted depth target
  // and the COEBIS derivation breakdown.
  const depthTargetInputs = useMemo(() => {
    const age = Number(meta.ageYears);
    const years = Number.isFinite(age) ? age : null;
    return {
      ageYears: years,
      ageBand: ageBand(years),
      sex: meta.sex || null,
      regimen: meta.regimen || null,
      frailty: meta.frailty || null,
      context: meta.context,
      chronicConditions: meta.chronicConditions,
      acutePathology: meta.acutePathology,
    };
  }, [
    meta.ageYears,
    meta.sex,
    meta.regimen,
    meta.frailty,
    meta.context,
    meta.chronicConditions,
    meta.acutePathology,
  ]);
  // Alarm on the last plausible charge so a mis-parsed reply cannot fire a
  // spurious flat-battery alert mid-case.
  const batteryAlert = useBatteryAlert(batteryHealth.display, streaming || reconnecting);
  const connection = deriveConnectionStatus({
    status: monitor.status,
    sourceName: monitor.sourceName,
    caseEnded: caseState === "ended",
    dataGapSeconds: monitor.dataGapSeconds,
    reconnectAttempt: monitor.reconnectAttempt,
  });

  // A stored bilateral preference cannot be honoured on a one-channel band.
  const dsaView = resolveDsaView(tuning, requestedDsaView);

  const jumpTo = (target: MonitorJumpTarget) => {
    const { tab: targetTab, id } = MONITOR_JUMP[target];
    setTab(targetTab);
    focusMonitorSection(id);
  };

  return (
    <div className="min-h-dvh bg-background">
      {fullscreen ? (
        <FullscreenMonitor
          epochs={monitor.epochs}
          hemiSpectra={monitor.hemiSpectra}
          hemiLatest={monitor.hemiLatest}
          hemiEvents={monitor.hemiEvents}
          latest={latest}
          waveformStore={monitor.waveformStore}
          elapsed={monitor.elapsed}
          sourceName={monitor.sourceName}
          streaming={streaming}
          modeLabel={activeMode.label}
          windowMinutes={windowMinutes}
          markers={markers}
          dsaView={dsaView}
          onDsaViewChange={setDsaView}
          suppressionSeconds={summary.suppressionSeconds}
          suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
          startedAtMs={sessionStartedAtMs}
          controls={caseState !== "idle" ? caseControls : undefined}
          onExit={() => setFullscreen(false)}
        />
      ) : null}
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-4 sm:py-3 short:gap-y-1 short:py-1.5!">
          <div className="flex min-w-0 items-center gap-2">
            <Activity className="size-5 shrink-0 text-signal" />
            <span className="truncate text-sm font-semibold tracking-[0.18em] uppercase">
              CortexTrace
            </span>
          </div>
          <ConnectionStatusBadge status={connection} />
          {tuning.showBattery ? (
          <BatteryIndicator
            percent={batteryHealth.display}
            connected={streaming || reconnecting}
            health={batteryHealth}
          />
          ) : null}
          {caseState !== "idle" ? (
            <span className="metric-value text-sm text-muted-foreground">
              {formatClock(monitor.elapsed)}
            </span>
          ) : null}
          {meta.caseCode && caseState !== "idle" && !testing ? (
            <span className="metric-value hidden truncate rounded bg-muted px-2 py-0.5 text-xs sm:inline">
              {meta.caseCode}
            </span>
          ) : null}
          {testing ? (
            <span className="rounded-full bg-caution/15 px-2 py-0.5 text-xs font-medium text-caution">
              Testing — not saved
            </span>
          ) : null}

          <div
            role="group"
            aria-label="Monitoring mode"
            className="flex w-full items-center gap-1 rounded-full border border-border p-0.5 sm:w-auto"
          >
            {MODES.map((m) => {
              const Icon = m.icon;
              const active = m.key === mode;
              return (
                <button
                  key={m.key}
                  type="button"
                  aria-pressed={active}
                  title={m.blurb}
                  onClick={() => selectMode(m.key)}
                  className={cn(
                    "flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors sm:min-h-8 sm:flex-none sm:py-1",
                    active
                      ? "bg-signal/15 text-signal"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" /> {m.label}
                </button>
              );
            })}
          </div>

          <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto sm:justify-end">
            {caseRunning ? (
              <>
                <Button
                  variant="destructive"
                  size="sm"
                  className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                  onClick={() => (testing ? endTesting() : setEndOpen(true))}
                >
                  <CircleStop className="size-4" /> {testing ? "End test" : "End case"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="hidden flex-1 sm:inline-flex sm:flex-none"
                  onClick={() => setFullscreen(true)}
                >
                  <Maximize2 className="size-4" /> Monitor view
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-9" aria-label="More case actions">
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="sm:hidden" onSelect={() => setFullscreen(true)}>
                      <Maximize2 className="size-4" /> Monitor view
                    </DropdownMenuItem>
                    {testing ? null : (
                      <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
                        <Save className="size-4" /> File now
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => setDim(!dim)}>
                      {dim ? <Sun className="size-4" /> : <Moon className="size-4" />}
                      {dim ? "Undim display" : "Dim for theatre"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
            <>
              {caseState === "ended" ? (
                <Button
                  size="sm"
                  className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                  onClick={() => requestNewCase()}
                >
                  <Plus className="size-4" /> New case
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                    // Goes through requestNewCase so the intent resets to a
                    // filed case even if the test dialog was opened and closed
                    // beforehand.
                    onClick={() => requestNewCase()}
                  >
                    <Bluetooth className="size-4" /> Start case
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                    onClick={() => requestTestSession()}
                  >
                    <FlaskConical className="size-4" /> Testing mode
                  </Button>
                </>
              )}
              {caseState === "ended" && monitor.epochs.length ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="min-h-11 flex-1 sm:min-h-9 sm:flex-none"
                    onClick={() => setSaveOpen(true)}
                  >
                    <Save className="size-4" /> File case
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hidden flex-1 text-critical hover:text-critical sm:inline-flex sm:flex-none"
                    onClick={() => setDiscardOpen(true)}
                  >
                    <Trash2 className="size-4" /> Exit without saving
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-11 sm:hidden"
                        aria-label="More case actions"
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        className="text-critical"
                        onSelect={() => setDiscardOpen(true)}
                      >
                        <Trash2 className="size-4" /> Exit without saving
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : null}
            </>
            )}
            {user ? (
              <AppNav showBrand={false} compact />
            ) : (
              <Button asChild variant="ghost" size="sm" className="min-h-11 sm:min-h-9">
                <Link to="/auth">Sign in</Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-4 px-3 py-4 pb-[calc(5rem+env(safe-area-inset-bottom))] sm:px-4 sm:pb-8">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground short:hidden">
          <span className="metric-value rounded-full bg-signal/10 px-2 py-0.5 text-xs text-signal">
            {activeMode.label} mode
          </span>
          <span>{activeMode.blurb}</span>
        </div>
        {batteryAlert.visible ? (
          <LowBatteryBanner
            percent={batteryAlert.percent}
            threshold={batteryAlert.threshold}
            critical={batteryAlert.critical}
            notify={batteryAlert.notify}
            permission={batteryAlert.permission}
            onThresholdChange={batteryAlert.setThreshold}
            onNotifyChange={(v) => void batteryAlert.setNotify(v)}
            onDismiss={batteryAlert.dismiss}
          />
        ) : null}
        {testing ? (
          <div className="panel flex flex-wrap items-center gap-3 border-caution/60 bg-caution/10 px-4 py-2 text-xs text-caution">
            <FlaskConical className="size-4" aria-hidden />
            <span className="min-w-0 flex-1">
              Testing mode — live data only. Nothing is recorded to your records and everything is
              lost when the app is closed or refreshed.
            </span>
          </div>
        ) : null}
        {caseState !== "idle" ? (
          <TciStatusStrip infusions={infusions} onOpen={() => setCaseSheet("tci")} />
        ) : null}
        {monitor.error ? (
          <div className="panel flex flex-wrap items-center gap-3 border-critical/60 px-4 py-3 text-sm text-critical">
            <span className="min-w-0 flex-1">{monitor.error}</span>
            {caseState === "running" ? (
              <Button size="sm" variant="secondary" onClick={() => void monitor.reconnect()}>
                Reconnect headband
              </Button>
            ) : null}
          </div>
        ) : null}

        {caseState !== "idle" ? (
          <AlarmBanner
            alarms={alarms.alarms}
            audioEnabled={alarms.audioEnabled}
            muted={alarms.muted}
            muteRemaining={alarms.muteRemaining}
            onAcknowledge={(id) => {
              alarms.acknowledge(id);
              audit(`Alarm acknowledged (${id})`);
            }}
            onAcknowledgeAll={() => {
              alarms.acknowledgeAll();
              audit("All alarms acknowledged");
            }}
            onAcknowledgeSide={(side) => {
              alarms.acknowledgeSide(side);
              audit(`${SIDE_LABEL[side]} alarms acknowledged`);
            }}
            onPauseAudio={() => {
              alarms.pauseAudio();
              audit("Alarm audio paused for 2 minutes");
            }}
            onResumeAudio={alarms.resumeAudio}
            onToggleAudio={() => {
              alarms.setAudioEnabled(!alarms.audioEnabled);
              audit(`Alarm audio turned ${alarms.audioEnabled ? "off" : "on"}`);
            }}
          />
        ) : null}

        <div
          role="tablist"
          aria-label="Monitor sections"
          className="flex w-full gap-1 rounded-lg border border-border p-1"
        >
          {(
            [
              { key: "monitor", label: "Monitor" },
              { key: "signal", label: "Signal & settings" },
              { key: "review", label: "Review" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                tab === t.key
                  ? "bg-signal/15 text-signal"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "monitor" ? (
          <>
            <div id="mon-status" className="scroll-mt-24 rounded-lg transition-shadow">
            <CaseStatusWidget
              onJump={jumpTo}
              onRecordNote={(text) => addMarkerAt(text, monitor.elapsed)}
              caseState={caseState}
              elapsedSeconds={monitor.elapsed}
              epochs={monitor.epochs}
              caseCode={meta.caseCode}
              sourceName={monitor.sourceName}
              streaming={streaming}
              reconnecting={reconnecting}
              analysisSource={monitor.analysisSource?.side ?? null}
              connectionError={monitor.error}
              reconnectAttempt={monitor.reconnectAttempt?.attempt ?? 0}
              dataGapSeconds={monitor.dataGapSeconds}
              channelCompleteness={monitor.channelCompleteness}
              channelStateHistory={monitor.channelStateHistory}
            />
            </div>

            {/* Density spectral array */}
            <section id="mon-dsa" className="panel overflow-hidden scroll-mt-24 transition-shadow">
              <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:px-4">
                <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                  <h1 className="text-sm font-semibold">Density spectral array · bilateral</h1>
                  <DsaLegend />
                </div>
                <div className="grid w-full grid-cols-2 items-center gap-2 sm:ml-auto sm:flex sm:w-auto">
                  <Select
                    value={monitor.channel}
                    onValueChange={(v) => monitor.setChannel(v as typeof monitor.channel)}
                  >
                    <SelectTrigger className="min-h-11 w-full min-w-0 sm:min-h-9 sm:w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="average">All channels (mean)</SelectItem>
                      {deviceProfile.channels.map((c) => (
                        <SelectItem key={c} value={c}>
                          {channelLabel(deviceProfile, c)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(windowMinutes)}
                    onValueChange={(v) => setWindowMinutes(Number(v))}
                  >
                    <SelectTrigger className="min-h-11 w-full min-w-0 sm:min-h-9 sm:w-[110px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 min</SelectItem>
                      <SelectItem value="10">10 min</SelectItem>
                      <SelectItem value="30">30 min</SelectItem>
                      <SelectItem value="60">60 min</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="col-span-2 flex shrink-0">
                    <DsaViewToggle
                      value={dsaView}
                      onChange={setDsaView}
                      available={tuning.dsaViews}
                      full
                    />
                  </div>
                  <button
                    type="button"
                    aria-pressed={markerAlerts.soundEnabled}
                    aria-label={
                      markerAlerts.soundEnabled
                        ? "Mute marker alert sound"
                        : "Unmute marker alert sound"
                    }
                    title={
                      markerAlerts.soundEnabled ? "Marker alert sound on" : "Marker alert sound off"
                    }
                    onClick={() => markerAlerts.setSoundEnabled(!markerAlerts.soundEnabled)}
                    className={cn(
                      "flex min-h-11 min-w-11 shrink-0 items-center justify-center justify-self-start rounded-md border border-border sm:min-h-9 sm:min-w-9",
                      markerAlerts.soundEnabled
                        ? "text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {markerAlerts.soundEnabled ? (
                      <Volume2 className="h-4 w-4" />
                    ) : (
                      <VolumeX className="h-4 w-4" />
                    )}
                  </button>
                  <Popover>
                    <PopoverTrigger asChild>
                      <button
                        type="button"
                        aria-label="Signal quality alert threshold"
                        title={`Alert below SQI ${sqiAlerts.threshold} %`}
                        className="flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 justify-self-end rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground sm:justify-self-auto"
                      >
                        <SignalLow className="h-4 w-4" />
                        <span className="metric-value">{sqiAlerts.threshold} %</span>
                      </button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-72">
                      <p className="text-sm font-semibold">Signal quality alert</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Raises a visual alert when SQI falls below this level —{" "}
                        {dsaView === "bilateral"
                          ? "per hemisphere in Bilateral view"
                          : "on the merged lane in this view"}
                        . Saved on this device.
                      </p>
                      <div className="mt-3 flex items-baseline justify-between gap-2">
                        <label className="text-xs font-medium">Alert below</label>
                        <span className="metric-value text-xs text-muted-foreground">
                          {sqiAlerts.threshold} %
                        </span>
                      </div>
                      <Slider
                        className="mt-2"
                        min={5}
                        max={90}
                        step={5}
                        value={[sqiAlerts.threshold]}
                        onValueChange={([v]) => sqiAlerts.setThreshold(v ?? sqiAlerts.threshold)}
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              <div
                className={cn(
                  "relative bg-[rgb(8,16,34)] sm:h-[420px] md:h-[500px] short:h-[240px]!",
                  dsaView === "bilateral" ? "h-[380px]" : "h-[260px]",
                )}
              >
                <MonitorErrorBoundary label="Density spectral array">
                  <HemiDsaPanel
                    hemiSpectra={monitor.hemiSpectra}
                    hemiLatest={monitor.hemiLatest}
                    hemiEvents={monitor.hemiEvents}
                    dsaView={dsaView}
                    windowSeconds={windowMinutes * 60}
                    elapsed={monitor.elapsed}
                    infusions={infusions}
                  />
                </MonitorErrorBoundary>
                {/* Trend alerts (depth swings, BSR burden) and clinician markers */}
                <DsaMarkerRail
                  markers={dsaMarkerRail}
                  elapsed={monitor.elapsed}
                  windowSeconds={windowMinutes * 60}
                />
                {!monitor.epochs.length ? (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
                    <p className="max-w-xs rounded-lg border border-border bg-background/90 px-4 py-3 text-center text-sm text-muted-foreground backdrop-blur-sm">
                      Connect a Muse 2 headband to start building the spectrogram — or run the demo
                      signal to see anaesthesia, burst suppression and ictal patterns.
                    </p>
                  </div>
                ) : null}
              </div>
              {/* Suppression / seizure ribbon */}
              <div className="flex h-6 w-full">
                {(() => {
                  const visible = monitor.epochs.slice(-windowMinutes * 60);
                  const pad = windowMinutes * 60 - visible.length;
                  return (
                    <>
                      <div style={{ flexGrow: Math.max(0, pad) }} className="bg-muted/30" />
                      {visible.map((e, i) => (
                        <div
                          key={i}
                          style={{ flexGrow: 1 }}
                          title={`${formatClock(e.t)} · SR ${e.suppressionRatio.toFixed(0)}%`}
                          className={cn(
                            "h-full",
                            e.seizureAlert
                              ? "bg-critical"
                              : e.isSuppressed
                                ? "bg-caution"
                                : e.artifact
                                  ? "bg-muted"
                                  : "bg-signal/50",
                          )}
                        />
                      ))}
                    </>
                  );
                })()}
              </div>

              {/* Contemporaneous event marking */}
              <div className="border-t border-border px-3 py-3 sm:px-4">
                <p className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:hidden">
                  Mark event
                </p>
                <div className="flex items-center gap-2">
                  <span className="hidden shrink-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:inline">
                    Mark event
                  </span>
                  <QuickMarkBar
                    mode={mode}
                    elapsed={monitor.elapsed}
                    running={caseRunning}
                    onMark={addMarker}
                    onMore={() => setCaseSheet("mark")}
                    size="compact"
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Input
                    value={markerText}
                    disabled={!caseRunning}
                    placeholder="Custom marker — e.g. “ketamine 30 mg”, “facial twitching noted”"
                    className="h-9 w-full sm:w-auto sm:max-w-sm sm:flex-1"
                    onChange={(e) => setMarkerText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        addMarker(markerText);
                        setMarkerText("");
                      }
                    }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    className="min-h-11 sm:min-h-9"
                    disabled={!caseRunning || !markerText.trim()}
                    onClick={() => {
                      addMarker(markerText);
                      setMarkerText("");
                    }}
                  >
                    Mark now
                  </Button>
                  {markers.length ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setMarkers((prev) => prev.slice(0, -1))}
                      >
                        <Undo2 className="size-4" /> Undo last
                      </Button>
                      <span className="metric-value text-xs text-muted-foreground">
                        {markers.length} marker{markers.length === 1 ? "" : "s"} this session
                      </span>
                    </>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Markers are timestamped against the running clock and saved with the session.
                    </span>
                  )}
                </div>
                {markers.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {[...markers]
                      .reverse()
                      .slice(0, 8)
                      .map((m, i) => (
                        <span
                          key={`${m.t}-${i}`}
                          className="flex items-center gap-1.5 rounded-full bg-marker/15 px-2 py-1 text-xs text-marker"
                        >
                          <span className="metric-value text-xs opacity-80">
                            {formatClock(m.t)}
                          </span>
                          {m.detail}
                          <button
                            type="button"
                            aria-label={`Remove marker ${m.detail}`}
                            onClick={() => setMarkers((prev) => prev.filter((x) => x !== m))}
                            className="opacity-70 hover:opacity-100"
                          >
                            <X className="size-3" />
                          </button>
                        </span>
                      ))}
                  </div>
                ) : null}
              </div>

              {/* Contemporaneous TCI pump entry (model + effect-site targets) */}
              <BisPanel
                readings={bisReadings}
                onChange={setBisReadings}
                running={caseRunning}
                elapsed={monitor.elapsed}
                depthIndex={derived.live.depthIndex}
                suppressionRatio={derived.live.suppressionRatio}
                sef95={derived.live.sef95}
                trend={monitor.epochs.map((e) => ({ t: e.t, index: e.depth?.index ?? null }))}
                coebisSeries={monitor.epochs.map((e) => e.depth?.coebis ?? null)}
                onMark={addMarker}
              />
              {/* Tiered patient-adjusted COEBIS beside the monitor's own number. */}
              <CoebisVsBisPanel
                epochs={monitor.epochs}
                readings={bisReadings}
                openIbis={latest?.depth.index ?? null}
                model={coebisModel}
                covariates={depthTargetInputs}
                entropy={latest?.depth.entropy ?? null}
                adjunct={latest?.depth.adjunct ?? null}
              />
              {/* The rebuilt engine, read on the band actually streaming. */}
              <CoebisV2LivePanel
                reading={monitor.coebisV2}
                setup={monitor.coebisV2Setup}
                profile={monitor.deviceProfile}
              />
              <TciPanel
                infusions={infusions}
                onChange={setInfusions}
                running={caseRunning}
                elapsed={monitor.elapsed}
                onMark={addMarker}
              />
            </section>

            {/* The headband's own shape, beside the number derived from it. */}
            <HeadbandTracePanel
              archive={monitor.rawArchive}
              profile={deviceProfile}
              streaming={streaming}
              contactOk={monitor.contactOk}
            />


            {/* Real-time seizure alert cards, newest first */}
            {caseState !== "idle" ? (
              <SeizureAlertCards
                events={allEvents}
                hemiEvents={monitor.hemiEvents}
                elapsed={monitor.elapsed}
                startedAtMs={sessionStartedAtMs}
              />
            ) : null}

            {/* Metrics */}
            <div id="mon-metrics" className="scroll-mt-24 rounded-lg transition-shadow">
            {/* Names the missing inputs when no COEBIS correction is in force. */}
            <CoebisUnavailableBanner className="mb-2" />
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Metrics</p>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                {/* Full derivation of the COEBIS number on screen. */}
                <CoebisExplainPanel
                  openIbis={latest?.depth.index ?? null}
                  covariates={depthTargetInputs}
                  adjunct={latest?.depth.adjunct ?? null}
                  ketamine={latest?.depth.ketamine ?? null}
                  drugs={latest?.depth.drugs ?? null}
                />
                {/* Which COEBIS fit the tiles are showing, and a way back to older fits. */}
                <CoebisModelPicker />
              </div>
            </div>
            <MetricsGrid
              uncertainty={uncertainty}
              latest={latest}
              summary={summary}
              srWindowSeconds={monitor.settings.srWindowSeconds}
              srTone={srTone}
              seizureAlert={seizureAlert}
              icuMode={icuMode}
              depthWindow={depthWindow}
            />

            </div>

            {caseState !== "idle" ? (
              <CoebisTrend
                epochs={monitor.epochs}
                elapsed={monitor.elapsed}
                windowMinutes={windowMinutes}
                startedAtMs={sessionStartedAtMs}
              />
            ) : null}

            <AssessmentConfidencePanel report={uncertainty} />

            <DepthWindowPanel
              depthWindow={depthWindow}
              depthIndex={latest?.depth.index}
              targetInputs={depthTargetInputs}
            />

            {caseState !== "idle" ? (
              <SeizureRiskPanel
                prefs={seizureRisk.prefs}
                setPrefs={seizureRisk.setPrefs}
                trend={seizureRisk.trend}
                alerts={seizureRisk.alerts}
                dismiss={seizureRisk.dismiss}
              />
            ) : null}

            {/* What the seizure alarm is worth at the thresholds now in force. */}
            <SeizureValidationPanel settings={monitor.settings} className="mt-3" />

            {/* Event rail — the last few entries stay visible beside the trace. */}
            {caseState !== "idle" ? (
              <div id="mon-events" className="panel scroll-mt-24 px-3 py-2.5 transition-shadow sm:px-4">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Recent events
                  </h2>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => setCaseSheet("log")}
                  >
                    Open full log
                  </Button>
                </div>
                {allEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground">Nothing recorded yet.</p>
                ) : (
                  <ul className="space-y-1">
                    {allEvents.slice(-5).map((e, i) => (
                      <li
                        key={`${e.t}-${i}`}
                        className="flex items-baseline gap-2 text-xs text-foreground"
                      >
                        <span className="metric-value shrink-0 text-muted-foreground">
                          {formatClock(e.t)}
                        </span>
                        <span className="truncate">{e.detail}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : null}
          </>
        ) : null}

        {tab === "signal" ? (
          <div className="space-y-4">
            <div id="mon-signal-quality" className="scroll-mt-24 rounded-lg transition-shadow">
            <SignalQualityPanel
              quality={latest?.quality ?? null}
              channels={deviceProfile.channels}
              channelQuality={monitor.channelQuality}
              usableFraction={summary.usableFraction}
              depthArtifact={latest?.depthArtifact ?? null}
              depthGatedFraction={latest?.depth.gatedFraction}
              analysisSource={monitor.analysisSource}
            />
            </div>
            <LiveSpectrumPanel latest={latest} epochs={monitor.epochs} />
            <DeviceOptimisationPanel profile={deviceProfile} tuning={tuning} />

            <div id="mon-lineage" className="scroll-mt-24 rounded-lg transition-shadow">
              <AcquisitionLineagePanel profile={deviceProfile} />
            </div>
            <SeizureThresholdPanel
              configured={monitor.settings}
              applied={monitor.effectiveSettings}
              gate={monitor.seizureGate}
              guard={monitor.seizureGuard}
              profile={deviceProfile}
            />
            <StreamIntegrityPanel
              integrity={monitor.integrity}
              clock={monitor.suppressionClock}
            />
            <BleIdentifyPanel />
            <BleDiagnosticsPanel
              epochs={monitor.epochs}
              deviceLabel={deviceProfile.label}
              sampleRate={deviceProfile.sampleRate}
            />
            <div id="mon-channels" className="scroll-mt-24 rounded-lg transition-shadow">
              <ChannelCompletenessPanel rows={monitor.channelCompleteness} />
            </div>
            <ChannelStateTimeline history={monitor.channelStateHistory} />
            <SqiTrend
              history={monitor.sqiHistory}
              bilateral={dsaView !== "combined"}
              threshold={sqiAlerts.threshold}
            />
          </div>
        ) : null}

        {tab === "review" ? (
          <AiInsightPanel
            result={ai.result}
            loading={ai.loading}
            error={ai.error}
            epochCount={monitor.epochs.length}
            onRun={() => void ai.analyse(false)}
            watch={ai.watch}
            onWatchChange={ai.setWatchEnabled}
            lastRunAt={ai.lastRunAt}
            feedbackContext={mode}
          />
        ) : null}

        {tab === "review" ? (
          <div className="space-y-4">
            <BisAgreementPanel
              digest={ai.bisDigest}
              report={ai.bisReport}
              loading={ai.bisLoading}
              error={ai.bisError}
              onRun={() => void ai.analyseBis()}
            />

            <TciResponsePanel
              digest={ai.tciDigest}
              report={ai.tciReport}
              loading={ai.tciLoading}
              error={ai.tciError}
              onRun={() => void ai.analyseTci()}
            />
          </div>
        ) : null}

        {tab !== "monitor" ? (
          <section className={cn("grid gap-4", tab === "signal" && "lg:grid-cols-[2fr_1fr]")}>
            {tab === "signal" ? (
              <div className="space-y-4">
                <div className="panel overflow-hidden">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2.5 sm:px-4">
                    <h2 className="text-sm font-semibold">Filtered EEG · last 4 s</h2>
                    <span className="metric-value text-xs text-muted-foreground">
                      0.5–45 Hz, 50 Hz notch · ±80 µV
                    </span>
                    <div className="flex gap-1.5 sm:ml-auto">
                      {deviceProfile.channels.map((c) => (
                        <span
                          key={c}
                          className={cn(
                            "metric-value rounded px-1.5 py-0.5 text-xs",
                            monitor.contactOk[c]
                              ? "bg-signal/15 text-signal"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {c}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="h-[150px] px-2">
                    <LiveWaveform
                      store={monitor.waveformStore}
                      suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
                      suppressed={latest?.isSuppressed ?? false}
                    />
                  </div>
                </div>

                {/* Per-electrode raw EEG — live and scrubbable in review */}
                <div id="mon-raw" className="scroll-mt-24 rounded-lg transition-shadow">
                <RawChannelViewer
                  archive={monitor.rawArchive}
                  streaming={streaming}
                  contactOk={monitor.contactOk}
                  channelQuality={monitor.channelQuality}
                  epochs={monitor.epochs}
                  events={derived.allEvents}
                  markers={markers}
                  onAnnotateChannel={(channel, t, text) =>
                    addMarkerAt(`${channel} · ${text}`, t)
                  }
                />

                </div>

                <div id="mon-thresholds" className="scroll-mt-24 rounded-lg transition-shadow">
                <DetectionThresholds
                  settings={monitor.settings}
                  suppression={{
                    ratio: latest ? latest.suppressionRatio : null,
                    maxRatio: summary.maxSr,
                    seconds: summary.suppressionSeconds,
                  }}
                  onApply={applySettings}
                />
                </div>
              </div>
            ) : null}

            <div id="mon-event-log" className="panel scroll-mt-24 overflow-hidden transition-shadow">
              <div className="border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">Event log</h2>
              </div>
              <div className="max-h-[430px] overflow-y-auto">
                <EventLog events={allEvents} />
              </div>
            </div>
          </section>
        ) : null}

        <p className="pb-6 text-xs text-muted-foreground">
          Research and education tool. The Muse 2 is a consumer device and CortexTrace is not a
          certified medical device — never use these numbers as the sole basis for a clinical
          decision.
        </p>
        {caseState !== "idle" ? <div className="h-16" /> : null}
      </main>

      {caseState !== "idle" ? (
        <CaseActionBar controls={caseControls} open={caseSheet} onOpenChange={setCaseSheet} />
      ) : null}

      <CaseDialogs
        meta={meta}
        onMetaChange={setMeta}
        usedCaseCodes={usedCaseCodes}
        signedIn={Boolean(user)}
        epochCount={monitor.epochs.length}
        eventCount={allEvents.length}
        markerCount={markers.length}
        elapsed={monitor.elapsed}
        meanSr={summary.meanSr}
        bleSupported={bleSupported}
        checklist={checklist}
        onToggleChecklist={(key) => setChecklist((prev) => ({ ...prev, [key]: !prev[key] }))}
        saveOpen={saveOpen}
        onSaveOpenChange={setSaveOpen}
        saving={saving}
        onSave={() => void handleSave()}
        testing={startIntent === "test"}
        caseOpen={caseOpen}
        onCaseOpenChange={setCaseOpen}
        onStart={(kind, options) => startCase(kind, options)}
        endOpen={endOpen}
        onEndOpenChange={setEndOpen}
        onEnd={(fileNow) => endCase(fileNow)}
        discardOpen={discardOpen}
        onDiscardOpenChange={setDiscardOpen}
        onDiscard={discardCase}
      />

      {dim ? (
        <button
          type="button"
          aria-label="Undim display"
          onClick={() => setDim(false)}
          className="fixed inset-0 z-[60] cursor-pointer bg-black/60"
        />
      ) : null}
    </div>
  );
}

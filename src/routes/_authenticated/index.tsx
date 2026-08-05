import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bluetooth,
  CircleStop,
  FlaskConical,
  HeartPulse,
  Info,
  Maximize2,
  Moon,
  MoreVertical,
  SignalLow,
  Sun,
  Stethoscope,
  Save,
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
import { CaseFields } from "@/components/monitor/CaseFields";
import { useDsaViewPreference } from "@/lib/eeg/dsa-view-pref";
import { FullscreenMonitor } from "@/components/monitor/FullscreenMonitor";
import { EventLog } from "@/components/monitor/EventLog";
import { AiInsightPanel } from "@/components/monitor/AiInsightPanel";
import { TciResponsePanel } from "@/components/monitor/TciResponsePanel";
import { buildTciResponseDigest } from "@/lib/eeg/tci-response";
import {
  interpretTciResponse,
  type TciResponseReport,
} from "@/lib/eeg/tci-response.functions";
import { buildFeatureDigest } from "@/lib/eeg/features";
import { interpretSession, type Interpretation } from "@/lib/eeg/interpret.functions";
import { MetricsGrid } from "@/components/monitor/MetricsGrid";
import { DepthWindowPanel } from "@/components/monitor/DepthWindowPanel";
import type { MetricTone } from "@/components/monitor/MetricCard";
import { SignalQualityPanel } from "@/components/monitor/SignalQualityPanel";
import { SqiTrend } from "@/components/monitor/SqiTrend";
import { WaveformStrip } from "@/components/monitor/WaveformStrip";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  useDepthWindowAlerts,
  type DepthWindowTransition,
} from "@/hooks/useDepthWindowAlerts";
import { useEegMonitor } from "@/hooks/useEegMonitor";
import { HemiDsaPanel } from "@/components/monitor/HemiDsaPanel";
import { DsaMarkerRail, type DsaMarker } from "@/components/monitor/DsaMarkerRail";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { DETECTION_PRESETS, matchPreset } from "@/lib/eeg/analysis";
import { SIDE_LABEL, type AlarmSide } from "@/lib/eeg/alarms";
import { EMPTY_CASE_META, type CaseMeta } from "@/lib/eeg/case-meta";
import { COMPOSITE_BAND_LABEL, NOCICEPTION_BAND_LABEL } from "@/lib/eeg/composite";
import { DEPTH_STATE_LABEL, depthTone, setActiveDepthCalibration } from "@/lib/eeg/depth";
import { loadStoredCalibration } from "@/lib/eeg/calibration";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { MUSE_CHANNELS, isWebBluetoothAvailable } from "@/lib/eeg/muse";
import { MuseCapabilityPanel } from "@/components/monitor/MuseCapabilityPanel";
import { TciPanel } from "@/components/monitor/TciPanel";
import { CaseActionBar, type CaseSheet } from "@/components/monitor/CaseActionBar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TciStatusStrip } from "@/components/monitor/TciStatusStrip";
import {
  CHECKLIST_ITEMS,
  PreCaseChecklist,
  type ChecklistKey,
} from "@/components/monitor/PreCaseChecklist";
import { loadCaseStartup, nextCaseCode, saveCaseStartup } from "@/lib/eeg/case-startup";
import type { CaseControls } from "@/components/monitor/case-controls";
import { summariseInfusions, type TciInfusion } from "@/lib/eeg/tci";
import { saveSession } from "@/lib/eeg/save";
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

const MARKER_PRESETS = [
  "Induction",
  "Propofol bolus",
  "Ketamine bolus",
  "Rocuronium bolus",
  "Opioid bolus",
  "Vasopressor bolus",
  "Laryngoscopy",
  "Surgical incision",
  "Facial twitching noted",
  "Movement / artefact",
  "Sedation hold",
  "Emergence",
];

type MonitorMode = "anaesthesia" | "icu";

const MODES: {
  key: MonitorMode;
  label: string;
  icon: typeof Stethoscope;
  blurb: string;
  presetKey: string;
  context: string;
}[] = [
  {
    key: "anaesthesia",
    label: "Anaesthesia",
    icon: Stethoscope,
    blurb:
      "Continuous DSA with spectral edge, suppression ratio and suppression time up front. Seizure detection runs conservatively in the background.",
    presetKey: "anaesthesia",
    context: "general_anaesthesia",
  },
  {
    key: "icu",
    label: "ICU",
    icon: HeartPulse,
    blurb:
      "Seizure- and burst-suppression-led: sensitive ictal alerting, longer suppression window, seizure score and suppression burden shown first.",
    presetKey: "icu",
    context: "icu_sedation",
  },
];

function Monitor() {
  const monitor = useEegMonitor();
  const { user } = useAuth();

  // Apply the locally saved depth calibration (if any) to the live estimator.
  useEffect(() => {
    setActiveDepthCalibration(loadStoredCalibration());
  }, []);

  // Start-up speed: reuse the last context and location, and suggest the next
  // sequential anonymised case code so a case starts in two taps.
  useEffect(() => {
    const prefs = loadCaseStartup();
    if (!prefs) return;
    setMode(prefs.mode);
    const cfg = MODES.find((m) => m.key === prefs.mode);
    const preset = cfg && DETECTION_PRESETS.find((p) => p.key === cfg.presetKey);
    if (preset) monitor.setSettings({ ...preset.settings });
    setWindowMinutes(prefs.mode === "icu" ? 30 : 10);
    setMeta((prev) => ({
      ...prev,
      context: prefs.context || prev.context,
      location: prefs.location || prev.location,
      caseCode: prev.caseCode || nextCaseCode(prefs.lastCaseCode),
    }));
  }, []);
  const [windowMinutes, setWindowMinutes] = useState(10);
  const [mode, setMode] = useState<MonitorMode>("anaesthesia");
  const [saveOpen, setSaveOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  // Resolved after hydration: navigator is not available during SSR.
  const [bleSupported, setBleSupported] = useState(true);
  useEffect(() => setBleSupported(isWebBluetoothAvailable()), []);
  const [endOpen, setEndOpen] = useState(false);
  const [caseState, setCaseState] = useState<"idle" | "running" | "ended">("idle");
  const [tab, setTab] = useState<"monitor" | "signal" | "review">("monitor");
  const [fullscreen, setFullscreen] = useState(false);
  const [caseSheet, setCaseSheet] = useState<CaseSheet>(null);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [dim, setDim] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markers, setMarkers] = useState<DetectedEvent[]>([]);
  /** TCI pumps running for this clinical episode (several may run at once). */
  const [infusions, setInfusions] = useState<TciInfusion[]>([]);
  const [markerText, setMarkerText] = useState("");
  const [aiResult, setAiResult] = useState<Interpretation | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiWatch, setAiWatch] = useState(false);
  const [aiLastRunAt, setAiLastRunAt] = useState<number | null>(null);
  /** AI reading of how the recorded TCI targets moved the EEG. */
  const [tciReport, setTciReport] = useState<TciResponseReport | null>(null);
  const [tciLoading, setTciLoading] = useState(false);
  const [tciError, setTciError] = useState<string | null>(null);
  const seenAlertIds = useRef<Set<string>>(new Set());
  const [meta, setMeta] = useState<CaseMeta>(EMPTY_CASE_META);
  /**
   * Stacked left/right DSAs, or one combined lane for faster scanning.
   * Remembered per device and per anonymised case code.
   */
  const [dsaView, setDsaView] = useDsaViewPreference(meta.caseCode);

  const { latest, summary, status } = monitor;
  const streaming = status === "streaming";
  const reconnecting = status === "reconnecting";
  const caseRunning = caseState === "running";
  const seizureAlert = latest?.seizureAlert ?? false;
  const icuMode = mode === "icu";
  const activeMode = MODES.find((m) => m.key === mode)!;

  const allEvents = useMemo(
    () => [...monitor.events, ...markers].sort((a, b) => a.t - b.t),
    [monitor.events, markers],
  );

  /** Trend alerts and clinician annotations drawn over the DSA lanes. */
  const dsaMarkerRail = useMemo<DsaMarker[]>(() => {
    const alerts = monitor.events
      .filter(
        (e) =>
          e.kind === "depth_drop" || e.kind === "depth_rise" || e.kind === "suppression_burden",
      )
      .map<DsaMarker>((e) => ({
        t: e.t,
        label: `${
          e.kind === "depth_drop" ? "Depth ↓" : e.kind === "depth_rise" ? "Depth ↑" : "BSR"
        } ${formatClock(e.t)}`,
        tone: e.severity === "critical" ? "critical" : "caution",
      }));
    // Depth-window crossings: when OpenIBIS left or re-entered the target band.
    const windowCrossings = monitor.events
      .filter((e) => e.kind === "depth_window_exit" || e.kind === "depth_window_return")
      .map<DsaMarker>((e) => ({
        t: e.t,
        label:
          e.kind === "depth_window_return"
            ? `In window ${formatClock(e.t)}`
            : `${e.detail.startsWith("Below") ? "Below" : "Above"} window ${formatClock(e.t)}`,
        tone:
          e.kind === "depth_window_return"
            ? "marker"
            : e.severity === "critical"
              ? "critical"
              : "caution",
        top: true,
      }));
    const annotations = markers.map<DsaMarker>((m) => ({
      t: m.t,
      label: m.detail,
      tone: "marker",
      top: true,
    }));
    return [...alerts, ...windowCrossings, ...annotations];
  }, [monitor.events, markers]);

  /** Timestamped audit entry in the session event log. */
  const audit = useCallback(
    (detail: string) => {
      monitor.addEvent({
        kind: "annotation",
        severity: "info",
        t: monitor.elapsed,
        duration: 0,
        detail: `Audit — ${detail}`,
      });
    },
    [monitor],
  );

  const alarms = useAlarms({ enabled: caseRunning });
  // Toast + optional chime for new burst-suppression / seizure markers,
  // grouped the same way the active DSA view groups the hemispheres.
  const markerAlerts = useMarkerAlerts({
    events: monitor.hemiEvents,
    view: dsaView,
    enabled: caseRunning,
  });
  // Visual alert when the signal quality index falls below the clinician's
  // threshold, grouped the same way the active DSA view groups hemispheres.
  const sqiAlerts = useSqiAlerts({
    history: monitor.sqiHistory,
    view: dsaView,
    enabled: caseRunning,
  });
  // Visual alert when the OpenIBIS depth index leaves the clinician's
  // notional optimal-anaesthesia window (default 40–60).
  const depthWindow = useDepthWindowAlerts({
    index: latest?.depth.index ?? null,
    t: latest?.t ?? monitor.elapsed,
    reliable: latest ? latest.depthReliability.reliable && !latest.depth.held : false,
    enabled: caseRunning,
    // Record every confirmed crossing in the session timeline so the case can
    // be reviewed later: when the depth index left the window and why.
    onTransition: useCallback(
      (tr: DepthWindowTransition) => {
        monitor.addEvent({
          kind: tr.kind === "exit" ? "depth_window_exit" : "depth_window_return",
          severity:
            tr.kind === "return" ? "info" : tr.direction === "below" ? "critical" : "warning",
          t: tr.t,
          duration: tr.kind === "return" ? Math.round(tr.heldSeconds) : 0,
          detail:
            tr.kind === "return"
              ? `Back within ${tr.low}–${tr.high} at OpenIBIS ${tr.index.toFixed(0)} after ${Math.round(tr.heldSeconds)} s ${tr.direction} window`
              : `${tr.direction === "below" ? "Below" : "Above"} target window ${tr.low}–${tr.high} — OpenIBIS ${tr.index.toFixed(0)} for ${Math.round(tr.heldSeconds)} s (${
                  tr.direction === "below"
                    ? "possible excessive hypnotic depth"
                    : "possible light anaesthesia"
                }${tr.reliable ? "" : ", signal flagged unreliable"})`,
        });
      },
      [monitor],
    ),
  });

  function selectMode(next: MonitorMode) {
    setMode(next);
    const cfg = MODES.find((m) => m.key === next)!;
    const preset = DETECTION_PRESETS.find((p) => p.key === cfg.presetKey);
    if (preset) monitor.setSettings({ ...preset.settings });
    setMeta((prev) => ({ ...prev, context: cfg.context }));
    setWindowMinutes(next === "icu" ? 30 : 10);
    if (caseRunning) audit(`Mode changed to ${cfg.label}`);
  }

  /** Applies a settings change and records it in the case audit trail. */
  function applySettings(patch: Partial<typeof monitor.settings>, description: string) {
    monitor.setSettings({ ...monitor.settings, ...patch });
    if (caseRunning) audit(description);
  }

  async function startCase(
    kind: "muse" | "simulated",
    options?: { device?: BluetoothDevice; preset?: string },
  ) {
    if (!meta.caseCode.trim()) {
      toast.error("Give the case an anonymised code first.");
      return;
    }
    setCaseOpen(false);
    saveCaseStartup({
      context: meta.context,
      location: meta.location,
      lastCaseCode: meta.caseCode.trim(),
      mode,
    });
    setMarkers([]);
    setInfusions([]);
    alarms.clearAll();
    setAiResult(null);
    seenAlertIds.current.clear();
    setCaseState("running");
    const ticked = CHECKLIST_ITEMS.filter((item) => checklist[item.key]).map((i) => i.label);
    audit(
      ticked.length === CHECKLIST_ITEMS.length
        ? "Pre-case checklist complete"
        : `Pre-case checklist: ${ticked.length ? ticked.join("; ") : "none ticked"}`,
    );
    await monitor.connect(kind, {
      ...(options?.device ? { device: options.device } : {}),
      ...(options?.preset ? { preset: options.preset } : {}),
    });
  }

  function endCase(fileNow: boolean) {
    setEndOpen(false);
    void monitor.stop();
    setCaseState("ended");
    if (fileNow) setSaveOpen(true);
    else toast.warning("Case ended without filing — the recording is still here until you reload.");
  }

  // Derive bedside alarm conditions from the live epoch and detected events.
  useEffect(() => {
    if (!caseRunning) return;
    const conditions: AlarmCondition[] = [];
    const hemi = monitor.hemiLatest;

    // Seizure: attribute to the hemisphere whose electrode pair is ictal.
    if (latest?.seizureAlert || hemi?.left.seizureAlert || hemi?.right.seizureAlert) {
      const sides: AlarmSide[] =
        hemi && (hemi.left.seizureAlert || hemi.right.seizureAlert)
          ? hemi.left.seizureAlert && hemi.right.seizureAlert
            ? ["bilateral"]
            : hemi.left.seizureAlert
              ? ["left"]
              : ["right"]
          : ["bilateral"];
      for (const side of sides) {
        const score =
          side === "left"
            ? (hemi?.left.seizureScore ?? 0)
            : side === "right"
              ? (hemi?.right.seizureScore ?? 0)
              : (latest?.seizureScore ?? 0);
        conditions.push({
          id: `seizure:${side}`,
          side,
          priority: icuMode ? "high" : "medium",
          title: `Possible seizure activity — ${SIDE_LABEL[side]}`,
          detail: `Rhythmic discharges, score ${score.toFixed(2)} — review the raw trace.`,
        });
      }
    }

    // Suppression: raise one alarm per side that crosses the threshold.
    const srBySide: { side: AlarmSide; sr: number }[] = hemi
      ? [
          { side: "left", sr: hemi.left.suppressionRatio },
          { side: "right", sr: hemi.right.suppressionRatio },
        ]
      : latest
        ? [{ side: "bilateral", sr: latest.suppressionRatio }]
        : [];
    for (const { side, sr } of srBySide) {
      if (sr >= 40) {
        conditions.push({
          id: `deep-suppression:${side}`,
          side,
          priority: "high",
          title: `Deep burst suppression — ${SIDE_LABEL[side]}`,
          detail: `Suppression ratio ${sr.toFixed(0)} % — consider lightening.`,
        });
      } else if (sr >= monitor.settings.bsrAlertPercent) {
        conditions.push({
          id: `suppression:${side}`,
          side,
          priority: "medium",
          title: `Burst suppression — ${SIDE_LABEL[side]}`,
          detail: `Suppression ratio ${sr.toFixed(0)} %.`,
        });
      }
    }

    // Signal loss: a whole-headband gap is bilateral, a flat pair is one side.
    if (monitor.dataGapSeconds >= 5 || reconnecting) {
      conditions.push({
        id: "signal-loss:bilateral",
        side: "bilateral",
        priority: "medium",
        title: "EEG signal lost — both hemispheres",
        detail: reconnecting
          ? `Reconnecting to the headband (attempt ${monitor.reconnectAttempt?.attempt ?? 1} of ${monitor.reconnectAttempt?.attempts ?? 5}).`
          : `No data for ${Math.round(monitor.dataGapSeconds)} s — check the headband.`,
      });
    } else if (hemi) {
      for (const side of ["left", "right"] as const) {
        if (hemi[side].flat) {
          conditions.push({
            id: `signal-loss:${side}`,
            side,
            priority: "medium",
            title: `EEG signal lost — ${SIDE_LABEL[side]}`,
            detail: "Both electrodes on this side are flat — reseat the headband.",
          });
        }
      }
    }
    if (latest && !latest.depthReliability.reliable && latest.quality.grade === "poor") {
      conditions.push({
        id: "quality",
        priority: "low",
        title: "Poor signal quality",
        detail: latest.depthReliability.reasons[0] ?? "Indices are unreliable in this segment.",
      });
    }
    alarms.sync(conditions, monitor.elapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    latest,
    monitor.hemiLatest,
    caseRunning,
    icuMode,
    monitor.dataGapSeconds,
    reconnecting,
    monitor.elapsed,
  ]);

  function addMarker(label: string, backdateSeconds = 0) {
    const text = label.trim();
    if (!text) return;
    if (!caseRunning) {
      toast.error("Start a case before marking events.");
      return;
    }
    const t = Math.max(0, monitor.elapsed - Math.max(0, backdateSeconds));
    const marker: DetectedEvent = {
      kind: "annotation",
      severity: "info",
      t,
      duration: 0,
      detail: text,
    };
    setMarkers((prev) => [...prev, marker].sort((a, b) => a.t - b.t));
    toast.success(`${text} marked at ${formatClock(t)}`, {
      duration: 10000,
      action: {
        label: "Undo",
        onClick: () => setMarkers((prev) => prev.filter((m) => m !== marker)),
      },
    });
  }

  /** Limits differ from the defaults for the current mode. */
  const modePreset = DETECTION_PRESETS.find((p) => p.key === activeMode.presetKey);
  const limitsOffDefault = modePreset
    ? (Object.keys(modePreset.settings) as (keyof typeof monitor.settings)[]).some(
        (k) => monitor.settings[k] !== modePreset.settings[k],
      )
    : false;

  /** Single source of truth for every live-case control, shared by both views. */
  const caseControls: CaseControls = {
    running: caseRunning,
    elapsed: monitor.elapsed,
    mode,
    onMark: addMarker,
    markers,
    events: allEvents,
    infusions,
    onInfusionsChange: setInfusions,
    settings: monitor.settings,
    onSettingsChange: applySettings,
    limitsOffDefault,
    onResetLimits: () => {
      if (!modePreset) return;
      monitor.setSettings({ ...modePreset.settings });
      if (caseRunning) audit(`Limits reset to ${activeMode.label} defaults`);
      toast.success(`Limits reset to ${activeMode.label} defaults`);
    },
    depthWindow,
    sqi: { threshold: sqiAlerts.threshold, setThreshold: sqiAlerts.setThreshold },
    alarms: {
      alarms: alarms.alarms,
      unacknowledged: alarms.unacknowledged,
      audioEnabled: alarms.audioEnabled,
      muted: alarms.muted,
      muteRemaining: alarms.muteRemaining,
      acknowledge: (id) => {
        alarms.acknowledge(id);
        audit(`Alarm acknowledged (${id})`);
        toast.success("Alarm acknowledged", {
          duration: 10000,
          action: { label: "Undo", onClick: () => alarms.unacknowledge(id) },
        });
      },
      acknowledgeAll: () => {
        alarms.acknowledgeAll();
        audit("All alarms acknowledged");
      },
      acknowledgeSide: (side) => {
        alarms.acknowledgeSide(side);
        audit(`Alarms acknowledged (${side})`);
      },
      unacknowledge: alarms.unacknowledge,
      pauseAudio: alarms.pauseAudio,
      resumeAudio: alarms.resumeAudio,
      setAudioEnabled: (on) => alarms.setAudioEnabled(on),
    },
    dim,
    onDimChange: setDim,
    handover: [
      { label: "Case time", value: formatClock(monitor.elapsed) },
      { label: "Mean SR", value: `${summary.meanSr.toFixed(0)} %` },
      {
        label: "Suppression time",
        value: formatDuration(Math.round(summary.suppressionSeconds)),
      },
      { label: "Alerts", value: String(monitor.events.filter((e) => e.kind !== "annotation").length) },
      { label: "Markers", value: String(markers.length) },
      { label: "TCI running", value: summariseInfusions(infusions) },
    ],
    live: {
      depthIndex: latest?.depth.index ?? null,
      suppressionRatio: latest ? Math.round(latest.suppressionRatio) : null,
      seizureScore: latest?.seizureScore ?? null,
      sqi: latest?.quality ? Math.round(latest.quality.score * 100) : null,
    },
  };

  const srTone = !latest
    ? "default"
    : latest.suppressionRatio >= 40
      ? "critical"
      : latest.suppressionRatio >= 10
        ? "caution"
        : "signal";

  const runInterpretation = useServerFn(interpretSession);

  const analyse = useCallback(
    async (silent = false) => {
      if (!user) {
        if (!silent) toast.error("Sign in to use AI interpretation.");
        return;
      }
      setAiLoading(true);
      setAiError(null);
      try {
        const digest = buildFeatureDigest(
          monitor.epochs,
          allEvents,
          {
            ageYears: meta.ageYears,
            sex: meta.sex,
            admissionDiagnosis: meta.admissionDiagnosis,
            clinicalFeatures: meta.clinicalFeatures,
            context: meta.context,
            // Give the interpreter the drug regimen running right now, so
            // depth and nociception findings are read in context.
            notes: [meta.notes, `TCI in progress — ${summariseInfusions(infusions)}`]
              .filter(Boolean)
              .join(" | "),
          },
          monitor.elapsed,
          activeMode.label,
        );
        const result = await runInterpretation({ data: { digest } });
        setAiResult(result);
        setAiLastRunAt(Date.now());
        // Raise a toast only for problems we have not already surfaced.
        for (const alert of result.alerts ?? []) {
          if (seenAlertIds.current.has(alert.id)) continue;
          seenAlertIds.current.add(alert.id);
          if (alert.severity === "critical") {
            toast.error(alert.title, {
              description: alert.action || alert.detail,
              duration: 15000,
            });
          } else if (alert.severity === "warning") {
            toast.warning(alert.title, {
              description: alert.action || alert.detail,
              duration: 10000,
            });
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI analysis failed.";
        setAiError(message);
        if (!silent) toast.error(message);
      } finally {
        setAiLoading(false);
      }
    },
    [
      user,
      monitor.epochs,
      monitor.elapsed,
      allEvents,
      meta,
      infusions,
      activeMode.label,
      runInterpretation,
    ],
  );

  const analyseRef = useRef(analyse);
  analyseRef.current = analyse;

  // Continuous surveillance: re-review the session every 3 minutes while streaming.
  useEffect(() => {
    if (!aiWatch || !streaming) return;
    const id = setInterval(() => {
      if (monitor.epochs.length >= 30) void analyseRef.current(true);
    }, 180_000);
    return () => clearInterval(id);
  }, [aiWatch, streaming, monitor.epochs.length]);

  async function handleSave() {
    if (!meta.caseCode.trim()) {
      toast.error("Add an anonymised case code first.");
      return;
    }
    setSaving(true);
    try {
      await saveSession(
        { ...meta, deviceName: monitor.sourceName },
        monitor.epochs,
        allEvents,
        summary,
        monitor.elapsed,
      );
      toast.success("Session saved to your records.");
      setSaveOpen(false);
      setCaseState("idle");
      alarms.clearAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the session.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      {fullscreen ? (
        <FullscreenMonitor
          epochs={monitor.epochs}
          hemiSpectra={monitor.hemiSpectra}
          hemiLatest={monitor.hemiLatest}
          hemiEvents={monitor.hemiEvents}
          latest={latest}
          waveform={monitor.waveform}
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
          <span
            className={cn(
              "metric-value rounded-full border px-2.5 py-0.5 text-xs short:hidden md:short:inline",
              reconnecting
                ? "border-caution/60 text-caution"
                : streaming
                  ? "border-signal/50 text-signal"
                  : "border-border text-muted-foreground",
            )}
          >
            {reconnecting
              ? `reconnecting ${monitor.reconnectAttempt?.attempt ?? 1}/${monitor.reconnectAttempt?.attempts ?? 5}`
              : streaming
                ? `${monitor.sourceName} · live`
                : caseState === "ended"
                  ? "case ended"
                  : "no case running"}
          </span>
          {caseState !== "idle" ? (
            <span className="metric-value text-sm text-muted-foreground">
              {formatClock(monitor.elapsed)}
            </span>
          ) : null}
          {meta.caseCode && caseState !== "idle" ? (
            <span className="metric-value truncate rounded bg-muted px-2 py-0.5 text-xs">
              {meta.caseCode}
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
                    "flex flex-1 items-center justify-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none sm:py-1",
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
                  className="flex-1 sm:flex-none"
                  onClick={() => setEndOpen(true)}
                >
                  <CircleStop className="size-4" /> End case
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 sm:flex-none"
                  onClick={() => setFullscreen(true)}
                >
                  <Maximize2 className="size-4" /> Monitor view
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" aria-label="More case actions">
                      <MoreVertical className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => setSaveOpen(true)}>
                      <Save className="size-4" /> File now
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setDim(!dim)}>
                      {dim ? <Sun className="size-4" /> : <Moon className="size-4" />}
                      {dim ? "Undim display" : "Dim for theatre"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : (
              <>
                <Button size="sm" className="flex-1 sm:flex-none" onClick={() => setCaseOpen(true)}>
                  <Bluetooth className="size-4" /> Start case
                </Button>
                {caseState === "ended" && monitor.epochs.length ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="flex-1 sm:flex-none"
                    onClick={() => setSaveOpen(true)}
                  >
                    <Save className="size-4" /> File case
                  </Button>
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

      <main className="mx-auto max-w-[1500px] space-y-4 px-3 py-4 sm:px-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground short:hidden">
          <span className="metric-value rounded-full bg-signal/10 px-2 py-0.5 text-xs text-signal">
            {activeMode.label} mode
          </span>
          <span>{activeMode.blurb}</span>
        </div>
        {caseState !== "idle" ? (
          <TciStatusStrip infusions={infusions} onOpen={() => setCaseSheet("tci")} />
        ) : null}
        {monitor.error ? (
          <div className="panel border-critical/60 px-4 py-3 text-sm text-critical">
            {monitor.error}
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
            {/* Density spectral array */}
            <section className="panel overflow-hidden">
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
                    <SelectTrigger className="w-full min-w-0 sm:w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="average">All channels (mean)</SelectItem>
                      {MUSE_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={String(windowMinutes)}
                    onValueChange={(v) => setWindowMinutes(Number(v))}
                  >
                    <SelectTrigger className="w-full min-w-0 sm:w-[110px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="5">5 min</SelectItem>
                      <SelectItem value="10">10 min</SelectItem>
                      <SelectItem value="30">30 min</SelectItem>
                      <SelectItem value="60">60 min</SelectItem>
                    </SelectContent>
                  </Select>
                  <div className="col-span-2 flex shrink-0 rounded-md border border-border p-0.5">
                    {(
                      [
                        { key: "bilateral", label: "Bilateral" },
                        { key: "combined", label: "Combined" },
                        { key: "overlay", label: "Overlay" },
                      ] as const
                    ).map((v) => (
                      <button
                        key={v.key}
                        type="button"
                        aria-pressed={dsaView === v.key}
                        onClick={() => setDsaView(v.key)}
                        className={cn(
                          "min-h-[36px] flex-1 rounded px-3 text-xs font-medium sm:flex-none",
                          dsaView === v.key
                            ? "bg-secondary text-secondary-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {v.label}
                      </button>
                    ))}
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
                      "flex min-h-[36px] min-w-[36px] shrink-0 items-center justify-center justify-self-start rounded-md border border-border",
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
                  <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                    Connect a Muse 2 headband to start building the spectrogram — or run the demo
                    signal to see anaesthesia, burst suppression and ictal patterns.
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
                <div className="-mx-3 flex snap-x items-center gap-2 overflow-x-auto px-3 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
                  <span className="hidden shrink-0 text-xs font-semibold tracking-wide text-muted-foreground uppercase sm:inline">
                    Mark event
                  </span>
                  {MARKER_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => addMarker(preset)}
                      disabled={!caseRunning}
                      className="shrink-0 snap-start rounded-full border border-border px-3 py-1.5 text-xs whitespace-nowrap text-foreground transition-colors hover:border-marker hover:text-marker disabled:opacity-40 sm:px-2.5 sm:py-1"
                    >
                      {preset}
                    </button>
                  ))}
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
              <TciPanel
                infusions={infusions}
                onChange={setInfusions}
                running={caseRunning}
                elapsed={monitor.elapsed}
                onMark={addMarker}
              />
            </section>

            {/* Metrics */}
            <MetricsGrid
              latest={latest}
              summary={summary}
              srWindowSeconds={monitor.settings.srWindowSeconds}
              srTone={srTone as MetricTone}
              seizureAlert={seizureAlert}
              icuMode={icuMode}
              depthWindow={depthWindow}
            />

            <DepthWindowPanel depthWindow={depthWindow} depthIndex={latest?.depth.index} />

            {/* Event rail — the last few entries stay visible beside the trace. */}
            {caseState !== "idle" ? (
              <div className="panel px-3 py-2.5 sm:px-4">
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
            <SignalQualityPanel
              quality={latest?.quality ?? null}
              channels={MUSE_CHANNELS}
              channelQuality={monitor.channelQuality}
              usableFraction={summary.usableFraction}
              depthArtifact={latest?.depthArtifact ?? null}
              depthGatedFraction={latest?.depth.gatedFraction}
            />
            <SqiTrend
              history={monitor.sqiHistory}
              bilateral={dsaView !== "combined"}
              threshold={sqiAlerts.threshold}
            />
          </div>
        ) : null}

        {tab === "review" ? (
          <AiInsightPanel
            result={aiResult}
            loading={aiLoading}
            error={aiError}
            epochCount={monitor.epochs.length}
            onRun={() => void analyse(false)}
            watch={aiWatch}
            onWatchChange={(next) => {
              setAiWatch(next);
              if (next) {
                toast.info("Continuous AI surveillance on — reviewing every 3 minutes.");
                if (monitor.epochs.length >= 30) void analyse(true);
              }
            }}
            lastRunAt={aiLastRunAt}
            feedbackContext={mode}
          />
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
                      {MUSE_CHANNELS.map((c) => (
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
                    <WaveformStrip
                      data={monitor.waveform}
                      suppressionThresholdUv={monitor.settings.suppressionThresholdUv}
                      suppressed={latest?.isSuppressed ?? false}
                    />
                  </div>
                </div>

                <div className="panel px-3 py-4 sm:px-4">
                  <h2 className="text-sm font-semibold">Detection thresholds</h2>
                  <div className="mt-3">
                    <Label className="text-xs text-muted-foreground">Sensitivity preset</Label>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {DETECTION_PRESETS.map((p) => {
                        const active = matchPreset(monitor.settings) === p.key;
                        return (
                          <Button
                            key={p.key}
                            size="sm"
                            variant={active ? "default" : "outline"}
                            title={p.description}
                            onClick={() =>
                              applySettings(p.settings, `Sensitivity preset set to ${p.label}`)
                            }
                          >
                            {p.label}
                          </Button>
                        );
                      })}
                      {matchPreset(monitor.settings) === "custom" && (
                        <span className="self-center text-xs text-muted-foreground">Custom</span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {DETECTION_PRESETS.find((p) => p.key === matchPreset(monitor.settings))
                        ?.description ?? "Manually tuned thresholds."}
                    </p>
                  </div>
                  <div className="mt-5 grid gap-5 sm:grid-cols-2">
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Suppression amplitude</Label>
                        <span className="metric-value">
                          {monitor.settings.suppressionThresholdUv} µV
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={3}
                        max={20}
                        step={1}
                        value={[monitor.settings.suppressionThresholdUv]}
                        onValueChange={([v]) =>
                          monitor.setSettings({
                            ...monitor.settings,
                            suppressionThresholdUv: v ?? 8,
                          })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Suppression ratio window</Label>
                        <span className="metric-value">{monitor.settings.srWindowSeconds} s</span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={30}
                        max={300}
                        step={30}
                        value={[monitor.settings.srWindowSeconds]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, srWindowSeconds: v ?? 60 })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Seizure alert threshold</Label>
                        <span className="metric-value">
                          {monitor.settings.seizureThreshold.toFixed(2)}
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={0.3}
                        max={0.9}
                        step={0.01}
                        value={[monitor.settings.seizureThreshold]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, seizureThreshold: v ?? 0.62 })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Alert persistence</Label>
                        <span className="metric-value">{monitor.settings.seizureEpochs} s</span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={1}
                        max={10}
                        step={1}
                        value={[monitor.settings.seizureEpochs]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, seizureEpochs: v ?? 3 })
                        }
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Consecutive 1 s epochs above threshold before an alert is raised.
                      </p>
                    </div>
                    <div className="border-t border-border pt-4">
                      <h3 className="text-xs font-semibold">Trend alerts</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Depth-index swings and new or worsening burst suppression are timestamped in
                        the event log and marked on the DSA timeline.
                      </p>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Depth drop alert</Label>
                        <span className="metric-value">
                          −{monitor.settings.depthDropUnits} units
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={5}
                        max={40}
                        step={1}
                        value={[monitor.settings.depthDropUnits]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, depthDropUnits: v ?? 15 })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Depth rise alert</Label>
                        <span className="metric-value">
                          +{monitor.settings.depthRiseUnits} units
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={5}
                        max={40}
                        step={1}
                        value={[monitor.settings.depthRiseUnits]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, depthRiseUnits: v ?? 15 })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Depth trend window</Label>
                        <span className="metric-value">{monitor.settings.depthTrendSeconds} s</span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={30}
                        max={300}
                        step={15}
                        value={[monitor.settings.depthTrendSeconds]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, depthTrendSeconds: v ?? 60 })
                        }
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Change is measured across this window; one alert per window at most.
                      </p>
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">New burst suppression at</Label>
                        <span className="metric-value">
                          {monitor.settings.bsrAlertPercent} % SR
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={1}
                        max={50}
                        step={1}
                        value={[monitor.settings.bsrAlertPercent]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, bsrAlertPercent: v ?? 10 })
                        }
                      />
                    </div>
                    <div>
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <Label className="text-xs">Worsening step</Label>
                        <span className="metric-value">
                          +{monitor.settings.bsrWorseningPercent} % SR
                        </span>
                      </div>
                      <Slider
                        className="mt-3"
                        min={2}
                        max={30}
                        step={1}
                        value={[monitor.settings.bsrWorseningPercent]}
                        onValueChange={([v]) =>
                          monitor.setSettings({ ...monitor.settings, bsrWorseningPercent: v ?? 10 })
                        }
                      />
                      <p className="mt-2 text-xs text-muted-foreground">
                        Re-alerts each time the suppression ratio climbs a further step.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="panel overflow-hidden">
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

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>File this case</DialogTitle>
            <DialogDescription>
              Only the case code you type here is stored — no names, dates of birth or hospital
              numbers. Use a code that cannot identify the patient outside your own records.
            </DialogDescription>
          </DialogHeader>
          {user ? (
            <>
              <CaseFields meta={meta} onChange={setMeta} idPrefix="save" />
              <p className="metric-value text-xs text-muted-foreground">
                {monitor.epochs.length} epochs · {formatClock(monitor.elapsed)} · {allEvents.length}{" "}
                events ({markers.length} clinician markers)
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Sign in to store sessions securely against your own account.
            </p>
          )}
          <DialogFooter>
            {user ? (
              <Button onClick={() => void handleSave()} disabled={saving}>
                {saving ? "Saving…" : "Save session"}
              </Button>
            ) : (
              <Button asChild>
                <Link to="/auth">Sign in</Link>
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={caseOpen} onOpenChange={setCaseOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Start a case</DialogTitle>
            <DialogDescription>
              Record the case details before streaming. The case then survives a headband dropout
              and can be filed at the end without retyping anything.
            </DialogDescription>
          </DialogHeader>
          <CaseFields meta={meta} onChange={setMeta} idPrefix="start" />
          <PreCaseChecklist
            checked={checklist}
            onToggle={(key: ChecklistKey) =>
              setChecklist((prev) => ({ ...prev, [key]: !prev[key] }))
            }
          />
          {bleSupported ? null : (
            <p className="rounded-md border border-caution/40 bg-caution/10 p-3 text-xs text-muted-foreground">
              This browser cannot reach Bluetooth devices. On iPhone or iPad open CortexTrace in
              Bluefy; on desktop or Android use Chrome or Edge. The demo signal still works here.
            </p>
          )}
          {bleSupported ? (
            <MuseCapabilityPanel
              onConfirm={(device, preset) => void startCase("muse", { device, preset })}
            />
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="secondary" onClick={() => void startCase("simulated")}>
              <FlaskConical className="size-4" /> Demo signal
            </Button>
            <Button
              variant="outline"
              disabled={!bleSupported}
              onClick={() => void startCase("muse")}
            >
              <Bluetooth className="size-4" /> Skip detection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dim ? (
        <button
          type="button"
          aria-label="Undim display"
          onClick={() => setDim(false)}
          className="fixed inset-0 z-[60] cursor-pointer bg-black/60"
        />
      ) : null}

      <Dialog open={endOpen} onOpenChange={setEndOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>End case {meta.caseCode ? `“${meta.caseCode}”` : ""}?</DialogTitle>
            <DialogDescription>
              Streaming stops and the recording is closed. File it now to keep the trend, events and
              alarm history — nothing is stored until you do.
            </DialogDescription>
          </DialogHeader>
          <p className="metric-value text-xs text-muted-foreground">
            {formatClock(monitor.elapsed)} · {monitor.epochs.length} epochs · {allEvents.length}{" "}
            events · mean SR {summary.meanSr.toFixed(0)} %
          </p>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => endCase(false)}>
              End without filing
            </Button>
            <Button onClick={() => endCase(true)}>
              <Save className="size-4" /> End and file case
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

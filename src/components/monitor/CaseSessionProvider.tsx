import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";

import { useCaseAi } from "@/hooks/useCaseAi";
import { useClinicalDerivations } from "@/hooks/useClinicalDerivations";
import { useAuth } from "@/hooks/useAuth";
import { useAlarms } from "@/hooks/useAlarms";
import { useMarkerAlerts } from "@/hooks/useMarkerAlerts";
import { useSqiAlerts } from "@/hooks/useSqiAlerts";
import { useSeizureRiskAlerts, type SeizureTrendAlert } from "@/hooks/useSeizureRiskAlerts";
import { useDepthWindowAlerts, type DepthWindowTransition } from "@/hooks/useDepthWindowAlerts";
import { useEegMonitor } from "@/hooks/useEegMonitor";
import { useDsaViewPreference } from "@/lib/eeg/dsa-view-pref";
import {
  defaultWindowMinutes,
  modeConfig,
  type MonitorMode,
} from "@/components/monitor/monitor-modes";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { DETECTION_PRESETS } from "@/lib/eeg/analysis";
import { EMPTY_CASE_META, type CaseMeta } from "@/lib/eeg/case-meta";
import { setActiveDepthCalibration } from "@/lib/eeg/depth";
import { loadStoredCalibration } from "@/lib/eeg/calibration";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { isWebBluetoothAvailable } from "@/lib/eeg/muse";
import type { CaseSheet } from "@/components/monitor/CaseActionBar";
import { CHECKLIST_ITEMS } from "@/components/monitor/PreCaseChecklist";
import { generateCaseCode, loadCaseStartup, nextCaseCode, saveCaseStartup } from "@/lib/eeg/case-startup";
import {
  generateUniqueCaseCode,
  isCaseCodeUsed,
  loadUsedCaseCodes,
  rememberCaseCode,
} from "@/lib/eeg/case-code-registry";
import type { CaseControls } from "@/components/monitor/case-controls";
import { summariseInfusions, type TciInfusion } from "@/lib/eeg/tci";
import { summariseBis, type BisReading } from "@/lib/eeg/bis";
import { saveSession } from "@/lib/eeg/save";

/**
 * Everything a running case owns. Held above the router outlet so a case keeps
 * streaming, alarming and recording while the clinician moves between pages;
 * the recording is only thrown away when they explicitly exit without saving.
 */
export type CaseSession = ReturnType<typeof useCaseSessionState>;

const CaseSessionContext = createContext<CaseSession | null>(null);

export function CaseSessionProvider({ children }: { children: ReactNode }) {
  const value = useCaseSessionState();
  return <CaseSessionContext.Provider value={value}>{children}</CaseSessionContext.Provider>;
}

export function useCaseSession(): CaseSession {
  const ctx = useContext(CaseSessionContext);
  if (!ctx) throw new Error("useCaseSession must be used inside a CaseSessionProvider");
  return ctx;
}

function useCaseSessionState() {
  const monitor = useEegMonitor();
  const { user } = useAuth();

  /** Latest setter, so the start-up effect can stay a true mount-only effect. */
  const setSettingsRef = useRef(monitor.setSettings);
  setSettingsRef.current = monitor.setSettings;

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
    const cfg = modeConfig(prefs.mode);
    const preset = DETECTION_PRESETS.find((p) => p.key === cfg.presetKey);
    if (preset) setSettingsRef.current({ ...preset.settings });
    setWindowMinutes(defaultWindowMinutes(prefs.mode));
    setMeta((prev) => {
      const context = prefs.context || prev.context;
      const used = loadUsedCaseCodes();
      const carried = prev.caseCode || nextCaseCode(prefs.lastCaseCode);
      return {
        ...prev,
        context,
        location: prefs.location || prev.location,
        // Always arrive with a usable anonymised code: continue the clinician's
        // own numbering if they have one, otherwise mint a fresh code — never
        // one that is already in the local archive.
        caseCode:
          carried && !isCaseCodeUsed(carried, used)
            ? carried
            : generateUniqueCaseCode(used, () => generateCaseCode(context)).code,
      };
    });
  }, []);

  // A brand-new device/session has no stored preferences at all, so mint the
  // very first code here.
  useEffect(() => {
    setMeta((prev) =>
      prev.caseCode
        ? prev
        : {
            ...prev,
            caseCode: generateUniqueCaseCode(loadUsedCaseCodes(), () =>
              generateCaseCode(prev.context),
            ).code,
          },
    );
  }, []);
  const [windowMinutes, setWindowMinutes] = useState(10);
  const [mode, setMode] = useState<MonitorMode>("anaesthesia");
  const [saveOpen, setSaveOpen] = useState(false);
  const [caseOpen, setCaseOpen] = useState(false);
  // Resolved after hydration: navigator is not available during SSR.
  const [bleSupported, setBleSupported] = useState(true);
  useEffect(() => setBleSupported(isWebBluetoothAvailable()), []);
  const [endOpen, setEndOpen] = useState(false);
  /** Confirmation for the destructive "exit without saving" action. */
  const [discardOpen, setDiscardOpen] = useState(false);
  const [caseState, setCaseState] = useState<"idle" | "running" | "ended">("idle");
  const [tab, setTab] = useState<"monitor" | "signal" | "review">("monitor");
  const [fullscreen, setFullscreen] = useState(false);
  const [caseSheet, setCaseSheet] = useState<CaseSheet>(null);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [dim, setDim] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [markers, setMarkers] = useState<DetectedEvent[]>([]);
  /** TCI pumps running for this clinical episode (several may run at once). */
  const [infusions, setInfusions] = useState<TciInfusion[]>([]);
  /** Values transcribed from a commercial BIS monitor running alongside. */
  const [bisReadings, setBisReadings] = useState<BisReading[]>([]);
  const [markerText, setMarkerText] = useState("");
  const [meta, setMeta] = useState<CaseMeta>(EMPTY_CASE_META);
  /** Anonymised case codes already filed on this device (local archive). */
  const [usedCaseCodes, setUsedCaseCodes] = useState<string[]>([]);
  useEffect(() => setUsedCaseCodes(loadUsedCaseCodes()), []);
  /**
   * Stacked left/right DSAs, or one combined lane for faster scanning.
   * Remembered per device and per anonymised case code.
   */
  const [dsaView, setDsaView] = useDsaViewPreference(meta.caseCode);

  const { summary, status } = monitor;
  const streaming = status === "streaming";
  const reconnecting = status === "reconnecting";
  const caseRunning = caseState === "running";
  const icuMode = mode === "icu";
  const activeMode = modeConfig(mode);

  /**
   * One shared clinical picture per epoch: merged event log, DSA marks,
   * uncertainty, alarm conditions and the headline live values.
   */
  const derived = useClinicalDerivations({
    epochs: monitor.epochs,
    events: monitor.events,
    markers,
    hemi: monitor.hemiLatest,
    settings: monitor.settings,
    icuMode,
    dataGapSeconds: monitor.dataGapSeconds,
    reconnecting,
    reconnectAttempt: monitor.reconnectAttempt ?? null,
  });
  const { latest, allEvents, uncertainty, srTone, seizureAlert } = derived;
  // Wall-clock anchor for t = 0, so alert cards can show time of day.
  const [sessionStartedAtMs, setSessionStartedAtMs] = useState(() => Date.now());
  const dsaMarkerRail = derived.dsaMarkers;

  /** AI decision support for this case (session read + TCI dose–response). */
  const ai = useCaseAi({
    signedIn: Boolean(user),
    epochs: monitor.epochs,
    events: allEvents,
    elapsed: monitor.elapsed,
    meta,
    infusions,
    bisReadings,
    modeLabel: activeMode.label,
    streaming,
  });

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

  // Real-time alerting when the smoothed seizure-risk trend crosses the
  // clinician's thresholds, with a short AI read of each crossing.
  const seizureRisk = useSeizureRiskAlerts({
    epochs: monitor.epochs,
    enabled: caseRunning,
    mode,
    markers: markers.map((m) => ({ t: m.t, detail: m.detail })),
    patient: {
      ageYears: meta.ageYears,
      sex: meta.sex,
      admissionDiagnosis: meta.admissionDiagnosis,
      clinicalFeatures: meta.clinicalFeatures,
      context: meta.context,
    },
    // Every confirmed crossing is timestamped in the session timeline so the
    // case can be reviewed later.
    onAlert: useCallback(
      (a: SeizureTrendAlert) => {
        monitor.addEvent({
          kind: "annotation",
          severity: "warning",
          t: a.t,
          duration: 0,
          detail:
            a.trigger === "sustained"
              ? `Seizure-risk trend sustained above threshold — risk ${(a.risk * 100).toFixed(0)} % (signal ${(a.quality * 100).toFixed(0)} %)`
              : `Seizure-risk trend rising ${(a.risePerMinute * 100).toFixed(0)} %/min — risk ${(a.risk * 100).toFixed(0)} % (signal ${(a.quality * 100).toFixed(0)} %)`,
        });
      },
      [monitor],
    ),
    onAssessment: useCallback(
      (a: SeizureTrendAlert) => {
        if (!a.assessment) return;
        monitor.addEvent({
          kind: "annotation",
          severity: a.assessment.severity === "critical" ? "critical" : "info",
          t: a.t,
          duration: 0,
          detail: `AI seizure-trend read — ${a.assessment.headline} (${a.assessment.likelihood}, ${a.assessment.confidence} confidence)`,
        });
      },
      [monitor],
    ),
  });

  function selectMode(next: MonitorMode) {
    setMode(next);
    const cfg = modeConfig(next);
    const preset = DETECTION_PRESETS.find((p) => p.key === cfg.presetKey);
    if (preset) monitor.setSettings({ ...preset.settings });
    setMeta((prev) => ({ ...prev, context: cfg.context }));
    setWindowMinutes(defaultWindowMinutes(next));
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
    // Never silently overwrite an unfiled recording.
    if (caseState === "ended" && hasUnfiledData) {
      toast.error("File the previous case first, or exit it without saving.");
      setCaseOpen(false);
      setDiscardOpen(true);
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
    setBisReadings([]);
    setSaved(false);
    setSessionStartedAtMs(Date.now());
    alarms.clearAll();
    seizureRisk.clear();
    ai.reset();
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
    else
      toast.warning(
        "Case ended without filing — everything recorded is kept until you choose “Exit without saving”.",
      );
  }

  /**
   * The only destructive path: discards the whole recording (trend, events,
   * markers, TCI and BIS entries) after an explicit confirmation.
   */
  function discardCase() {
    setDiscardOpen(false);
    void monitor.stop();
    monitor.reset();
    setMarkers([]);
    setInfusions([]);
    setBisReadings([]);
    setMarkerText("");
    setChecklist({});
    // The next case starts with a fresh anonymised code, never the discarded one.
    setMeta({ ...EMPTY_CASE_META, caseCode: generateCaseCode(meta.context), context: meta.context });
    setSaved(false);
    setFullscreen(false);
    setCaseSheet(null);
    setTab("monitor");
    alarms.clearAll();
    seizureRisk.clear();
    ai.reset();
    setCaseState("idle");
    toast.success("Case data discarded — nothing was stored.");
  }

  // Derive bedside alarm conditions from the live epoch and detected events.
  useEffect(() => {
    if (!caseRunning) return;
    alarms.sync(derived.alarmConditions, monitor.elapsed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [derived.alarmConditions, caseRunning, monitor.elapsed]);

  function addMarker(label: string, backdateSeconds = 0) {
    const text = label.trim();
    if (!text) return;
    if (!caseRunning) {
      toast.error("Start a case before marking events.");
      return;
    }
    const t = Math.max(0, monitor.elapsed - Math.max(0, backdateSeconds));
    placeMarker(text, t);
  }

  /** Place an annotation at an explicit session time (e.g. clicked on a trace). */
  function addMarkerAt(label: string, tSeconds: number) {
    const text = label.trim();
    if (!text) return;
    if (!caseRunning) {
      toast.error("Start a case before marking events.");
      return;
    }
    placeMarker(text, Math.max(0, tSeconds));
  }

  function placeMarker(text: string, t: number) {
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
    bisReadings,
    onBisReadingsChange: setBisReadings,
    caseNotes: { meta, onChange: setMeta },
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
      {
        label: "Alerts",
        value: String(monitor.events.filter((e) => e.kind !== "annotation").length),
      },
      { label: "Markers", value: String(markers.length) },
      { label: "TCI running", value: summariseInfusions(infusions) },
      { label: "BIS reference", value: summariseBis(bisReadings) },
    ],
    live: derived.live,
  };

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
        sessionStartedAtMs,
      );
      toast.success("Session saved to your records.");
      setSaveOpen(false);
      setSaved(true);
      setCaseState("ended");
      alarms.clearAll();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the session.");
    } finally {
      setSaving(false);
    }
  }

  /** True when there is recorded material that has not been filed yet. */
  const hasUnfiledData =
    !saved && (monitor.epochs.length > 0 || allEvents.length > 0 || markers.length > 0);

  return {
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
    dsaView,
    setDsaView,
    summary,
    status,
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
    addMarker,
    addMarkerAt,
    limitsOffDefault,
    caseControls,
    handleSave,
  };
}

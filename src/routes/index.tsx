import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bluetooth,
  CircleStop,
  FlaskConical,
  HeartPulse,
  Stethoscope,
  Save,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { DsaChart, DsaLegend } from "@/components/monitor/DsaChart";
import { EventLog } from "@/components/monitor/EventLog";
import { AiInsightPanel } from "@/components/monitor/AiInsightPanel";
import { buildFeatureDigest } from "@/lib/eeg/features";
import { interpretSession, type Interpretation } from "@/lib/eeg/interpret.functions";
import { MetricTile } from "@/components/monitor/MetricTile";
import { SignalQualityPanel } from "@/components/monitor/SignalQualityPanel";
import { WaveformStrip } from "@/components/monitor/WaveformStrip";
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
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/useAuth";
import { useEegMonitor } from "@/hooks/useEegMonitor";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { DETECTION_PRESETS, matchPreset } from "@/lib/eeg/analysis";
import { DEPTH_STATE_LABEL, depthTone, setActiveDepthCalibration } from "@/lib/eeg/depth";
import { loadStoredCalibration } from "@/lib/eeg/calibration";
import { formatClock, formatDuration } from "@/lib/eeg/format";
import { MUSE_CHANNELS } from "@/lib/eeg/muse";
import { saveSession } from "@/lib/eeg/save";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({
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

const CONTEXTS = [
  { value: "general_anaesthesia", label: "General anaesthesia" },
  { value: "icu_sedation", label: "ICU sedation" },
  { value: "procedural_sedation", label: "Procedural sedation" },
  { value: "other", label: "Other" },
];

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

const SEX_OPTIONS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
  { value: "other", label: "Other" },
  { value: "unknown", label: "Not recorded" },
];

const CLINICAL_FEATURES = [
  "Sepsis",
  "Septic shock",
  "Delirium",
  "OOHCA",
  "IHCA",
  "Hypoxic brain injury",
  "Dementia",
  "Traumatic brain injury",
  "Intracranial haemorrhage",
  "Stroke",
  "Known epilepsy",
  "Status epilepticus",
  "Liver failure",
  "Renal failure",
  "Alcohol / drug withdrawal",
  "Post-cardiac surgery",
  "Neuromuscular blockade",
  "Therapeutic hypothermia",
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
  const [windowMinutes, setWindowMinutes] = useState(10);
  const [mode, setMode] = useState<MonitorMode>("anaesthesia");
  const [saveOpen, setSaveOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [markers, setMarkers] = useState<DetectedEvent[]>([]);
  const [markerText, setMarkerText] = useState("");
  const [aiResult, setAiResult] = useState<Interpretation | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [meta, setMeta] = useState({
    caseCode: "",
    context: "general_anaesthesia",
    location: "",
    notes: "",
    ageYears: "",
    sex: "",
    admissionDiagnosis: "",
    clinicalFeatures: [] as string[],
  });

  const { latest, summary, status } = monitor;
  const streaming = status === "streaming";
  const seizureAlert = latest?.seizureAlert ?? false;
  const icuMode = mode === "icu";
  const activeMode = MODES.find((m) => m.key === mode)!;

  function selectMode(next: MonitorMode) {
    setMode(next);
    const cfg = MODES.find((m) => m.key === next)!;
    const preset = DETECTION_PRESETS.find((p) => p.key === cfg.presetKey);
    if (preset) monitor.setSettings({ ...preset.settings });
    setMeta((prev) => ({ ...prev, context: cfg.context }));
    setWindowMinutes(next === "icu" ? 30 : 10);
  }

  const allEvents = useMemo(
    () => [...monitor.events, ...markers].sort((a, b) => a.t - b.t),
    [monitor.events, markers],
  );

  function addMarker(label: string) {
    const text = label.trim();
    if (!text) return;
    if (!streaming) {
      toast.error("Start monitoring before marking events.");
      return;
    }
    setMarkers((prev) => [
      ...prev,
      {
        kind: "annotation",
        severity: "info",
        t: monitor.elapsed,
        duration: 0,
        detail: text,
      },
    ]);
    toast.success(`${text} marked at ${formatClock(monitor.elapsed)}`);
  }

  const srTone = !latest
    ? "default"
    : latest.suppressionRatio >= 40
      ? "critical"
      : latest.suppressionRatio >= 10
        ? "caution"
        : "signal";

  const runInterpretation = useServerFn(interpretSession);

  async function handleAnalyse() {
    if (!user) {
      toast.error("Sign in to use AI interpretation.");
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
          notes: meta.notes,
        },
        monitor.elapsed,
        activeMode.label,
      );
      const result = await runInterpretation({ data: { digest } });
      setAiResult(result);
    } catch (err) {
      setAiError(err instanceof Error ? err.message : "AI analysis failed.");
    } finally {
      setAiLoading(false);
    }
  }

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
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the session.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-wrap items-center gap-3 px-4 py-3">
          <div className="flex items-center gap-2">
            <Activity className="size-5 text-signal" />
            <span className="text-sm font-semibold tracking-[0.18em] uppercase">CortexTrace</span>
          </div>
          <span
            className={cn(
              "metric-value rounded-full border px-2.5 py-0.5 text-[11px]",
              streaming
                ? "border-signal/50 text-signal"
                : "border-border text-muted-foreground",
            )}
          >
            {streaming ? `${monitor.sourceName} · live` : "not streaming"}
          </span>
          {streaming ? (
            <span className="metric-value text-sm text-muted-foreground">
              {formatClock(monitor.elapsed)}
            </span>
          ) : null}

          <div
            role="group"
            aria-label="Monitoring mode"
            className="flex items-center gap-1 rounded-full border border-border p-0.5"
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
                    "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors",
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

          <div className="ml-auto flex flex-wrap items-center gap-2">
            {streaming ? (
              <>
                <Button variant="outline" size="sm" onClick={() => setSaveOpen(true)}>
                  <Save className="size-4" /> Save session
                </Button>
                <Button variant="destructive" size="sm" onClick={() => void monitor.stop()}>
                  <CircleStop className="size-4" /> Stop
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  onClick={() => {
                    setMarkers([]);
                    void monitor.connect("muse");
                  }}
                >
                  <Bluetooth className="size-4" /> Connect Muse 2
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setMarkers([]);
                    void monitor.connect("simulated");
                  }}
                >
                  <FlaskConical className="size-4" /> Demo signal
                </Button>
              </>
            )}
            <Button asChild variant="ghost" size="sm">
              <Link to={user ? "/sessions" : "/auth"}>{user ? "Sessions" : "Sign in"}</Link>
            </Button>
            {user ? (
              <Button asChild variant="ghost" size="sm">
                <Link to="/compare">Compare</Link>
              </Button>
            ) : null}
            {user ? (
              <Button asChild variant="ghost" size="sm">
                <Link to="/calibrate">Calibrate</Link>
              </Button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-4 px-4 py-4">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="metric-value rounded-full bg-signal/10 px-2 py-0.5 text-[11px] text-signal">
            {activeMode.label} mode
          </span>
          <span>{activeMode.blurb}</span>
        </div>
        {monitor.error ? (
          <div className="panel border-critical/60 px-4 py-3 text-sm text-critical">
            {monitor.error}
          </div>
        ) : null}

        {seizureAlert ? (
          <div
            className={cn(
              "panel flex items-center gap-3 px-4 py-3",
              icuMode ? "alert-pulse border-critical" : "border-caution/60",
            )}
          >
            <TriangleAlert className={cn("size-5", icuMode ? "text-critical" : "text-caution")} />
            <div>
              <p
                className={cn(
                  "text-sm font-semibold",
                  icuMode ? "text-critical" : "text-caution",
                )}
              >
                {icuMode
                  ? "Possible seizure activity — review the raw trace"
                  : "Rhythmic activity flagged — review when convenient"}
              </p>
              <p className="text-xs text-muted-foreground">
                Sustained rhythmic discharges detected. Score {latest?.seizureScore.toFixed(2)}.
              </p>
            </div>
          </div>
        ) : null}

        {/* Density spectral array */}
        <section className="panel overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2.5">
            <h1 className="text-sm font-semibold">Density spectral array</h1>
            <DsaLegend />
            <div className="ml-auto flex items-center gap-2">
              <Select
                value={monitor.channel}
                onValueChange={(v) => monitor.setChannel(v as typeof monitor.channel)}
              >
                <SelectTrigger className="w-[150px]">
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
                <SelectTrigger className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">5 min</SelectItem>
                  <SelectItem value="10">10 min</SelectItem>
                  <SelectItem value="30">30 min</SelectItem>
                  <SelectItem value="60">60 min</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="relative h-[320px] bg-[rgb(8,16,34)] md:h-[380px]">
            <DsaChart epochs={monitor.epochs} windowSeconds={windowMinutes * 60} />
            {/* Clinician markers, positioned by time across the visible window */}
            {markers.map((m, i) => {
              const age = monitor.elapsed - m.t;
              if (age > windowMinutes * 60) return null;
              const left = (1 - age / (windowMinutes * 60)) * 100;
              return (
                <div
                  key={`${m.t}-${i}`}
                  className="pointer-events-none absolute top-0 bottom-0 z-10"
                  style={{ left: `${left}%` }}
                >
                  <div className="h-full w-px bg-marker/80" />
                  <span
                    className={cn(
                      "metric-value absolute top-1 max-w-[150px] truncate rounded bg-marker/20 px-1 py-0.5 text-[10px] whitespace-nowrap text-marker",
                      left > 65 ? "right-1" : "left-1",
                    )}
                  >
                    {m.detail}
                  </span>
                </div>
              );
            })}
            {!monitor.epochs.length ? (
              <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-muted-foreground">
                Connect a Muse 2 headband to start building the spectrogram — or run the demo signal
                to see anaesthesia, burst suppression and ictal patterns.
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
          <div className="border-t border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                Mark event
              </span>
              {MARKER_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => addMarker(preset)}
                  disabled={!streaming}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-foreground transition-colors hover:border-marker hover:text-marker disabled:opacity-40"
                >
                  {preset}
                </button>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Input
                value={markerText}
                disabled={!streaming}
                placeholder="Custom marker — e.g. “ketamine 30 mg”, “facial twitching noted”"
                className="h-9 max-w-sm"
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
                disabled={!streaming || !markerText.trim()}
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
                  <span className="metric-value text-[11px] text-muted-foreground">
                    {markers.length} marker{markers.length === 1 ? "" : "s"} this session
                  </span>
                </>
              ) : (
                <span className="text-[11px] text-muted-foreground">
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
                      <span className="metric-value text-[11px] opacity-80">
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
        </section>

        {/* Metrics */}
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          {(() => {
            const tiles: Record<string, React.ReactNode> = {
              depth: (
                <MetricTile
                  key="depth"
                  label="Depth index (OpenIBIS)"
                  value={latest?.depth.index != null ? String(latest.depth.index) : "—"}
                  hint={
                    latest
                      ? latest.depth.held
                        ? `Held ${latest.depth.heldSeconds.toFixed(0)}s — ${
                            latest.depth.gateReasons[0] ?? "artefact"
                          }`
                        : DEPTH_STATE_LABEL[latest.depth.state]
                      : "OpenIBIS algorithm · ±10 units vs reference"
                  }
                  tone={latest && !latest.depth.held ? depthTone(latest.depth.state) : "default"}
                  confidence={latest?.confidence.depth}
                />
              ),
              sr: (
                <MetricTile
                  key="sr"
                  label={`Suppression ratio (${monitor.settings.srWindowSeconds}s)`}
                  value={latest ? latest.suppressionRatio.toFixed(0) : "—"}
                  unit="%"
                  tone={srTone as never}
                  hint={`Peak ${summary.maxSr.toFixed(0)} %`}
                  confidence={latest?.confidence.suppression}
                />
              ),
              time: (
                <MetricTile
                  key="time"
                  label="Suppression time"
                  value={formatDuration(summary.suppressionSeconds).split(" ")[0] ?? "0"}
                  unit={summary.suppressionSeconds < 60 ? "s" : "min"}
                  hint={`Total ${formatDuration(summary.suppressionSeconds)}`}
                  tone={summary.suppressionSeconds > 0 ? "caution" : "default"}
                  confidence={latest?.confidence.suppression}
                />
              ),
              seizure: (
                <MetricTile
                  key="seizure"
                  label="Seizure score"
                  value={latest ? latest.seizureScore.toFixed(2) : "—"}
                  tone={
                    seizureAlert
                      ? icuMode
                        ? "critical"
                        : "caution"
                      : latest && latest.seizureScore > 0.4 && icuMode
                        ? "caution"
                        : "default"
                  }
                  hint={
                    icuMode
                      ? `${summary.seizureAlerts} event(s) — high sensitivity`
                      : `${summary.seizureAlerts} event(s) — background watch`
                  }
                  pulse={seizureAlert && icuMode}
                  confidence={latest?.confidence.seizure}
                />
              ),
              sef: (
                <MetricTile
                  key="sef"
                  label="Spectral edge 95"
                  value={latest ? latest.sef95.toFixed(1) : "—"}
                  unit="Hz"
                  hint="Frequency below which 95 % of power sits"
                  confidence={latest?.confidence.spectral}
                />
              ),
              amp: (
                <MetricTile
                  key="amp"
                  label="Amplitude (p-p)"
                  value={latest ? latest.amplitudeUv.toFixed(0) : "—"}
                  unit="µV"
                  hint={latest?.artifact ? "Artefact suspected" : "Peak in current epoch"}
                  tone={latest?.artifact ? "caution" : "default"}
                  confidence={latest?.confidence.spectral}
                />
              ),
              entropy: (
                <MetricTile
                  key="entropy"
                  label="Spectral entropy (state)"
                  value={latest ? latest.entropy.state.toFixed(2) : "—"}
                  hint={
                    latest
                      ? `Response ${latest.entropy.response.toFixed(2)} · SE95 ${latest.entropy.se95.toFixed(2)} · Shannon ${latest.entropy.shannon.toFixed(2)}`
                      : "Normalised Shannon entropy of the PSD"
                  }
                  tone={latest && latest.entropy.state > 0.9 ? "caution" : "default"}
                  confidence={latest?.confidence.spectral}
                />
              ),
              dar: (
                <MetricTile
                  key="dar"
                  label="Delta / alpha ratio"
                  value={latest ? latest.ratios.deltaAlpha.toFixed(2) : "—"}
                  hint={
                    latest
                      ? `Theta/alpha ${latest.ratios.thetaAlpha.toFixed(2)} — rises with slowing`
                      : "Rises with deepening anaesthesia and encephalopathy"
                  }
                  confidence={latest?.confidence.spectral}
                />
              ),
              bar: (
                <MetricTile
                  key="bar"
                  label="Beta / alpha ratio"
                  value={latest ? latest.ratios.betaAlpha.toFixed(2) : "—"}
                  hint="Rises with light anaesthesia and benzodiazepine beta"
                  confidence={latest?.confidence.spectral}
                />
              ),
            };
            const order = icuMode
              ? ["seizure", "sr", "time", "depth", "sef", "entropy", "dar", "bar", "amp"]
              : ["depth", "sef", "entropy", "sr", "time", "dar", "bar", "amp", "seizure"];
            return order.map((k) => tiles[k]);
          })()}
        </section>

        <SignalQualityPanel
          quality={latest?.quality ?? null}
          channels={MUSE_CHANNELS}
          channelQuality={monitor.channelQuality}
          usableFraction={summary.usableFraction}
          depthArtifact={latest?.depthArtifact ?? null}
          depthGatedFraction={latest?.depth.gatedFraction}
        />

        <AiInsightPanel
          result={aiResult}
          loading={aiLoading}
          error={aiError}
          epochCount={monitor.epochs.length}
          onRun={handleAnalyse}
        />

        <section className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            <div className="panel overflow-hidden">
              <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
                <h2 className="text-sm font-semibold">Filtered EEG · last 4 s</h2>
                <span className="metric-value text-[11px] text-muted-foreground">
                  0.5–45 Hz, 50 Hz notch · ±80 µV
                </span>
                <div className="ml-auto flex gap-1.5">
                  {MUSE_CHANNELS.map((c) => (
                    <span
                      key={c}
                      className={cn(
                        "metric-value rounded px-1.5 py-0.5 text-[10px]",
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

            <div className="panel px-4 py-4">
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
                        onClick={() => monitor.setSettings({ ...p.settings })}
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
                      monitor.setSettings({ ...monitor.settings, suppressionThresholdUv: v ?? 8 })
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
                    <span className="metric-value">−{monitor.settings.depthDropUnits} units</span>
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
                    <span className="metric-value">+{monitor.settings.depthRiseUnits} units</span>
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
                    <span className="metric-value">{monitor.settings.bsrAlertPercent} % SR</span>
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

          <div className="panel overflow-hidden">
            <div className="border-b border-border px-4 py-2.5">
              <h2 className="text-sm font-semibold">Event log</h2>
            </div>
            <div className="max-h-[430px] overflow-y-auto">
              <EventLog events={allEvents} />
            </div>
          </div>
        </section>

        <p className="pb-6 text-xs text-muted-foreground">
          Research and education tool. The Muse 2 is a consumer device and CortexTrace is not a
          certified medical device — never use these numbers as the sole basis for a clinical
          decision.
        </p>
      </main>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save anonymised session</DialogTitle>
            <DialogDescription>
              Only the case code you type here is stored — no names, dates of birth or hospital
              numbers. Use a code that cannot identify the patient outside your own records.
            </DialogDescription>
          </DialogHeader>
          {user ? (
            <div className="space-y-3">
              <div>
                <Label htmlFor="case">Anonymised case code</Label>
                <Input
                  id="case"
                  className="mt-1.5"
                  placeholder="e.g. GA-2026-014"
                  value={meta.caseCode}
                  onChange={(e) => setMeta({ ...meta, caseCode: e.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>Context</Label>
                  <Select
                    value={meta.context}
                    onValueChange={(v) => setMeta({ ...meta, context: v })}
                  >
                    <SelectTrigger className="mt-1.5 w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTEXTS.map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="loc">Location</Label>
                  <Input
                    id="loc"
                    className="mt-1.5"
                    placeholder="Theatre 4 / ICU bed 7"
                    value={meta.location}
                    onChange={(e) => setMeta({ ...meta, location: e.target.value })}
                  />
                </div>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="age">Age (years)</Label>
                  <Input
                    id="age"
                    type="number"
                    min={0}
                    max={120}
                    className="mt-1.5"
                    placeholder="e.g. 68"
                    value={meta.ageYears}
                    onChange={(e) => setMeta({ ...meta, ageYears: e.target.value })}
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Ages of 90 and over are stored as a “90+” band only.
                  </p>
                </div>
                <div>
                  <Label>Sex</Label>
                  <Select value={meta.sex} onValueChange={(v) => setMeta({ ...meta, sex: v })}>
                    <SelectTrigger className="mt-1.5 w-full">
                      <SelectValue placeholder="Select" />
                    </SelectTrigger>
                    <SelectContent>
                      {SEX_OPTIONS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label htmlFor="dx">Admission diagnosis</Label>
                <Input
                  id="dx"
                  className="mt-1.5"
                  placeholder="e.g. community-acquired pneumonia"
                  value={meta.admissionDiagnosis}
                  onChange={(e) => setMeta({ ...meta, admissionDiagnosis: e.target.value })}
                />
              </div>
              <div>
                <Label>Admission / clinical features</Label>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {CLINICAL_FEATURES.map((f) => {
                    const on = meta.clinicalFeatures.includes(f);
                    return (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={on}
                        onClick={() =>
                          setMeta({
                            ...meta,
                            clinicalFeatures: on
                              ? meta.clinicalFeatures.filter((x) => x !== f)
                              : [...meta.clinicalFeatures, f],
                          })
                        }
                        className={cn(
                          "rounded-full border px-2.5 py-1 text-xs transition-colors",
                          on
                            ? "border-signal bg-signal/15 text-signal"
                            : "border-border text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <Label htmlFor="notes">Notes</Label>
                <Textarea
                  id="notes"
                  className="mt-1.5"
                  placeholder="Agent, infusion rates, clinical events…"
                  value={meta.notes}
                  onChange={(e) => setMeta({ ...meta, notes: e.target.value })}
                />
              </div>
              <p className="metric-value text-[11px] text-muted-foreground">
                {monitor.epochs.length} epochs · {formatClock(monitor.elapsed)} ·{" "}
                {allEvents.length} events ({markers.length} clinician markers)
              </p>
            </div>
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
    </div>
  );
}
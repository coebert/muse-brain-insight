import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import type { Epoch } from "@/lib/eeg/analysis";
import { formatClock } from "@/lib/eeg/format";
import { AlarmTone } from "@/lib/eeg/alarms";
import {
  buildTrendDigest,
  computeSeizureTrend,
  DEFAULT_SEIZURE_TREND,
  EMPTY_TREND,
  loadSeizureTrendPrefs,
  RISK_HYSTERESIS,
  saveSeizureTrendPrefs,
  type SeizureTrendPrefs,
  type SeizureTrendState,
  type SeizureTrendTrigger,
} from "@/lib/eeg/seizure-trend";
import {
  assessSeizureTrend,
  type SeizureTrendAssessment,
} from "@/lib/eeg/seizure-trend.functions";

/** One fired trend crossing, with its AI read once it arrives. */
export interface SeizureTrendAlert {
  id: string;
  trigger: SeizureTrendTrigger;
  /** Session seconds at which the threshold was crossed. */
  t: number;
  risk: number;
  risePerMinute: number;
  quality: number;
  /** AI interpretation, null while pending or when AI is off/failed. */
  assessment: SeizureTrendAssessment | null;
  aiState: "off" | "pending" | "ready" | "error";
  aiError?: string;
}

interface Options {
  epochs: Epoch[];
  enabled: boolean;
  /** "anaesthesia" | "icu" — shapes the AI read. */
  mode: string;
  /** Clinician markers, for context in the AI digest. */
  markers: { t: number; detail: string }[];
  /** Anonymised patient context passed to the AI. */
  patient?: unknown;
  /** Called when a crossing is confirmed, for the session timeline. */
  onAlert?: (alert: SeizureTrendAlert) => void;
  /** Called when the AI read for a crossing arrives. */
  onAssessment?: (alert: SeizureTrendAlert) => void;
}

/**
 * Real-time alerting when the smoothed seizure-risk trend crosses the
 * clinician's configured thresholds — either sustained above the risk level for
 * the dwell time, or rising faster than the configured rate. Each crossing
 * raises an immediate visual/audible alert and (optionally) asks the AI for a
 * short interpretation, rate-limited by a cooldown.
 */
export function useSeizureRiskAlerts({
  epochs,
  enabled,
  mode,
  markers,
  patient,
  onAlert,
  onAssessment,
}: Options) {
  const [prefs, setPrefsState] = useState<SeizureTrendPrefs>(DEFAULT_SEIZURE_TREND);
  const [hydrated, setHydrated] = useState(false);
  const [alerts, setAlerts] = useState<SeizureTrendAlert[]>([]);

  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const markersRef = useRef(markers);
  markersRef.current = markers;
  const patientRef = useRef(patient);
  patientRef.current = patient;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;
  const onAssessmentRef = useRef(onAssessment);
  onAssessmentRef.current = onAssessment;
  const toneRef = useRef<AlarmTone | null>(null);
  toneRef.current ??= new AlarmTone();

  /** Latched so a sustained excursion alerts once, not every epoch. */
  const armedRef = useRef({ sustained: true, rising: true });
  /** Session time of the last AI assessment, for the cooldown. */
  const lastAiAtRef = useRef<number | null>(null);

  useEffect(() => {
    setPrefsState(loadSeizureTrendPrefs());
    setHydrated(true);
  }, []);

  const setPrefs = useCallback((patch: Partial<SeizureTrendPrefs>) => {
    setPrefsState((prev) => {
      const next = { ...prev, ...patch };
      saveSeizureTrendPrefs(next);
      return next;
    });
  }, []);

  const trend: SeizureTrendState = useMemo(
    () => (enabled ? computeSeizureTrend(epochs, prefs) : EMPTY_TREND),
    [epochs, prefs, enabled],
  );
  const trendRef = useRef(trend);
  trendRef.current = trend;
  const epochsRef = useRef(epochs);
  epochsRef.current = epochs;

  const clear = useCallback(() => {
    setAlerts([]);
    armedRef.current = { sustained: true, rising: true };
    lastAiAtRef.current = null;
  }, []);

  const dismiss = useCallback((id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  /** Fires one alert and, when allowed, the AI read behind it. */
  const raise = useCallback((trigger: SeizureTrendTrigger, snapshot: SeizureTrendState) => {
    const p = prefsRef.current;
    const id = `${trigger}-${snapshot.t.toFixed(0)}`;
    const aiAllowed =
      p.aiEnabled &&
      (lastAiAtRef.current === null || snapshot.t - lastAiAtRef.current >= p.cooldownSeconds);
    const alert: SeizureTrendAlert = {
      id,
      trigger,
      t: snapshot.t,
      risk: snapshot.risk,
      risePerMinute: snapshot.risePerMinute,
      quality: snapshot.quality,
      assessment: null,
      aiState: aiAllowed ? "pending" : "off",
    };
    setAlerts((prev) => [...prev.filter((a) => a.id !== id), alert].slice(-6));
    onAlertRef.current?.(alert);

    const title =
      trigger === "sustained"
        ? "Seizure risk above threshold"
        : "Seizure risk rising rapidly";
    const description =
      trigger === "sustained"
        ? `Risk ${(snapshot.risk * 100).toFixed(0)} % ≥ ${(p.riskThreshold * 100).toFixed(0)} % for ${Math.round(snapshot.aboveSeconds)} s · ${formatClock(snapshot.t)}`
        : `Rising ${(snapshot.risePerMinute * 100).toFixed(0)} %/min (limit ${(p.riseThreshold * 100).toFixed(0)} %/min) · ${formatClock(snapshot.t)}`;
    toast.error(title, { description, duration: 12000 });
    toneRef.current?.notify("seizure");

    if (!aiAllowed) return;
    lastAiAtRef.current = snapshot.t;
    const digest = buildTrendDigest({
      trigger,
      trend: snapshot,
      prefs: p,
      epochs: epochsRef.current,
      mode: modeRef.current,
      markers: markersRef.current,
    });
    void assessSeizureTrend({ data: { digest, patient: patientRef.current } })
      .then((assessment) => {
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, assessment, aiState: "ready" } : a)),
        );
        onAssessmentRef.current?.({ ...alert, assessment, aiState: "ready" });
        toast.message(assessment.headline, {
          description: `AI read · ${assessment.likelihood} · ${assessment.confidence} confidence`,
          duration: 14000,
        });
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : "AI assessment failed.";
        setAlerts((prev) =>
          prev.map((a) => (a.id === id ? { ...a, aiState: "error", aiError: message } : a)),
        );
      });
  }, []);

  // Threshold state machine — evaluated once per new epoch.
  useEffect(() => {
    if (!enabled || !hydrated || !prefs.enabled) return;
    const t = trend;
    if (t.samples < 2) return;

    // Sustained: above the risk threshold for at least the dwell time.
    if (t.risk >= prefs.riskThreshold && t.aboveSeconds >= prefs.dwellSeconds) {
      if (armedRef.current.sustained) {
        armedRef.current.sustained = false;
        raise("sustained", t);
      }
    } else if (t.risk < prefs.riskThreshold - RISK_HYSTERESIS) {
      armedRef.current.sustained = true;
    }

    // Rising: escalating faster than the configured rate, even below the level.
    if (t.risePerMinute >= prefs.riseThreshold && t.risk >= prefs.riskThreshold / 2) {
      if (armedRef.current.rising) {
        armedRef.current.rising = false;
        raise("rising", t);
      }
    } else if (t.risePerMinute < prefs.riseThreshold * 0.5) {
      armedRef.current.rising = true;
    }
  }, [trend, prefs, enabled, hydrated, raise]);

  // Leaving the case resets the latches so the next case starts clean.
  useEffect(() => {
    if (!enabled) {
      armedRef.current = { sustained: true, rising: true };
      lastAiAtRef.current = null;
    }
  }, [enabled]);

  return { prefs, setPrefs, trend, alerts, dismiss, clear, hydrated };
}

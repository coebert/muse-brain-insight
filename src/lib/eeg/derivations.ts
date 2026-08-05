import type { MetricTone } from "@/components/monitor/MetricCard";
import type { DsaMarker } from "@/components/monitor/DsaMarkerRail";
import type { AlarmCondition } from "@/hooks/useAlarms";
import type { HemiLatest } from "@/hooks/useEegMonitor";
import type { DetectedEvent, Epoch } from "@/lib/eeg/analysis";
import { deriveAlarmConditions } from "@/lib/eeg/alarm-conditions";
import { buildDsaMarkers } from "@/lib/eeg/dsa-markers";
import { computeUncertainty, type UncertaintyReport } from "@/lib/eeg/uncertainty";

/** Suppression ratio (%) at which the readout turns critical. */
export const DEEP_SUPPRESSION_PERCENT = 40;
/** Suppression ratio (%) at which the readout turns cautionary. */
export const EARLY_SUPPRESSION_PERCENT = 10;

/** Shared suppression-ratio colouring used by every SR readout in the app. */
export function suppressionTone(ratio: number | null | undefined): MetricTone {
  if (ratio == null) return "default";
  if (ratio >= DEEP_SUPPRESSION_PERCENT) return "critical";
  if (ratio >= EARLY_SUPPRESSION_PERCENT) return "caution";
  return "signal";
}

export interface ClinicalDerivationInput {
  /** Every epoch produced by the analyser so far. */
  epochs: Epoch[];
  /** Detector-generated events (alerts, trend crossings, audit entries). */
  events: DetectedEvent[];
  /** Clinician annotations placed during the case. */
  markers: DetectedEvent[];
  /** Latest per-hemisphere metrics, when bilateral montage data is available. */
  hemi: HemiLatest | null;
  settings: {
    srWindowSeconds: number;
    seizureThreshold: number;
    bsrAlertPercent: number;
  };
  /** ICU mode escalates ictal alarms and AI emphasis. */
  icuMode: boolean;
  /** Seconds since the last usable sample arrived. */
  dataGapSeconds: number;
  reconnecting: boolean;
  reconnectAttempt?: { attempt: number; attempts: number } | null;
}

/** Headline live numbers shared by the action bar, tiles and AI panels. */
export interface LiveClinicalValues {
  depthIndex: number | null;
  suppressionRatio: number | null;
  seizureScore: number | null;
  /** Signal quality index as a whole percentage. */
  sqi: number | null;
}

export interface ClinicalDerivations {
  latest: Epoch | null;
  seizureAlert: boolean;
  /** Detector events and clinician markers merged in time order. */
  allEvents: DetectedEvent[];
  /** Labelled marks for the DSA rail. */
  dsaMarkers: DsaMarker[];
  /** Confidence intervals and contributing factors for the headline metrics. */
  uncertainty: UncertaintyReport;
  /** Bedside alarm conditions for the current epoch and stream health. */
  alarmConditions: AlarmCondition[];
  live: LiveClinicalValues;
  /** Tone for suppression-ratio readouts. */
  srTone: MetricTone;
}

/**
 * Single source of truth for the derived clinical outputs consumed by the
 * alarm engine, the DSA marker rail and the AI panels. Pure so the same
 * inputs always produce the same clinical picture across every view.
 */
export function deriveClinical(input: ClinicalDerivationInput): ClinicalDerivations {
  const { epochs, events, markers, hemi, settings, icuMode } = input;
  const latest = epochs.length ? (epochs[epochs.length - 1] ?? null) : null;

  return {
    latest,
    seizureAlert: latest?.seizureAlert ?? false,
    allEvents: [...events, ...markers].sort((a, b) => a.t - b.t),
    dsaMarkers: buildDsaMarkers(events, markers),
    uncertainty: computeUncertainty(epochs, {
      srWindowSeconds: settings.srWindowSeconds,
      seizureThreshold: settings.seizureThreshold,
    }),
    alarmConditions: deriveAlarmConditions({
      latest,
      hemi,
      icuMode,
      bsrAlertPercent: settings.bsrAlertPercent,
      dataGapSeconds: input.dataGapSeconds,
      reconnecting: input.reconnecting,
      ...(input.reconnectAttempt !== undefined ? { reconnectAttempt: input.reconnectAttempt } : {}),
    }),
    live: {
      depthIndex: latest?.depth.index ?? null,
      suppressionRatio: latest ? Math.round(latest.suppressionRatio) : null,
      seizureScore: latest?.seizureScore ?? null,
      sqi: latest?.quality ? Math.round(latest.quality.score * 100) : null,
    },
    srTone: suppressionTone(latest?.suppressionRatio ?? null),
  };
}

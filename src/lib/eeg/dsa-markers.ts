import type { DsaMarker } from "@/components/monitor/DsaMarkerRail";
import type { DetectedEvent } from "@/lib/eeg/analysis";
import { formatClock } from "@/lib/eeg/format";

/**
 * Trend alerts, depth-window crossings, seizure suspicions and clinician
 * annotations, laid out as labelled marks for the DSA rail.
 */
export function buildDsaMarkers(events: DetectedEvent[], markers: DetectedEvent[]): DsaMarker[] {
  const alerts = events
    .filter(
      (e) => e.kind === "depth_drop" || e.kind === "depth_rise" || e.kind === "suppression_burden",
    )
    .map<DsaMarker>((e) => ({
      t: e.t,
      label: `${
        e.kind === "depth_drop" ? "Depth ↓" : e.kind === "depth_rise" ? "Depth ↑" : "BSR"
      } ${formatClock(e.t)}`,
      tone: e.severity === "critical" ? "critical" : "caution",
    }));

  // Depth-window crossings: when OpenIBIS left or re-entered the target band.
  const windowCrossings = events
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

  // Seizure suspicions carry their interpretable confidence on the rail label
  // so the DSA shows how much to trust each flag without opening the log.
  const seizures = events
    .filter((e) => e.kind === "seizure")
    .map<DsaMarker>((e) => ({
      t: e.t,
      label: e.evidence
        ? `Seizure? ${(e.evidence.confidence * 100).toFixed(0)} % conf`
        : `Seizure? ${formatClock(e.t)}`,
      tone: e.severity === "critical" ? "critical" : "caution",
    }));

  return [...alerts, ...windowCrossings, ...seizures, ...annotations];
}
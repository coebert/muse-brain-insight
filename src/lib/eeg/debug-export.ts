/**
 * Debug exports for protocol and signal-chain troubleshooting.
 *
 * Two very different questions get answered from the same session:
 *
 *   * "Is the headband actually delivering packets, and what do they contain?"
 *     — answered by the timestamped packet inspector rows.
 *   * "Did the packets turn into sensible spectra and suppression signals?"
 *     — answered by the parsed epoch frames exported here, which carry the
 *     same numbers the DSA and the suppression clock are drawn from.
 *
 * Everything is anonymous: no case identifiers, demographics or notes are
 * included, only device-level and signal-level values.
 */

import type { Epoch } from "@/lib/eeg/analysis";
import {
  bleDiagnosticJson,
  formatBleDiagnosticText,
  packetsToCsv,
  type BleLogEntry,
  type BlePacketRecord,
} from "@/lib/eeg/ble-diagnostics";
import { getLastDeviceInformation } from "@/lib/eeg/ble-eeg";
import {
  buildExportMeta,
  validateDiagnosticExport,
  type DiagnosticExportCheck,
  type DiagnosticExportKind,
  type ExportMeta,
} from "@/lib/eeg/export-schema";

export interface DebugSessionMeta {
  deviceLabel: string;
  sampleRate: number;
  startedAt: number | null;
  dsaMinHz: number;
  dsaMaxHz: number;
}

/** Patient-safe export header shared by every diagnostic file. */
export function debugExportMeta(kind: DiagnosticExportKind, meta?: DebugSessionMeta): ExportMeta {
  return buildExportMeta({
    kind,
    deviceLabel: meta?.deviceLabel,
    deviceInfo: getLastDeviceInformation(),
    sampleRate: meta?.sampleRate ?? null,
    startedAt: meta?.startedAt ?? null,
  });
}

/** Per-epoch spectral and suppression signals, one row per analysed second. */
export function epochsToCsv(epochs: Epoch[], meta: DebugSessionMeta): string {
  const binCount = epochs[0]?.spectrum.length ?? 0;
  const step = binCount > 1 ? (meta.dsaMaxHz - meta.dsaMinHz) / (binCount - 1) : 0;
  const binHeaders = Array.from({ length: binCount }, (_, i) =>
    `db_${(meta.dsaMinHz + i * step).toFixed(1)}hz`,
  );
  const header = [
    "t_seconds",
    "amplitude_uv",
    "total_power",
    "sef95",
    "sef95_raw",
    "epoch_suppression",
    "is_suppressed",
    "suppression_ratio_pct",
    "seizure_score",
    "seizure_alert",
    "depth",
    "artifact",
    "gap_affected",
    "quality_grade",
    "delta",
    "theta",
    "alpha",
    "beta",
    "gamma",
    ...binHeaders,
  ].join(",");

  const rows = epochs.map((e) =>
    [
      e.t,
      e.amplitudeUv.toFixed(2),
      e.totalPower.toFixed(4),
      e.sef95.toFixed(2),
      e.sef95Raw.toFixed(2),
      e.epochSuppression.toFixed(4),
      e.isSuppressed ? 1 : 0,
      e.suppressionRatio.toFixed(2),
      e.seizureScore.toFixed(4),
      e.seizureAlert ? 1 : 0,
      typeof e.depth?.index === "number" ? e.depth.index.toFixed(1) : "",
      e.artifact ? 1 : 0,
      e.gapAffected ? 1 : 0,
      e.quality?.grade ?? "",
      e.bands.delta.toFixed(4),
      e.bands.theta.toFixed(4),
      e.bands.alpha.toFixed(4),
      e.bands.beta.toFixed(4),
      e.bands.gamma.toFixed(4),
      ...e.spectrum.map((v) => (Number.isFinite(v) ? v.toFixed(2) : "")),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

/** Full-fidelity JSON of the same frames, for offline replay and diffing. */
export function debugSessionJson(
  epochs: Epoch[],
  meta: DebugSessionMeta,
  packets: BlePacketRecord[] = [],
  log: BleLogEntry[] = [],
): string {
  return JSON.stringify(
    {
      meta: debugExportMeta("debug-session", meta),
      exportedAt: new Date().toISOString(),
      device: meta.deviceLabel,
      sampleRate: meta.sampleRate,
      startedAt: meta.startedAt,
      spectrum: { minHz: meta.dsaMinHz, maxHz: meta.dsaMaxHz, bins: epochs[0]?.spectrum.length ?? 0 },
      frames: epochs.map((e) => ({
        t: e.t,
        spectrum: e.spectrum,
        bands: e.bands,
        sef95: e.sef95,
        sef95Raw: e.sef95Raw,
        amplitudeUv: e.amplitudeUv,
        epochSuppression: e.epochSuppression,
        isSuppressed: e.isSuppressed,
        suppressionRatio: e.suppressionRatio,
        seizureScore: e.seizureScore,
        seizureAlert: e.seizureAlert,
        depth: e.depth?.index ?? null,
        artifact: e.artifact,
        gapAffected: e.gapAffected,
        qualityGrade: e.quality?.grade ?? null,
      })),
      packets,
      connectionLog: log,
    },
    null,
    2,
  );
}

/** Suppression-only trace, handy for quick plotting against a reference. */
export function suppressionToCsv(epochs: Epoch[]): string {
  const header =
    "t_seconds,epoch_suppression,is_suppressed,suppression_ratio_pct,amplitude_uv,artifact,gap_affected";
  const rows = epochs.map((e) =>
    [
      e.t,
      e.epochSuppression.toFixed(4),
      e.isSuppressed ? 1 : 0,
      e.suppressionRatio.toFixed(2),
      e.amplitudeUv.toFixed(2),
      e.artifact ? 1 : 0,
      e.gapAffected ? 1 : 0,
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

export { formatBleDiagnosticText, bleDiagnosticJson, packetsToCsv };

/**
 * Validates a JSON export before it is written out, so a malformed or
 * un-replayable capture is caught on the device rather than offline.
 */
export function checkJsonExport(contents: string): DiagnosticExportCheck {
  return validateDiagnosticExport(contents);
}

function triggerBrowserDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Saves a debug export from desktop browsers and iOS Web Bluetooth browsers.
 * Safari-derived browsers commonly ignore programmatic Blob downloads, so on
 * touch Apple devices the native share sheet is used to expose “Save to Files”.
 */
export async function downloadDebugFile(filename: string, contents: string, mime: string) {
  const blob = new Blob([contents], { type: `${mime};charset=utf-8` });
  const file = new File([blob], filename, { type: blob.type });
  const shareData: ShareData = { files: [file], title: filename };
  const isAppleTouchDevice =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  if (isAppleTouchDevice && navigator.share) {
    let canShareFile = true;
    try {
      canShareFile = !navigator.canShare || navigator.canShare(shareData);
    } catch {
      canShareFile = false;
    }
    if (canShareFile) {
      try {
        await navigator.share(shareData);
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
  }

  triggerBrowserDownload(filename, blob);
}

export function debugFilename(kind: string, extension: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return `cortextrace-${kind}-${stamp}.${extension}`;
}

import {
  autoScaleUvPerCount,
  decodePacket,
  detectPacketFormat,
  type FormatDetection,
  type PacketFormat,
} from "@/lib/eeg/ble-eeg";
import type { BleLogEntry, BlePacketRecord } from "@/lib/eeg/ble-diagnostics";
import {
  validateDiagnosticExport,
  type DiagnosticExportCheck,
  type ExportMeta,
} from "@/lib/eeg/export-schema";

interface ReplayExport {
  entries?: unknown;
  connectionLog?: unknown;
  packets?: unknown;
}

export interface BleReplayResult {
  packetCount: number;
  sourceCount: number;
  byteCount: number;
  format: PacketFormat | null;
  candidates: FormatDetection[];
  decodedSamples: number;
  uvPerCount: number | null;
  durationMs: number;
  warnings: string[];
  /** Schema/readiness verdict for the imported file. */
  check: DiagnosticExportCheck;
  /** Patient-safe metadata embedded by the exporting app, when present. */
  meta: ExportMeta | null;
}

function hexToBytes(value: string): Uint8Array | null {
  if (value.includes("…")) return null;
  const compact = value.replace(/\s+/g, "").trim();
  if (!compact || compact.length % 2 || !/^[0-9a-f]+$/i.test(compact)) return null;
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function packetSource(entry: BleLogEntry): string {
  return entry.message.split(" — ")[0]?.trim() || "unknown";
}

/** Parses both BLE-log JSON and the combined debug-session JSON export. */
export function parseBleReplayExport(text: string): Array<{ at: number; source: string; bytes: Uint8Array }> {
  const parsed = JSON.parse(text) as ReplayExport;
  const entries = Array.isArray(parsed.entries)
    ? (parsed.entries as BleLogEntry[])
    : Array.isArray(parsed.connectionLog)
      ? (parsed.connectionLog as BleLogEntry[])
      : [];
  const fromLog = entries.flatMap((entry) => {
    if (entry.kind !== "packet") return [];
    const bytes = hexToBytes(entry.rawHex ?? entry.hex ?? "");
    return bytes ? [{ at: Number(entry.at) || 0, source: packetSource(entry), bytes }] : [];
  });
  if (fromLog.length) return fromLog;

  const packets = Array.isArray(parsed.packets) ? (parsed.packets as BlePacketRecord[]) : [];
  return packets.flatMap((packet) => {
    const bytes = hexToBytes(packet.hex ?? "");
    return bytes ? [{ at: Number(packet.at) || 0, source: packet.source || "unknown", bytes }] : [];
  });
}

/** Re-runs the same format ranking and packet decoders used by live discovery. */
export function replayBleDiagnostic(text: string): BleReplayResult {
  const check = validateDiagnosticExport(text);
  if (check.replayablePackets === 0) {
    throw new Error(
      check.level === "invalid" && check.issues.some((issue) => !/metadata|schema v/i.test(issue))
        ? `Malformed capture — ${check.issues.find((issue) => !/metadata|schema v/i.test(issue))}`
        : "This file contains no complete raw notification packets.",
    );
  }
  const packets = parseBleReplayExport(text);
  if (!packets.length) throw new Error("This file contains no complete raw notification packets.");
  const payloads = packets.map((packet) => packet.bytes);
  const candidates = detectPacketFormat(payloads);
  const best = candidates[0];
  let decoded: number[] = [];
  if (best?.format === "brainco-zenlite") {
    const byteCount = payloads.reduce((sum, bytes) => sum + bytes.length, 0);
    const joined = new Uint8Array(byteCount);
    let offset = 0;
    for (const bytes of payloads) {
      joined.set(bytes, offset);
      offset += bytes.length;
    }
    decoded = decodePacket(best.format, joined);
  } else if (best) {
    decoded = payloads.flatMap((bytes) => decodePacket(best.format, bytes));
  }
  const sources = new Set(packets.map((packet) => packet.source));
  const firstAt = packets[0]?.at ?? 0;
  const lastAt = packets[packets.length - 1]?.at ?? firstAt;
  const warnings: string[] = [];
  if (!best) warnings.push("No supported packet layout produced enough EEG-like samples.");
  warnings.push(...check.issues);
  if (packets.length >= 12) warnings.push("Capture may be sample-limited; retry with the latest app for complete replay data.");
  return {
    packetCount: packets.length,
    sourceCount: sources.size,
    byteCount: payloads.reduce((sum, bytes) => sum + bytes.length, 0),
    format: best?.format ?? null,
    candidates,
    decodedSamples: decoded.length,
    uvPerCount: best ? autoScaleUvPerCount(best.p95) : null,
    durationMs: Math.max(0, lastAt - firstAt),
    warnings,
    check,
    meta: check.meta,
  };
}
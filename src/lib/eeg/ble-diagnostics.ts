/**
 * Advanced BLE diagnostic logger.
 *
 * When an undocumented headband (Regul8/FocusCalm/BrainCo) refuses to stream,
 * the only way to move past guesswork is to see exactly what the browser saw:
 * which services and characteristics were discovered, which activation frames
 * were written, what came back, and the literal bytes of the first packets.
 *
 * The log is a small in-memory ring so it can never grow without bound during
 * a long case, and it is exportable as plain text or JSON so the clinician can
 * send it on from a phone.
 */

import { buildExportMeta, type ExportMeta } from "@/lib/eeg/export-schema";

export type BleLogKind =
  | "session"
  | "gatt"
  | "service"
  | "characteristic"
  | "command"
  | "response"
  | "packet"
  | "error"
  | "info";

/**
 * Stable context for a capture: which band, which firmware, and which
 * activation sequence was in flight. Stored once per session and again on
 * every acknowledgement, so an exported log can be interpreted months later
 * without the person reading it having to remember the hardware.
 */
export interface BleCaptureContext {
  deviceName?: string;
  deviceId?: string;
  manufacturer?: string;
  model?: string;
  firmwareVersion?: string;
  hardwareVersion?: string;
  serialNumber?: string;
  serviceUuid?: string;
  writeCharacteristicUuid?: string;
  notifyCharacteristicUuid?: string;
  sampleRateHz?: number;
  /** Activation sequence variant currently being tried. */
  variant?: string;
  /** Command inside that variant. */
  step?: string;
}

/** One firmware acknowledgement or error code, with its timing and context. */
export interface BleAckRecord {
  /** ms since the capture session started. */
  t: number;
  /** Wall-clock epoch milliseconds. */
  at: number;
  /** ISO timestamp, so the record is readable without conversion. */
  iso: string;
  characteristicUuid: string;
  command: string | null;
  sysResult: string | null;
  afeResult: string | null;
  ok: boolean;
  /** Activation variant in flight when the code arrived. */
  variant: string | null;
  /** Command in flight when the code arrived. */
  step: string | null;
  firmwareVersion: string | null;
  /** Raw frame bytes, when raw capture is enabled. */
  rawHex?: string;
}

export interface BleLogEntry {
  /** ms since the log session started. */
  t: number;
  at: number;
  kind: BleLogKind;
  message: string;
  /** Small structured payload; UUIDs, properties, counts. */
  data?: Record<string, unknown>;
  /** Hex dump of the raw bytes, when the entry carries a frame. */
  hex?: string;
  /** Complete payload for deterministic offline replay (hex, no truncation). */
  rawHex?: string;
  bytes?: number;
}

const MAX_ENTRIES = 1_200;
/** Acknowledgement codes retained per capture. */
const MAX_ACKS = 400;
/** Bytes kept per frame — enough to see framing, header and CRC. */
const MAX_HEX_BYTES = 64;
/** Raw packets logged per characteristic, so a live stream cannot flood it. */
const MAX_PACKETS_PER_SOURCE = 200;

export function toHex(bytes: Uint8Array, limit = MAX_HEX_BYTES): string {
  const slice = bytes.subarray(0, limit);
  let out = "";
  for (let i = 0; i < slice.length; i++) {
    out += slice[i]!.toString(16).padStart(2, "0");
    if (i < slice.length - 1) out += " ";
  }
  if (bytes.length > limit) out += ` … (+${bytes.length - limit} bytes)`;
  return out;
}

export class BleDiagnosticLog {
  private entries: BleLogEntry[] = [];
  private started = Date.now();
  private packetCounts = new Map<string, number>();
  private listeners = new Set<(entries: BleLogEntry[]) => void>();
  private acks: BleAckRecord[] = [];
  private context: BleCaptureContext = {};
  /** Off by default: raw bytes are only captured when the clinician asks. */
  enabled = false;

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.add("session", "Diagnostic capture enabled");
    else this.emit();
  }

  /** Starts a fresh capture for a new pairing attempt. */
  beginSession(label: string, context: BleCaptureContext = {}) {
    this.entries = [];
    this.packetCounts.clear();
    this.acks = [];
    this.context = { ...context };
    this.started = Date.now();
    this.add("session", `Connection attempt: ${label}`, {
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      ...this.context,
    });
  }

  /**
   * Merges newly discovered device/firmware or activation-sequence facts into
   * the capture context. Called as Device Information is read and as each
   * activation variant starts, so later acknowledgements are self-describing.
   */
  setContext(patch: BleCaptureContext) {
    const before = JSON.stringify(this.context);
    this.context = { ...this.context, ...patch };
    if (JSON.stringify(this.context) === before) return;
    this.add("info", "Capture context updated", { ...patch });
  }

  captureContext(): BleCaptureContext {
    return { ...this.context };
  }

  /**
   * Records a decoded firmware acknowledgement or error code alongside its
   * timestamp and the sequence that provoked it. These are kept in their own
   * list as well as the entry log so exports carry a clean, machine-readable
   * command/response history.
   */
  ack(input: {
    characteristicUuid: string;
    command: string | null;
    sysResult: string | null;
    afeResult: string | null;
    ok: boolean;
    variant?: string | null;
    step?: string | null;
    bytes?: Uint8Array;
  }): BleAckRecord {
    const at = Date.now();
    const record: BleAckRecord = {
      t: at - this.started,
      at,
      iso: new Date(at).toISOString(),
      characteristicUuid: input.characteristicUuid,
      command: input.command,
      sysResult: input.sysResult,
      afeResult: input.afeResult,
      ok: input.ok,
      variant: input.variant ?? this.context.variant ?? null,
      step: input.step ?? this.context.step ?? null,
      firmwareVersion: this.context.firmwareVersion ?? null,
    };
    if (this.enabled && input.bytes) record.rawHex = toHex(input.bytes, input.bytes.length);
    this.acks.push(record);
    if (this.acks.length > MAX_ACKS) this.acks.splice(0, this.acks.length - MAX_ACKS);
    this.add(
      "response",
      `Firmware ${record.ok ? "ack" : "error"}: ${record.command ?? "unknown command"} → ${
        [record.sysResult, record.afeResult].filter(Boolean).join(" / ") || "no code"
      }`,
      {
        command: record.command,
        sysResult: record.sysResult,
        afeResult: record.afeResult,
        ok: record.ok,
        variant: record.variant,
        step: record.step,
        firmwareVersion: record.firmwareVersion,
        characteristicUuid: record.characteristicUuid,
      },
    );
    return record;
  }

  /** Every acknowledgement/error code decoded during this capture. */
  allAcks(): BleAckRecord[] {
    return [...this.acks];
  }

  add(kind: BleLogKind, message: string, data?: Record<string, unknown>, bytes?: Uint8Array) {
    // Keep low-volume connection evidence automatically so a first failed
    // attempt is diagnosable. Raw packet/command bytes remain opt-in.
    if (!this.enabled && (kind === "packet" || bytes)) return;
    const entry: BleLogEntry = {
      t: Date.now() - this.started,
      at: Date.now(),
      kind,
      message,
    };
    if (data && Object.keys(data).length) entry.data = data;
    if (bytes) {
      entry.hex = toHex(bytes);
      entry.rawHex = toHex(bytes, bytes.length);
      entry.bytes = bytes.length;
    }
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this.emit();
  }

  /** Rate-limited raw packet capture, keyed by service/characteristic. */
  packet(source: string, bytes: Uint8Array, note?: string) {
    const seen = this.packetCounts.get(source) ?? 0;
    this.packetCounts.set(source, seen + 1);
    if (!this.enabled) return;
    if (seen >= MAX_PACKETS_PER_SOURCE) {
      if (seen === MAX_PACKETS_PER_SOURCE) {
        this.add("info", `Further packets from ${source} not logged (sample limit reached)`);
      }
      return;
    }
    this.add("packet", note ? `${source} — ${note}` : source, { index: seen }, bytes);
  }

  /** Total packets seen per characteristic, including unlogged ones. */
  packetTotals(): Record<string, number> {
    return Object.fromEntries(this.packetCounts);
  }

  all(): BleLogEntry[] {
    return this.entries;
  }

  clear() {
    this.entries = [];
    this.packetCounts.clear();
    this.acks = [];
    this.started = Date.now();
    this.emit();
  }

  subscribe(cb: (entries: BleLogEntry[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.entries);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    for (const cb of this.listeners) cb([...this.entries]);
  }
}

/** Single shared log — the BLE source and the panel both talk to this. */
export const bleDiagnostics = new BleDiagnosticLog();

/** Human-readable export, safe to paste into an email or issue. */
export function formatBleDiagnosticText(
  entries: BleLogEntry[],
  totals: Record<string, number> = {},
  acks: BleAckRecord[] = [],
  context: BleCaptureContext = {},
): string {
  const lines = [
    "CortexTrace BLE diagnostic log",
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${entries.length}`,
  ];
  const contextKeys = Object.keys(context) as Array<keyof BleCaptureContext>;
  if (contextKeys.length) {
    lines.push("", "Capture context:");
    for (const key of contextKeys) lines.push(`  ${key}: ${context[key]}`);
  }
  lines.push("");
  for (const entry of entries) {
    const seconds = (entry.t / 1000).toFixed(3).padStart(8, " ");
    let line = `[${seconds}s] ${entry.kind.toUpperCase().padEnd(14)} ${entry.message}`;
    if (entry.data) line += ` ${JSON.stringify(entry.data)}`;
    if (entry.hex) line += `\n                          bytes(${entry.bytes}): ${entry.hex}`;
    lines.push(line);
  }
  if (acks.length) {
    lines.push("", "Firmware acknowledgements and error codes:");
    for (const ack of acks) {
      const codes = [ack.sysResult, ack.afeResult].filter(Boolean).join(" / ") || "no code";
      lines.push(
        `  [${(ack.t / 1000).toFixed(3)}s] ${ack.iso} ${ack.ok ? "OK   " : "ERROR"} ` +
          `${ack.command ?? "unknown"} → ${codes}` +
          `${ack.variant ? ` (variant "${ack.variant}", step "${ack.step ?? "?"}")` : ""}` +
          `${ack.firmwareVersion ? ` fw ${ack.firmwareVersion}` : ""}`,
      );
    }
  }
  const totalKeys = Object.keys(totals);
  if (totalKeys.length) {
    lines.push("", "Packet totals per characteristic:");
    for (const key of totalKeys) lines.push(`  ${key}: ${totals[key]}`);
  }
  return lines.join("\n");
}

export function bleDiagnosticJson(
  entries: BleLogEntry[],
  totals: Record<string, number> = {},
  meta?: ExportMeta,
  acks: BleAckRecord[] = [],
  context: BleCaptureContext = {},
): string {
  const header = meta ?? buildExportMeta({ kind: "ble-log" });
  return JSON.stringify(
    {
      meta: header,
      exportedAt: header.exportedAt,
      userAgent: header.userAgent ?? "unknown",
      captureContext: context,
      packetTotals: totals,
      acks,
      entries,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* Packet inspector                                                    */
/* ------------------------------------------------------------------ */

export interface BlePacketRecord {
  at: number;
  source: string;
  format: string;
  hex: string;
  bytes: number;
  decodedSamples: number;
  amplitudeUv: number;
  /** ms since the previous notification on this stream. */
  deltaMs: number;
}

export interface BlePacketRecordInput {
  at: number;
  source: string;
  format: string;
  bytes: Uint8Array;
  decodedSamples: number;
  amplitudeUv: number;
}

const INSPECTOR_CAPACITY = 400;

/**
 * Rolling, timestamped view of the live notification stream. Kept separate
 * from the connection log: this one runs during a case, so it is a small
 * fixed ring and only fills while the clinician has the inspector open.
 */
export class BlePacketInspector {
  private records: BlePacketRecord[] = [];
  private lastAt = new Map<string, number>();
  private listeners = new Set<(records: BlePacketRecord[]) => void>();
  enabled = false;
  totalSeen = 0;

  setEnabled(on: boolean) {
    this.enabled = on;
    if (!on) this.lastAt.clear();
    this.emit();
  }

  record(input: BlePacketRecordInput) {
    if (!this.enabled) return;
    const previous = this.lastAt.get(input.source);
    this.lastAt.set(input.source, input.at);
    this.totalSeen++;
    this.records.push({
      at: input.at,
      source: input.source,
      format: input.format,
      hex: toHex(input.bytes, 32),
      bytes: input.bytes.length,
      decodedSamples: input.decodedSamples,
      amplitudeUv: Number(input.amplitudeUv.toFixed(1)),
      deltaMs: previous ? input.at - previous : 0,
    });
    if (this.records.length > INSPECTOR_CAPACITY) {
      this.records.splice(0, this.records.length - INSPECTOR_CAPACITY);
    }
    this.emit();
  }

  all(): BlePacketRecord[] {
    return this.records;
  }

  clear() {
    this.records = [];
    this.lastAt.clear();
    this.totalSeen = 0;
    this.emit();
  }

  subscribe(cb: (records: BlePacketRecord[]) => void): () => void {
    this.listeners.add(cb);
    cb(this.records);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    for (const cb of this.listeners) cb([...this.records]);
  }
}

export const blePacketInspector = new BlePacketInspector();

export function packetsToCsv(records: BlePacketRecord[]): string {
  const header = "iso_time,epoch_ms,delta_ms,source,format,bytes,decoded_samples,amplitude_uv,hex";
  const rows = records.map((r) =>
    [
      new Date(r.at).toISOString(),
      r.at,
      r.deltaMs,
      `"${r.source}"`,
      r.format,
      r.bytes,
      r.decodedSamples,
      r.amplitudeUv,
      `"${r.hex}"`,
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

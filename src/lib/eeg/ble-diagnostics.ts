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
/** Bytes kept per frame — enough to see framing, header and CRC. */
const MAX_HEX_BYTES = 64;
/** Raw packets logged per characteristic, so a live stream cannot flood it. */
const MAX_PACKETS_PER_SOURCE = 12;

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
  /** Off by default: raw bytes are only captured when the clinician asks. */
  enabled = false;

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.add("session", "Diagnostic capture enabled");
    else this.emit();
  }

  /** Starts a fresh capture for a new pairing attempt. */
  beginSession(label: string) {
    this.entries = [];
    this.packetCounts.clear();
    this.started = Date.now();
    this.add("session", `Connection attempt: ${label}`, {
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
    });
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
): string {
  const lines = [
    "CortexTrace BLE diagnostic log",
    `Exported: ${new Date().toISOString()}`,
    `Entries: ${entries.length}`,
    "",
  ];
  for (const entry of entries) {
    const seconds = (entry.t / 1000).toFixed(3).padStart(8, " ");
    let line = `[${seconds}s] ${entry.kind.toUpperCase().padEnd(14)} ${entry.message}`;
    if (entry.data) line += ` ${JSON.stringify(entry.data)}`;
    if (entry.hex) line += `\n                          bytes(${entry.bytes}): ${entry.hex}`;
    lines.push(line);
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
): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      userAgent: typeof navigator === "undefined" ? "unknown" : navigator.userAgent,
      packetTotals: totals,
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

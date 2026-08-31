/**
 * FocusCalm FC-11 ("Regul8 Headband") BLE protocol — CMSN transport.
 *
 * Unlike every earlier attempt in this codebase, nothing here is inferred from
 * a sibling product's SDK. The framing, the activation command sequence, the
 * acknowledgement layout and the EEG message schema were all recovered from a
 * real Apple PacketLogger HCI capture of the official FocusCalm iOS app
 * streaming from this exact headband (BrainCo FC-11, firmware 1.1.6).
 *
 * Frame layout (both directions), on service 0D740001-…:
 *   'C' 'M' 'S' 'N' | uint16 big-endian payload length | protobuf | 'P' 'K' 'E' 'D'
 * There is no CRC. Frames are MTU-fragmented across notifications.
 *
 * Command payload (host -> device):
 *   field 1 varint  message id (increments per command)
 *   field 2 message Command { 1: repeated uint32 op; 2: uint64 arg; 6: bytes id }
 *
 * Acknowledgement (device -> host):
 *   field 1 varint  echoed message id
 *   field 6 message Ack { 2: uint32 op; 3: uint32 result (0 = accepted) }
 *
 * EEG data (device -> host):
 *   field 2 message Eeg { 1: seq, 2: 1, 3: channel, 4: bytes samples }
 * Samples are 24-bit big-endian two's complement, 50 per message, one channel,
 * delivered at 250 Hz (measured 250.3 Hz over the capture).
 */

/** Vendor data-stream service on FC-11 firmware. */
export const CMSN_SERVICE = "0d740001-d26f-4dbb-95e8-a4f5c55c57a9";
/** Host -> device command characteristic (write without response). */
export const CMSN_WRITE = "0d740002-d26f-4dbb-95e8-a4f5c55c57a9";
/** Device -> host notification characteristic. */
export const CMSN_NOTIFY = "0d740003-d26f-4dbb-95e8-a4f5c55c57a9";

/** EEG sample rate observed on the wire. */
export const CMSN_SAMPLE_RATE = 250;

/**
 * Microvolts per raw count for the 24-bit front end (Vref 4.5 V, gain 24).
 * A one-second window of the reference capture scales to ~63 µV peak-to-peak,
 * which is the expected magnitude for awake forehead EEG.
 */
export const CMSN_UV_PER_COUNT = 0.0223517;

/** Command opcodes observed in the official app's activation sequence. */
export const CMSN_OP = {
  /** Presents the host identity and pairs. */
  pair: 2,
  /** Session setup step sent immediately before the stream start. */
  prepare: 3,
  /** Starts the raw EEG stream. */
  startEeg: 0x0e,
  /** Clock/telemetry sync, carries a timestamp argument. */
  sync: 9,
} as const;

const HEAD = [0x43, 0x4d, 0x53, 0x4e]; // "CMSN"
const TAIL = [0x50, 0x4b, 0x45, 0x44]; // "PKED"

/* ------------------------------------------------------------------ */
/* Protobuf helpers                                                    */
/* ------------------------------------------------------------------ */

function varint(value: number): number[] {
  const out: number[] = [];
  let v = Math.max(0, Math.floor(value));
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function lenField(field: number, body: number[]): number[] {
  return [(field << 3) | 2, ...varint(body.length), ...body];
}

function varintField(field: number, value: number): number[] {
  return [(field << 3) | 0, ...varint(value)];
}

interface ProtoField {
  field: number;
  wire: number;
  value: number;
  bytes: Uint8Array | null;
}

function readVarint(bytes: Uint8Array, at: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = at; i < bytes.length && shift <= 56; i++) {
    const byte = bytes[i] as number;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

/** Walks one protobuf message, returning its top-level fields. */
export function cmsnFields(bytes: Uint8Array): ProtoField[] {
  const out: ProtoField[] = [];
  let at = 0;
  while (at < bytes.length) {
    const key = readVarint(bytes, at);
    if (!key) break;
    at = key.next;
    const field = Math.floor(key.value / 8);
    const wire = key.value & 7;
    if (!field) break;
    if (wire === 0) {
      const value = readVarint(bytes, at);
      if (!value) break;
      at = value.next;
      out.push({ field, wire, value: value.value, bytes: null });
    } else if (wire === 2) {
      const length = readVarint(bytes, at);
      if (!length || length.next + length.value > bytes.length) break;
      at = length.next;
      out.push({ field, wire, value: length.value, bytes: bytes.subarray(at, at + length.value) });
      at += length.value;
    } else if (wire === 1 || wire === 5) {
      const width = wire === 1 ? 8 : 4;
      if (at + width > bytes.length) break;
      out.push({ field, wire, value: 0, bytes: bytes.subarray(at, at + width) });
      at += width;
    } else break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

/** Wraps a protobuf payload in the CMSN/PKED envelope the firmware expects. */
export function cmsnFrame(payload: number[]): Uint8Array {
  return Uint8Array.from([
    ...HEAD,
    (payload.length >> 8) & 0xff,
    payload.length & 0xff,
    ...payload,
    ...TAIL,
  ]);
}

let messageId = 0;

/** Monotonic command id; the firmware echoes it in the acknowledgement. */
export function nextCmsnMsgId(): number {
  messageId = (messageId % 0x7fff) + 1;
  return messageId;
}

/** Pairing command carrying the 16-byte host identity. */
export function cmsnPairCommand(msgId: number, identity: Uint8Array): Uint8Array {
  const id = identity.length === 16 ? identity : cmsnIdentityBytes(String(identity));
  return cmsnFrame([
    ...varintField(1, msgId),
    ...lenField(2, [...varintField(1, CMSN_OP.pair), ...lenField(6, [...id])]),
  ]);
}

/** Simple opcode command, matching the app's packed single-element form. */
export function cmsnOpCommand(msgId: number, op: number): Uint8Array {
  return cmsnFrame([...varintField(1, msgId), ...lenField(2, lenField(1, varint(op)))]);
}

/** Clock sync command; the app sends this shortly after the stream starts. */
export function cmsnSyncCommand(msgId: number, epochMs: number): Uint8Array {
  return cmsnFrame([
    ...varintField(1, msgId),
    ...lenField(2, lenField(1, [...varint(CMSN_OP.sync), ...varintField(2, epochMs)])),
  ]);
}

/** Derives a stable 16-byte host identity from a string (device id or UUID). */
export function cmsnIdentityBytes(seed: string): Uint8Array {
  const out = new Uint8Array(16);
  const hex = seed.replace(/[^0-9a-f]/gi, "");
  if (hex.length >= 32) {
    for (let i = 0; i < 16; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  let h = 0x811c9dc5;
  for (let i = 0; i < 16; i++) {
    for (let k = 0; k < seed.length; k++) {
      h ^= seed.charCodeAt(k) + i;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out[i] = h & 0xff;
  }
  return out;
}

const IDENTITY_KEY = "cortextrace.fc11.identity";

/** Stable per-installation identity, persisted so re-pairing is recognised. */
export function cmsnIdentity(storage?: Storage, deviceId?: string): Uint8Array {
  const store = storage ?? (typeof localStorage === "undefined" ? undefined : localStorage);
  const existing = store?.getItem(IDENTITY_KEY);
  if (existing && /^[0-9a-f]{32}$/i.test(existing)) return cmsnIdentityBytes(existing);
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  if (deviceId) {
    const derived = cmsnIdentityBytes(deviceId);
    for (let i = 0; i < 8; i++) bytes[i] = derived[i] as number;
  }
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  try {
    store?.setItem(IDENTITY_KEY, hex);
  } catch {
    /* Private browsing: a fresh identity simply re-pairs each session. */
  }
  return bytes;
}

/** Reassembles CMSN frames across MTU-fragmented notifications. */
export class CmsnDeframer {
  private buffer: number[] = [];

  reset() {
    this.buffer = [];
  }

  /** Appends notification bytes and returns every complete payload found. */
  push(bytes: Uint8Array): Uint8Array[] {
    for (const byte of bytes) this.buffer.push(byte);
    if (this.buffer.length > 65_536) this.buffer.splice(0, this.buffer.length - 65_536);
    const out: Uint8Array[] = [];
    for (;;) {
      const start = this.findHead();
      if (start < 0) {
        // Keep a short tail in case the magic itself straddles two packets.
        if (this.buffer.length > 4) this.buffer.splice(0, this.buffer.length - 4);
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 6) break;
      const length = ((this.buffer[4] as number) << 8) | (this.buffer[5] as number);
      const total = 6 + length + 4;
      if (length > 8192) {
        this.buffer.splice(0, 1);
        continue;
      }
      if (this.buffer.length < total) break;
      const tailOk = TAIL.every((byte, i) => this.buffer[6 + length + i] === byte);
      if (!tailOk) {
        this.buffer.splice(0, 1);
        continue;
      }
      out.push(Uint8Array.from(this.buffer.slice(6, 6 + length)));
      this.buffer.splice(0, total);
    }
    return out;
  }

  private findHead(): number {
    for (let i = 0; i + 3 < this.buffer.length; i++) {
      if (HEAD.every((byte, k) => this.buffer[i + k] === byte)) return i;
    }
    return -1;
  }
}

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

function int24be(bytes: Uint8Array, at: number): number {
  const raw = ((bytes[at] as number) << 16) | ((bytes[at + 1] as number) << 8) | (bytes[at + 2] as number);
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}

export interface CmsnEegMessage {
  sequence: number;
  channel: number;
  samples: number[];
}

/** Decodes one CMSN payload into an EEG message, or null if it is not one. */
export function cmsnEegMessage(payload: Uint8Array): CmsnEegMessage | null {
  const top = cmsnFields(payload).find((f) => f.field === 2 && f.bytes);
  if (!top?.bytes) return null;
  const inner = cmsnFields(top.bytes);
  const data = inner.find((f) => f.field === 4 && f.bytes)?.bytes;
  if (!data || data.length < 3 || data.length % 3) return null;
  const samples: number[] = [];
  for (let i = 0; i + 2 < data.length; i += 3) samples.push(int24be(data, i));
  return {
    sequence: inner.find((f) => f.field === 1 && f.wire === 0)?.value ?? 0,
    channel: inner.find((f) => f.field === 3 && f.wire === 0)?.value ?? 1,
    samples,
  };
}

/** Convenience: EEG counts contained in one CMSN payload. */
export function cmsnEegSamples(payload: Uint8Array): number[] {
  return cmsnEegMessage(payload)?.samples ?? [];
}

export interface CmsnAck {
  messageId: number;
  op: number | null;
  result: number | null;
  ok: boolean;
}

/** Decodes a firmware acknowledgement payload, or null when it is not one. */
export function cmsnAck(payload: Uint8Array): CmsnAck | null {
  const fields = cmsnFields(payload);
  const ack = fields.find((f) => f.field === 6 && f.bytes);
  if (!ack?.bytes) return null;
  const inner = cmsnFields(ack.bytes);
  const op = inner.find((f) => f.field === 2 && f.wire === 0)?.value ?? null;
  const result = inner.find((f) => f.field === 3 && f.wire === 0)?.value ?? null;
  return {
    messageId: fields.find((f) => f.field === 1 && f.wire === 0)?.value ?? 0,
    op,
    result,
    ok: result === 0,
  };
}

/** Human-readable name for an opcode, for diagnostics. */
export function cmsnOpName(op: number | null): string {
  switch (op) {
    case CMSN_OP.pair:
      return "pair";
    case CMSN_OP.prepare:
      return "prepare session";
    case CMSN_OP.startEeg:
      return "start EEG stream";
    case CMSN_OP.sync:
      return "clock sync";
    default:
      return op == null ? "unknown" : `opcode ${op}`;
  }
}

/** True when a buffer contains the CMSN envelope magic. */
export function containsCmsn(bytes: Uint8Array): boolean {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (HEAD.every((byte, k) => bytes[i + k] === byte)) return true;
  }
  return false;
}

/** Stateless decode of a burst of bytes into EEG counts (used for scoring). */
export function decodeCmsnPacket(bytes: Uint8Array): number[] {
  const deframer = new CmsnDeframer();
  return deframer.push(bytes).flatMap((payload) => cmsnEegSamples(payload));
}

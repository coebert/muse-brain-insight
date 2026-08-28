/**
 * BrainCo "ZenLite" BLE protocol (FocusCalm / Regul8 / OxyZen headband family).
 *
 * The transport was recovered from BrainCo's published OxyZen SDK: a
 * `BRNC` framed protobuf message exchanged over one vendor GATT service.
 * Devices in this family connect happily but stay completely silent until the
 * host pairs and then explicitly switches the analogue front end on — which is
 * exactly the "connects but sends no data" behaviour clinicians hit.
 *
 * Frame layout (host -> device and device -> host):
 *   'B' 'R' 'N' 'C' | 0x01 0x01 | uint16le payload length | payload | uint16le CRC
 * The CRC is CRC-16/MODBUS over the header plus payload.
 *
 * Only the command encodings are asserted here. Incoming data messages are
 * walked generically (protobuf wire format) rather than against a schema we
 * cannot verify, so firmware revisions that move field numbers still decode.
 */

/** Vendor data-stream service exposed by BrainCo headbands. */
export const ZENLITE_SERVICE = "4de50001-a20c-ae01-bf63-0242ac130002";
/** Host -> device command characteristic. */
export const ZENLITE_WRITE = "4de50002-a20c-ae01-bf63-0242ac130002";
/** Device -> host notification characteristic. */
export const ZENLITE_NOTIFY = "4de50003-a20c-ae01-bf63-0242ac130002";

/** EEG sample rate the headband reports on this transport. */
export const ZENLITE_SAMPLE_RATE = 256;

const MAGIC = [0x42, 0x52, 0x4e, 0x43];
const HEADER = [...MAGIC, 0x01, 0x01];

/** AFE (EEG front end) sample-rate enum from the vendor SDK. */
export const ZENLITE_AFE = { off: 1, sr128: 2, sr256: 3 } as const;

/** System command enum from the vendor SDK. */
export const ZENLITE_CMD = { pair: 1, validatePairInfo: 2, getSystemInfo: 3 } as const;

/* ------------------------------------------------------------------ */
/* Framing                                                             */
/* ------------------------------------------------------------------ */

/** CRC-16/MODBUS, appended little-endian to every frame. */
export function crc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc & 0xffff;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function tagged(field: number, wire: number, body: number[]): number[] {
  return [...varint((field << 3) | wire), ...body];
}

function varintField(field: number, value: number): number[] {
  return tagged(field, 0, varint(value));
}

function bytesField(field: number, body: number[]): number[] {
  return tagged(field, 2, [...varint(body.length), ...body]);
}

/** Wraps a protobuf payload in the BRNC frame the firmware expects. */
export function zenliteFrame(payload: number[]): Uint8Array {
  const head = [...HEADER, payload.length & 0xff, (payload.length >> 8) & 0xff, ...payload];
  const crc = crc16Modbus(Uint8Array.from(head));
  return Uint8Array.from([...head, crc & 0xff, (crc >> 8) & 0xff]);
}

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pair (first use, band in pairing mode) or re-validate an existing pairing.
 * The firmware accepts exactly 16 bytes of host identity.
 */
export function zenlitePairCommand(msgId: number, pairingMode: boolean, uuid: string): Uint8Array {
  const id = uuid.slice(0, 16).padEnd(16, "0");
  const idBytes = [...id].map((c) => c.charCodeAt(0) & 0xff);
  const cmd = pairingMode ? ZENLITE_CMD.pair : ZENLITE_CMD.validatePairInfo;
  const inner = [...varintField(1, cmd), ...bytesField(6, idBytes)];
  return zenliteFrame([...varintField(1, msgId), ...bytesField(2, inner)]);
}

/** Switches the EEG front end on at the given rate (or off with `ZENLITE_AFE.off`). */
export function zenliteAfeCommand(msgId: number, sampleRate: number): Uint8Array {
  const inner = varintField(1, sampleRate);
  return zenliteFrame([...varintField(1, msgId), ...bytesField(3, inner)]);
}

/** Generic system command (shutdown, system info, …). */
export function zenliteSysCommand(msgId: number, cmd: number): Uint8Array {
  const inner = varintField(1, cmd);
  return zenliteFrame([...varintField(1, msgId), ...bytesField(2, inner)]);
}

/* ------------------------------------------------------------------ */
/* Incoming data                                                       */
/* ------------------------------------------------------------------ */

interface ProtoBytes {
  path: number[];
  bytes: Uint8Array;
}

/** Depth-first walk of a protobuf payload collecting every length-delimited field. */
function collectBytesFields(buf: Uint8Array, path: number[] = [], depth = 0): ProtoBytes[] {
  if (depth > 4) return [];
  const out: ProtoBytes[] = [];
  let i = 0;
  while (i < buf.length) {
    let key = 0;
    let shift = 0;
    while (i < buf.length) {
      const b = buf[i++] as number;
      key |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (shift > 28) return out;
    }
    const field = key >>> 3;
    const wire = key & 7;
    if (!field) return out;
    if (wire === 0) {
      while (i < buf.length && (buf[i] as number) & 0x80) i++;
      i++;
    } else if (wire === 5) {
      i += 4;
    } else if (wire === 1) {
      i += 8;
    } else if (wire === 2) {
      let len = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++] as number;
        len |= (b & 0x7f) << shift;
        shift += 7;
        if (!(b & 0x80)) break;
        if (shift > 28) return out;
      }
      if (len < 0 || i + len > buf.length) return out;
      const body = buf.subarray(i, i + len);
      const here = [...path, field];
      out.push({ path: here, bytes: body });
      out.push(...collectBytesFields(body, here, depth + 1));
      i += len;
    } else {
      return out;
    }
  }
  return out;
}

function int24be(bytes: Uint8Array, offset: number): number {
  const raw =
    ((bytes[offset] as number) << 16) |
    ((bytes[offset + 1] as number) << 8) |
    (bytes[offset + 2] as number);
  return raw & 0x800000 ? raw - 0x1000000 : raw;
}

/**
 * Extracts EEG samples from one decoded ZenLite message.
 *
 * The EEG payload is the packed 24-bit big-endian sample block; it is the only
 * length-delimited field whose size is a non-trivial multiple of three, so it
 * can be identified without a schema. IMU/PPG blocks are shorter and rejected.
 */
export function zenliteEegSamples(payload: Uint8Array): number[] {
  const all = collectBytesFields(payload);
  const key = (f: ProtoBytes) => f.path.join(".");
  const parents = new Set(
    all.flatMap((f) => f.path.slice(0, -1).map((_, i) => f.path.slice(0, i + 1).join("."))),
  );
  const candidates = all
    // A container submessage can also be a multiple of three bytes long; only
    // leaf fields hold the packed sample block.
    .filter((f) => !parents.has(key(f)))
    .filter((f) => f.bytes.length >= 24 && f.bytes.length % 3 === 0)
    .sort((a, b) => b.bytes.length - a.bytes.length);
  const best = candidates[0];
  if (!best) return [];
  const out: number[] = [];
  for (let i = 0; i + 2 < best.bytes.length; i += 3) out.push(int24be(best.bytes, i));
  return out;
}

/**
 * Reassembles BRNC frames across BLE notifications.
 *
 * Notifications are MTU-sized, so a message can arrive split, and a stall can
 * leave a partial frame in the buffer. Bytes before a valid header are dropped
 * rather than allowed to desynchronise the stream permanently.
 */
export class ZenLiteDeframer {
  private buffer: number[] = [];

  /** Feeds one notification and returns the complete payloads it produced. */
  push(chunk: Uint8Array): Uint8Array[] {
    for (const b of chunk) this.buffer.push(b);
    if (this.buffer.length > 8192) this.buffer.splice(0, this.buffer.length - 8192);
    const frames: Uint8Array[] = [];
    for (;;) {
      const start = this.findMagic();
      if (start < 0) {
        // Keep only a possible partial header.
        if (this.buffer.length > MAGIC.length) {
          this.buffer = this.buffer.slice(this.buffer.length - (MAGIC.length - 1));
        }
        break;
      }
      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 8) break;
      const len = (this.buffer[6] as number) | ((this.buffer[7] as number) << 8);
      const total = len + 10;
      if (len > 4096) {
        this.buffer.splice(0, 1);
        continue;
      }
      if (this.buffer.length < total) break;
      const frame = Uint8Array.from(this.buffer.slice(0, total));
      const expected = crc16Modbus(frame.subarray(0, total - 2));
      const seen = (frame[total - 2] as number) | ((frame[total - 1] as number) << 8);
      this.buffer.splice(0, expected === seen ? total : 1);
      if (expected === seen) frames.push(frame.subarray(8, total - 2));
    }
    return frames;
  }

  reset() {
    this.buffer = [];
  }

  private findMagic(): number {
    for (let i = 0; i + MAGIC.length <= this.buffer.length; i++) {
      let match = true;
      for (let k = 0; k < MAGIC.length; k++) {
        if (this.buffer[i + k] !== MAGIC[k]) {
          match = false;
          break;
        }
      }
      if (match) return i;
    }
    return -1;
  }
}

/** Stateless decode of whole frames inside one buffer, used by format detection. */
export function decodeZenLitePacket(bytes: Uint8Array): number[] {
  const frames = new ZenLiteDeframer().push(bytes);
  const out: number[] = [];
  for (const payload of frames) out.push(...zenliteEegSamples(payload));
  return out;
}

/** Stable per-install identity so the band can re-validate an existing pairing. */
export function zenlitePairUuid(storage?: Storage): string {
  const key = "mindguard.zenlite.pair-uuid";
  const random = () =>
    Array.from({ length: 16 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
  try {
    const store = storage ?? (typeof localStorage !== "undefined" ? localStorage : undefined);
    if (!store) return random();
    const existing = store.getItem(key);
    if (existing && existing.length === 16) return existing;
    const fresh = random();
    store.setItem(key, fresh);
    return fresh;
  } catch {
    return random();
  }
}

let msgId = 0;

/** Monotonic message id (firmware only tracks a byte-sized counter). */
export function nextZenLiteMsgId(): number {
  msgId = (msgId % 250) + 1;
  return msgId;
}

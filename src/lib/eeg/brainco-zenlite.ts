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

/** Vendor data-stream service exposed by BrainCo headbands (OxyZen family). */
export const ZENLITE_SERVICE = "4de50001-a20c-ae01-bf63-0242ac130002";
/** Host -> device command characteristic. */
export const ZENLITE_WRITE = "4de50002-a20c-ae01-bf63-0242ac130002";
/** Device -> host notification characteristic. */
export const ZENLITE_NOTIFY = "4de50003-a20c-ae01-bf63-0242ac130002";

/**
 * The same transport appears on a second vendor UUID block on FocusCalm FC-11
 * firmware (observed on a real Regul8/FC11 band, firmware 1.1.6): base
 * 0D74xxxx with the identical 0001/0002/0003 service/write/notify layout.
 */
export const ZENLITE_SERVICE_FC11 = "0d740001-d26f-4dbb-95e8-a4f5c55c57a9";
export const ZENLITE_WRITE_FC11 = "0d740002-d26f-4dbb-95e8-a4f5c55c57a9";
export const ZENLITE_NOTIFY_FC11 = "0d740003-d26f-4dbb-95e8-a4f5c55c57a9";

/** Every known BrainCo transport variant, in preference order. */
export const ZENLITE_TRANSPORTS = [
  { service: ZENLITE_SERVICE, write: ZENLITE_WRITE, notify: ZENLITE_NOTIFY },
  { service: ZENLITE_SERVICE_FC11, write: ZENLITE_WRITE_FC11, notify: ZENLITE_NOTIFY_FC11 },
] as const;

export type ZenLiteTransport = (typeof ZENLITE_TRANSPORTS)[number];

/** Returns the transport definition for a vendor service UUID, if known. */
export function zenliteTransportForService(uuid: string): ZenLiteTransport | null {
  const lower = uuid.toLowerCase();
  return ZENLITE_TRANSPORTS.find((t) => t.service === lower) ?? null;
}

/** True when the UUID is any known BrainCo data-stream service. */
export function isZenLiteService(uuid: string): boolean {
  return zenliteTransportForService(uuid) != null;
}

/** True when the UUID is any known BrainCo notification characteristic. */
export function isZenLiteNotify(uuid: string): boolean {
  const lower = uuid.toLowerCase();
  return ZENLITE_TRANSPORTS.some((t) => t.notify === lower);
}


/** EEG sample rate the headband reports on this transport. */
export const ZENLITE_SAMPLE_RATE = 256;

const MAGIC = [0x42, 0x52, 0x4e, 0x43];
const HEADER = [...MAGIC, 0x01, 0x01];

/** AFE (EEG front end) sample-rate enum from the vendor SDK. */
export const ZENLITE_AFE = { off: 1, sr128: 2, sr256: 3 } as const;

/**
 * System command enum from the vendor SDK, verified byte-for-byte against the
 * BrainCo command packers. Opcode 3 starts the data stream — the app used to
 * treat it as "get system info", which is why bands connected but stayed silent.
 */
export const ZENLITE_CMD = {
  pair: 1,
  validatePairInfo: 2,
  startDataStream: 3,
  stopDataStream: 4,
  shutdown: 5,
  enterOta: 6,
  reset: 7,
  setDeviceName: 8,
  setSleepIdleTime: 9,
  getSystemMonitor: 10,
} as const;

/**
 * Microvolts per raw 24-bit count, measured from the vendor decoder's passband
 * output (gain ≈ 1 between 5 and 30 Hz). Amplitudes remain approximate.
 */
export const ZENLITE_UV_PER_COUNT = 0.006007;

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

/** CRC-16/CCITT-FALSE, used by some BrainCo firmware branches. */
export function crc16CcittFalse(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

export interface ZenLiteFramingVariant {
  /** Short label shown in the activation probe report. */
  label: string;
  checksum: "modbus" | "ccitt" | "none";
  /** Byte order of both the length field and the checksum. */
  endian: "le" | "be";
}

/**
 * The framing combinations worth trying when a band accepts writes but never
 * answers: a mismatched length order or checksum flavour is dropped silently by
 * the firmware, which looks exactly like a dead device.
 */
export const ZENLITE_FRAMING_VARIANTS: ZenLiteFramingVariant[] = [
  { label: "MODBUS/LE (documented)", checksum: "modbus", endian: "le" },
  { label: "MODBUS/BE", checksum: "modbus", endian: "be" },
  { label: "CCITT/LE", checksum: "ccitt", endian: "le" },
  { label: "CCITT/BE", checksum: "ccitt", endian: "be" },
  { label: "no checksum", checksum: "none", endian: "le" },
];

/** Frames a payload using an explicit framing variant. */
export function zenliteFrameWith(payload: number[], variant: ZenLiteFramingVariant): Uint8Array {
  const len =
    variant.endian === "le"
      ? [payload.length & 0xff, (payload.length >> 8) & 0xff]
      : [(payload.length >> 8) & 0xff, payload.length & 0xff];
  const head = [...HEADER, ...len, ...payload];
  if (variant.checksum === "none") return Uint8Array.from(head);
  const crc =
    variant.checksum === "modbus"
      ? crc16Modbus(Uint8Array.from(head))
      : crc16CcittFalse(Uint8Array.from(head));
  const tail = variant.endian === "le" ? [crc & 0xff, (crc >> 8) & 0xff] : [(crc >> 8) & 0xff, crc & 0xff];
  return Uint8Array.from([...head, ...tail]);
}

/** The protobuf payload of a system command, unframed. */
export function zenliteSysPayload(msgId: number, cmd: number): number[] {
  return [...varintField(1, msgId), ...bytesField(2, varintField(1, cmd))];
}

/** The protobuf payload of an AFE (front-end) command, unframed. */
export function zenliteAfePayload(msgId: number, sampleRate: number): number[] {
  return [...varintField(1, msgId), ...bytesField(3, varintField(1, sampleRate))];
}


/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

/**
 * Encodes the 16-byte host identity the firmware expects.
 *
 * The vendor SDK passes the BLE peripheral identifier, which on Apple platforms
 * is a 128-bit UUID. A survey of the FC-11 showed the app sending the *text*
 * `F8FCBC0A-3D75-47` — the first 16 characters of that UUID string — which is
 * only half the identifier and not the binary form the firmware compares
 * against, so pairing was silently rejected. Parse UUID-shaped ids into their
 * 16 raw bytes and only fall back to ASCII for non-UUID identifiers.
 */
export function zenlitePairIdentityBytes(uuid: string): number[] {
  const hex = uuid.replace(/-/g, "");
  if (/^[0-9a-fA-F]{32}$/.test(hex)) {
    const bytes: number[] = [];
    for (let i = 0; i < 32; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes;
  }
  const id = uuid.slice(0, 16).padEnd(16, "0");
  return [...id].map((c) => c.charCodeAt(0) & 0xff);
}

/**
 * Pair (first use, band in pairing mode) or re-validate an existing pairing.
 * The firmware accepts exactly 16 bytes of host identity.
 */
export function zenlitePairCommand(msgId: number, pairingMode: boolean, uuid: string): Uint8Array {
  const idBytes = zenlitePairIdentityBytes(uuid);
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
 * Verified AFE data path: top-level field 2 is the AFE module, its field 2 is
 * the AFE data message, and field 4 of that holds the packed 24-bit big-endian
 * EEG block (field 1 is the sequence number, field 2 the sample-rate enum).
 * Confirmed by driving the vendor decoder with synthesised frames.
 */
const EEG_PATH = "2.2.4";
/** The AFE data message itself, which carries the sequence and rate enum. */
const AFE_DATA_PATH = "2.2";

/** Sample-rate enum -> Hz, as reported inside AFE data messages. */
export function zenliteSampleRateFromEnum(value: number): number | null {
  if (value === ZENLITE_AFE.sr128) return 128;
  if (value === ZENLITE_AFE.sr256) return 256;
  return null;
}

/** Scalar (varint) fields of one protobuf message, keyed by field number. */
function scalarFields(buf: Uint8Array): Map<number, number> {
  const out = new Map<number, number>();
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
      let value = 0;
      shift = 0;
      while (i < buf.length) {
        const b = buf[i++] as number;
        value += (b & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(b & 0x80)) break;
        if (shift > 42) return out;
      }
      if (!out.has(field)) out.set(field, value);
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
      i += len;
    } else {
      return out;
    }
  }
  return out;
}

export interface ZenLiteAfeInfo {
  /** Frame sequence counter, used to spot dropped frames. */
  sequence: number | null;
  /** Raw sample-rate enum the firmware reported. */
  sampleRateEnum: number | null;
  /** Resolved rate in Hz, when the enum is one of the documented values. */
  sampleRateHz: number | null;
  /** Samples carried by this frame. */
  sampleCount: number;
}

/**
 * Reads the AFE data header of one decoded ZenLite message: the frame sequence
 * number and the sample-rate enum the firmware itself declares. This is what
 * lets a first capture verify the rate rather than assume it.
 */
export function zenliteAfeInfo(payload: Uint8Array): ZenLiteAfeInfo | null {
  const fields = collectBytesFields(payload);
  const afe = fields.find((f) => f.path.join(".") === AFE_DATA_PATH);
  if (!afe) return null;
  const scalars = scalarFields(afe.bytes);
  const block = fields.find((f) => f.path.join(".") === EEG_PATH);
  const rateEnum = scalars.get(2) ?? null;
  return {
    sequence: scalars.get(1) ?? null,
    sampleRateEnum: rateEnum,
    sampleRateHz: rateEnum == null ? null : zenliteSampleRateFromEnum(rateEnum),
    sampleCount: block ? Math.floor(block.bytes.length / 3) : 0,
  };
}

/** Aggregates the AFE headers of every complete frame inside a buffer. */
export function zenliteStreamInfo(bytes: Uint8Array): ZenLiteAfeInfo[] {
  const frames = new ZenLiteDeframer().push(bytes);
  const out: ZenLiteAfeInfo[] = [];
  for (const payload of frames) {
    const info = zenliteAfeInfo(payload);
    if (info) out.push(info);
  }
  return out;
}


/**
 * Extracts EEG samples (raw counts) from one decoded ZenLite message.
 *
 * The schema path above is used when present; otherwise the packed 24-bit block
 * is located by shape so that firmware revisions which move fields still decode.
 */
export function zenliteEegSamples(payload: Uint8Array): number[] {
  const all = collectBytesFields(payload);
  const exact = all.find((f) => f.path.join(".") === EEG_PATH);
  if (exact && exact.bytes.length >= 3 && exact.bytes.length % 3 === 0) {
    const samples: number[] = [];
    for (let i = 0; i + 2 < exact.bytes.length; i += 3) samples.push(int24be(exact.bytes, i));
    return samples;
  }
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

/* ------------------------------------------------------------------ */
/* Firmware acknowledgements                                           */
/* ------------------------------------------------------------------ */

/** `SysConfigCmd` echoed back by the firmware, keyed by enum value. */
const SYS_CMD_NAMES: Record<number, string> = {
  1: "PAIR",
  2: "VALIDATE_PAIR_INFO",
  3: "START",
  4: "STOP",
  5: "SHUT_DOWN",
  6: "ENTER_OTA",
  7: "RESTORE_FACTORY_SETTINGS",
  8: "SET_DEVICE_NAME",
  9: "SET_SLEEP",
  10: "GET_SYSINFO",
};

/** `SysModule.Resp` result codes. */
const SYS_RESP_NAMES: Record<number, string> = {
  0: "SUCCESS",
  1: "UNKNOWN_ERR",
  2: "OTA_FAILED_LOW_POWER_ERR",
  3: "PAIR_ERR",
  4: "INVALID_PAIR_INFO_ERR",
  5: "ALLOW_UPDATE",
  6: "RECV_OK",
  7: "UPDATE_COMPLT",
};

/** `AfeModule.Resp` result codes. */
const AFE_RESP_NAMES: Record<number, string> = { 0: "SUCCESS", 1: "UNKNOWN_ERR" };

export interface ZenLiteResponse {
  /** Message id the firmware is answering, when present. */
  msgId: number | null;
  /** Command the system module is acknowledging, e.g. `PAIR`. */
  command: string | null;
  /** System module result, e.g. `INVALID_PAIR_INFO_ERR`. */
  sysResult: string | null;
  /** AFE module result, sent when the EEG front end is configured. */
  afeResult: string | null;
  /** True when every result present in the message reports success. */
  ok: boolean;
}

/**
 * Reads the firmware acknowledgement carried by one decoded ZenLite message.
 *
 * A band that rejects the handshake answers with an explicit code
 * (`PAIR_ERR`, `INVALID_PAIR_INFO_ERR`, …) rather than staying silent, so
 * surfacing this turns "connected but no EEG" into an actionable reason.
 */
export function zenliteResponse(payload: Uint8Array): ZenLiteResponse | null {
  const fields = collectBytesFields(payload);
  const sys = fields.find((f) => f.path.join(".") === "5");
  const afe = fields.find((f) => f.path.join(".") === "2");
  if (!sys && !afe) return null;
  const sysScalars = sys ? scalarFields(sys.bytes) : new Map<number, number>();
  const afeScalars = afe ? scalarFields(afe.bytes) : new Map<number, number>();
  const sysRespValue = sysScalars.get(2);
  const afeRespValue = afe && !fields.some((f) => f.path.join(".") === "2.2")
    ? afeScalars.get(1)
    : undefined;
  if (sysRespValue == null && afeRespValue == null && !sysScalars.has(1)) return null;
  const cmd = sysScalars.get(1);
  const results = [sysRespValue, afeRespValue].filter((v): v is number => v != null);
  return {
    msgId: scalarFields(payload).get(1) ?? null,
    command: cmd == null ? null : SYS_CMD_NAMES[cmd] ?? `CMD_${cmd}`,
    sysResult: sysRespValue == null ? null : SYS_RESP_NAMES[sysRespValue] ?? `RESP_${sysRespValue}`,
    afeResult: afeRespValue == null ? null : AFE_RESP_NAMES[afeRespValue] ?? `RESP_${afeRespValue}`,
    ok: results.length > 0 && results.every((v) => v === 0),
  };
}

/** Firmware acknowledgements contained in one BLE notification buffer. */
export function zenliteResponses(bytes: Uint8Array, deframer?: ZenLiteDeframer): ZenLiteResponse[] {
  const frames = (deframer ?? new ZenLiteDeframer()).push(bytes);
  const out: ZenLiteResponse[] = [];
  for (const payload of frames) {
    const response = zenliteResponse(payload);
    if (response) out.push(response);
  }
  return out;
}


/**
 * Stable 16-byte host identity used by the BrainCo application-layer pairing.
 * The vendor SDK uses the BLE peripheral id, not an unrelated random token.
 * Web Bluetooth device ids are origin-stable, so prefer that value and retain
 * the generated fallback only for callers which do not have a device yet.
 */
export function zenlitePairUuid(storage?: Storage, deviceId?: string): string {
  const key = "mindguard.zenlite.pair-uuid";
  if (deviceId) return deviceId.slice(0, 16).padEnd(16, "0");
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

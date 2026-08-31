import { crc16CcittFalse, crc16Modbus } from "@/lib/eeg/brainco-zenlite";

export type AttDirection = "write" | "notify" | "indicate" | "read" | "response" | "unknown";

export interface AttCaptureEvent {
  index: number;
  atMs: number;
  direction: AttDirection;
  characteristic: string | null;
  handle: string | null;
  opcode: string | null;
  valueHex: string;
  bytes: number;
}

export interface AttProtoField {
  path: string;
  wireType: number;
  occurrences: number;
  minLength: number | null;
  maxLength: number | null;
  scalarValues: number[];
}

export interface AttWriteCorrelation {
  writeIndex: number;
  atMs: number;
  characteristic: string | null;
  valueHex: string;
  replies: number;
  firstReplyMs: number | null;
  notificationBytes: number;
}

export interface AttCaptureAnalysis {
  format: "wireshark-json" | "event-json" | "csv" | "text";
  events: AttCaptureEvent[];
  writes: number;
  notifications: number;
  brncFrames: number;
  validCrcFrames: number;
  protobufFields: AttProtoField[];
  correlations: AttWriteCorrelation[];
  warnings: string[];
  privacy: string;
}

const UUID_RE = /^[0-9a-f]{4,8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const HEX_RE = /^(?:[0-9a-f]{2}[\s:.-]?)+$/i;

function cleanHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/(?:0x|[^0-9a-f])/gi, "");
  if (!compact || compact.length % 2 || !HEX_RE.test(value.trim().replace(/^0x/i, ""))) return null;
  return compact.toLowerCase();
}

function bytesOf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function firstValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value != null) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function flatten(value: unknown, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value || typeof value !== "object") return out;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child && typeof child === "object" && !Array.isArray(child)) flatten(child, out);
    else out[key] = child;
  }
  return out;
}

function directionFrom(value: unknown): AttDirection {
  const text = String(value ?? "").toLowerCase();
  const opcode = Number.parseInt(text.replace(/^0x/, ""), 16);
  if (/notification|notify/.test(text) || opcode === 0x1b) return "notify";
  if (/indication|indicate/.test(text) || opcode === 0x1d) return "indicate";
  if (/write command|write request|write cmd/.test(text) || opcode === 0x12 || opcode === 0x52) return "write";
  if (/read request/.test(text) || opcode === 0x0a) return "read";
  if (/response|confirmation/.test(text) || [0x0b, 0x13, 0x1e].includes(opcode)) return "response";
  return "unknown";
}

function eventFromRecord(record: Record<string, unknown>, index: number): AttCaptureEvent | null {
  const flat = flatten(record);
  const rawValue = firstValue(flat, [
    "valueHex", "value", "data", "payload", "btatt.value", "btgatt.uuid0x2a52", "btatt.handle_value",
  ]);
  const valueHex = cleanHex(rawValue);
  if (!valueHex) return null;
  const rawTime = firstValue(flat, ["atMs", "time_ms", "frame.time_epoch", "timestamp", "time", "frame.time_relative"]);
  const numericTime = Number(rawTime);
  const atMs = Number.isFinite(numericTime)
    ? numericTime > 10_000_000 ? numericTime * 1000 : numericTime
    : index;
  const rawOpcode = firstValue(flat, ["direction", "type", "event", "btatt.opcode", "opcode", "operation"]);
  const rawUuid = firstValue(flat, ["characteristic", "characteristicUuid", "btatt.uuid128", "btatt.uuid", "uuid"]);
  const characteristic = typeof rawUuid === "string" && UUID_RE.test(rawUuid) ? rawUuid.toLowerCase() : null;
  const rawHandle = firstValue(flat, ["handle", "btatt.handle"]);
  return {
    index,
    atMs,
    direction: directionFrom(rawOpcode),
    characteristic,
    handle: rawHandle == null ? null : String(rawHandle),
    opcode: rawOpcode == null ? null : String(rawOpcode),
    valueHex,
    bytes: valueHex.length / 2,
  };
}

function csvRows(text: string): string[][] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const cells: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') quoted = !quoted;
      else if (char === "," && !quoted) { cells.push(cell.trim()); cell = ""; }
      else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  });
}

function parseCsv(text: string): AttCaptureEvent[] {
  const rows = csvRows(text);
  const headers = (rows.shift() ?? []).map((h) => h.toLowerCase().replace(/[^a-z0-9]/g, ""));
  const aliases: Record<string, string[]> = {
    atMs: ["atms", "timems", "time", "timestamp", "frametimeepoch", "frametimerelative"],
    direction: ["direction", "type", "event", "opcode", "btattopcode", "operation"],
    characteristic: ["characteristic", "characteristicuuid", "uuid", "btattuuid128", "btattuuid"],
    handle: ["handle", "btatthandle"], valueHex: ["valuehex", "value", "data", "payload", "btattvalue"],
  };
  return rows.flatMap((row, index) => {
    const record: Record<string, unknown> = {};
    for (const [target, names] of Object.entries(aliases)) {
      const column = headers.findIndex((header) => names.includes(header));
      if (column >= 0) record[target] = row[column];
    }
    const event = eventFromRecord(record, index);
    return event ? [event] : [];
  });
}

function parseText(text: string): AttCaptureEvent[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const direction = line.match(/\b(write(?: request| command)?|notification|notify|indication|read response|response)\b/i)?.[1];
    const uuid = line.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/i)?.[0];
    const labelled = line.match(/(?:value|data|payload)\s*[=:]\s*((?:[0-9a-f]{2}[\s:.-]?){2,})/i)?.[1];
    if (!direction || !labelled) return [];
    const event = eventFromRecord({ direction, characteristic: uuid, valueHex: labelled, atMs: index }, index);
    return event ? [event] : [];
  });
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let shift = 0;
  for (let i = start; i < bytes.length && shift <= 49; i++) {
    const byte = bytes[i] as number;
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return { value, next: i + 1 };
    shift += 7;
  }
  return null;
}

interface ProtoObservation { path: string; wire: number; length: number | null; scalar: number | null }

function protoObservations(bytes: Uint8Array, prefix = "", depth = 0): ProtoObservation[] {
  if (depth > 5) return [];
  const out: ProtoObservation[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) return out;
    offset = key.next;
    const field = key.value >>> 3;
    const wire = key.value & 7;
    if (!field) return out;
    const path = prefix ? `${prefix}.${field}` : String(field);
    if (wire === 0) {
      const scalar = readVarint(bytes, offset);
      if (!scalar) return out;
      offset = scalar.next;
      out.push({ path, wire, length: null, scalar: scalar.value });
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (offset + length > bytes.length) return out;
      out.push({ path, wire, length, scalar: null });
      offset += length;
    } else if (wire === 2) {
      const lengthValue = readVarint(bytes, offset);
      if (!lengthValue || lengthValue.value < 0 || lengthValue.next + lengthValue.value > bytes.length) return out;
      offset = lengthValue.next;
      const body = bytes.subarray(offset, offset + lengthValue.value);
      out.push({ path, wire, length: body.length, scalar: null });
      out.push(...protoObservations(body, path, depth + 1));
      offset += body.length;
    } else return out;
  }
  return out;
}

function framedPayloads(events: AttCaptureEvent[]): { payloads: Uint8Array[]; frames: number; valid: number } {
  const payloads: Uint8Array[] = [];
  let frames = 0;
  let valid = 0;
  for (const direction of ["write", "notify", "indicate", "response"] as const) {
    const joined = events.filter((event) => event.direction === direction).flatMap((event) => [...bytesOf(event.valueHex)]);
    let offset = 0;
    while (offset + 8 <= joined.length) {
      const start = joined.findIndex((byte, i) => i >= offset && byte === 0x42 && joined[i + 1] === 0x52 && joined[i + 2] === 0x4e && joined[i + 3] === 0x43);
      if (start < 0 || start + 8 > joined.length) break;
      const le = (joined[start + 6] as number) | ((joined[start + 7] as number) << 8);
      const be = ((joined[start + 6] as number) << 8) | (joined[start + 7] as number);
      let advanced = false;
      for (const length of [le, be]) {
        if (length > 4096 || start + length + 10 > joined.length) continue;
        const frame = Uint8Array.from(joined.slice(start, start + length + 10));
        const seenLe = (frame[frame.length - 2] as number) | ((frame[frame.length - 1] as number) << 8);
        const seenBe = ((frame[frame.length - 2] as number) << 8) | (frame[frame.length - 1] as number);
        const body = frame.subarray(0, frame.length - 2);
        frames++;
        if ([crc16Modbus(body), crc16CcittFalse(body)].some((crc) => crc === seenLe || crc === seenBe)) {
          valid++;
          payloads.push(frame.subarray(8, frame.length - 2));
        }
        offset = start + frame.length;
        advanced = true;
        break;
      }
      if (!advanced) offset = start + 1;
    }
  }
  return { payloads, frames, valid };
}

function census(payloads: Uint8Array[]): AttProtoField[] {
  const fields = new Map<string, AttProtoField>();
  for (const payload of payloads) for (const observation of protoObservations(payload)) {
    const key = `${observation.path}/${observation.wire}`;
    const current = fields.get(key) ?? {
      path: observation.path, wireType: observation.wire, occurrences: 0,
      minLength: observation.length, maxLength: observation.length, scalarValues: [],
    };
    current.occurrences++;
    if (observation.length != null) {
      current.minLength = current.minLength == null ? observation.length : Math.min(current.minLength, observation.length);
      current.maxLength = current.maxLength == null ? observation.length : Math.max(current.maxLength, observation.length);
    }
    if (observation.scalar != null && !current.scalarValues.includes(observation.scalar) && current.scalarValues.length < 12) current.scalarValues.push(observation.scalar);
    fields.set(key, current);
  }
  return [...fields.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
}

function correlate(events: AttCaptureEvent[]): AttWriteCorrelation[] {
  const writes = events.filter((event) => event.direction === "write");
  return writes.map((write, writePosition) => {
    const nextWrite = writes[writePosition + 1];
    const replies = events.filter((event) =>
      ["notify", "indicate", "response"].includes(event.direction) &&
      event.atMs >= write.atMs && event.atMs <= Math.min(nextWrite?.atMs ?? Infinity, write.atMs + 5_000));
    return {
      writeIndex: write.index, atMs: write.atMs, characteristic: write.characteristic,
      valueHex: write.valueHex, replies: replies.length,
      firstReplyMs: replies[0] ? Math.max(0, replies[0].atMs - write.atMs) : null,
      notificationBytes: replies.reduce((sum, reply) => sum + reply.bytes, 0),
    };
  });
}

/** Parses Wireshark JSON, a simple event JSON/CSV, or labelled PacketLogger text locally. */
export function analyseAttCapture(text: string): AttCaptureAnalysis {
  let format: AttCaptureAnalysis["format"] = "text";
  let events: AttCaptureEvent[] = [];
  try {
    const parsed = JSON.parse(text) as unknown;
    const rows = Array.isArray(parsed) ? parsed : Array.isArray((parsed as { events?: unknown[] })?.events) ? (parsed as { events: unknown[] }).events : [];
    format = rows.some((row) => Boolean((row as Record<string, unknown>)?.["_source"])) ? "wireshark-json" : "event-json";
    events = rows.flatMap((row, index) => {
      const source = (row as { _source?: unknown })?._source ?? row;
      const event = eventFromRecord(source as Record<string, unknown>, index);
      return event ? [event] : [];
    });
  } catch {
    if (/^[^\n]*,/.test(text)) { format = "csv"; events = parseCsv(text); }
    else events = parseText(text);
  }
  events.sort((a, b) => a.atMs - b.atMs || a.index - b.index);
  events = events.map((event, index) => ({ ...event, index }));
  if (!events.length) throw new Error("No ATT writes or notifications with complete payload bytes were found.");
  const framed = framedPayloads(events);
  const warnings: string[] = [];
  if (!events.some((event) => event.direction === "write")) warnings.push("No command writes were found; include the connection and session-start portion of the capture.");
  if (!events.some((event) => event.direction === "notify" || event.direction === "indicate")) warnings.push("No notifications were found; the capture cannot show what made streaming begin.");
  if (!framed.frames) warnings.push("No BRNC envelopes were found. The FC-11 may use a different framing format, or the export omitted payload bytes.");
  else if (!framed.valid) warnings.push("BRNC-like frames were present, but none matched the tested MODBUS/CCITT CRC and byte orders.");
  return {
    format, events,
    writes: events.filter((event) => event.direction === "write").length,
    notifications: events.filter((event) => event.direction === "notify" || event.direction === "indicate").length,
    brncFrames: framed.frames, validCrcFrames: framed.valid,
    protobufFields: census(framed.payloads), correlations: correlate(events), warnings,
    privacy: "Device addresses, names and unrelated packet fields were discarded. Payload bytes remain because they are required to recover the protocol; review before sharing.",
  };
}

/** Exports only the ATT timeline and derived evidence, excluding source-capture metadata. */
export function sanitisedAttAnalysisJson(analysis: AttCaptureAnalysis): string {
  return JSON.stringify({ schemaVersion: 1, kind: "fc11-att-analysis", exportedAt: new Date().toISOString(), ...analysis }, null, 2);
}
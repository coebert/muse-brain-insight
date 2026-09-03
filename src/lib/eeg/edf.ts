/**
 * Minimal EDF (European Data Format) reader.
 *
 * Public clinical EEG collections publish raw signals as EDF rather than CSV.
 * Only what the intake needs is implemented: the header, the signal table, and
 * one selected channel decoded to microvolts. Whole-file decoding is avoided
 * deliberately — a one-hour 23-channel record is tens of megabytes and only the
 * frontal channel is comparable with the app's own montage.
 *
 * EDF+ annotation signals are ignored; interval labels come from each
 * collection's published summary files instead.
 */

const HEADER_BYTES = 256;
const LABEL_BYTES = 16;

export interface EdfHeader {
  /** Channel labels as published, trimmed. */
  channels: string[];
  /** Samples per data record for each channel. */
  samplesPerRecord: number[];
  numRecords: number;
  recordDurationSeconds: number;
  headerBytes: number;
  physicalMin: number[];
  physicalMax: number[];
  digitalMin: number[];
  digitalMax: number[];
  units: string[];
}

export interface EdfChannel {
  channel: string;
  sampleRate: number;
  /** Signal in microvolts, oldest sample first. */
  signal: Float64Array;
  durationSeconds: number;
}

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  new TextDecoder("latin1").decode(bytes.subarray(from, from + length)).trim();

const num = (bytes: Uint8Array, from: number, length: number) => {
  const v = Number(ascii(bytes, from, length));
  return Number.isFinite(v) ? v : Number.NaN;
};

/** Read the fixed header plus the per-signal table. Cheap: header bytes only. */
export function parseEdfHeader(bytes: Uint8Array): EdfHeader {
  if (bytes.byteLength < HEADER_BYTES) throw new Error("file is too short to be EDF");
  const headerBytes = num(bytes, 184, 8);
  const numRecords = num(bytes, 236, 8);
  const recordDurationSeconds = num(bytes, 244, 8);
  const ns = num(bytes, 252, 4);
  if (!Number.isFinite(ns) || ns <= 0) throw new Error("EDF header declares no signals");
  if (!Number.isFinite(recordDurationSeconds) || recordDurationSeconds <= 0) {
    throw new Error("EDF header declares no record duration");
  }

  // The signal table is a sequence of fixed-width blocks, each holding one
  // field for every signal in turn, so a block's offset is the running sum of
  // the widths before it — not a multiple of one width.
  const widths = [LABEL_BYTES, 80, 8, 8, 8, 8, 8, 80, 8, 32];
  const blockStart = (index: number) =>
    HEADER_BYTES + widths.slice(0, index).reduce((a, w) => a + w * ns, 0);
  const read = <T,>(index: number, map: (start: number, width: number) => T): T[] => {
    const width = widths[index]!;
    const start = blockStart(index);
    return Array.from({ length: ns }, (_, i) => map(start + i * width, width));
  };
  const strings = (index: number) => read(index, (s, w) => ascii(bytes, s, w));
  const numbers = (index: number) => read(index, (s, w) => num(bytes, s, w));

  return {
    channels: strings(0),
    units: strings(2),
    physicalMin: numbers(3),
    physicalMax: numbers(4),
    digitalMin: numbers(5),
    digitalMax: numbers(6),
    samplesPerRecord: numbers(8),
    numRecords,
    recordDurationSeconds,
    headerBytes: Number.isFinite(headerBytes) ? headerBytes : HEADER_BYTES * (ns + 1),
  };
}

/**
 * Pick the first channel whose label matches one of `preferred`, ignoring case,
 * spaces and an "EEG " prefix. Falls back to the first non-annotation channel,
 * so a record with an unexpected montage still yields a usable trace.
 */
export function pickEdfChannel(channels: string[], preferred: string[]): number {
  const norm = (s: string) => s.replace(/^eeg\s*/i, "").replace(/[\s.]/g, "").toUpperCase();
  const normalised = channels.map(norm);
  for (const want of preferred) {
    const i = normalised.indexOf(norm(want));
    if (i >= 0) return i;
  }
  const fallback = channels.findIndex((c) => !/annotation/i.test(c));
  return fallback >= 0 ? fallback : 0;
}

/**
 * Decode one channel to microvolts. Samples are 16-bit little-endian integers
 * scaled by the header's digital→physical mapping; a millivolt unit is
 * converted so every stored epoch is on one amplitude scale.
 */
export function readEdfChannel(
  bytes: Uint8Array,
  preferred: string[],
  header = parseEdfHeader(bytes),
): EdfChannel {
  const index = pickEdfChannel(header.channels, preferred);
  const spr = header.samplesPerRecord;
  const perRecord = spr[index] ?? 0;
  if (!perRecord) throw new Error(`channel ${header.channels[index]} carries no samples`);

  const recordSamples = spr.reduce((a, b) => a + b, 0);
  const offsetSamples = spr.slice(0, index).reduce((a, b) => a + b, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart = header.headerBytes;
  const available = Math.floor((bytes.byteLength - dataStart) / (recordSamples * 2));
  // Truncated downloads are common; keep whatever complete records arrived.
  const records = Math.max(0, Math.min(header.numRecords, available));
  if (!records) throw new Error("EDF file carries no complete data records");

  const dMin = header.digitalMin[index] ?? -32768;
  const dMax = header.digitalMax[index] ?? 32767;
  const pMin = header.physicalMin[index] ?? -1;
  const pMax = header.physicalMax[index] ?? 1;
  const span = dMax - dMin;
  const gain = span === 0 ? 1 : (pMax - pMin) / span;
  const unit = (header.units[index] ?? "uV").toLowerCase();
  const toMicrovolts = unit.startsWith("mv") ? 1000 : unit.startsWith("v") ? 1_000_000 : 1;

  const out = new Float64Array(records * perRecord);
  let w = 0;
  for (let r = 0; r < records; r++) {
    let p = dataStart + (r * recordSamples + offsetSamples) * 2;
    for (let s = 0; s < perRecord; s++, p += 2) {
      const digital = view.getInt16(p, true);
      out[w++] = (pMin + (digital - dMin) * gain) * toMicrovolts;
    }
  }

  return {
    channel: header.channels[index] ?? "eeg",
    sampleRate: perRecord / header.recordDurationSeconds,
    signal: out,
    durationSeconds: records * header.recordDurationSeconds,
  };
}

/* ------------------------------------------------------------ streaming --- */

/** Bytes occupied by one EDF data record (all signals interleaved). */
export function edfRecordBytes(header: EdfHeader): number {
  return header.samplesPerRecord.reduce((a, b) => a + b, 0) * 2;
}

export interface EdfChunkPlan {
  /** Index of the first data record in this chunk. */
  firstRecord: number;
  records: number;
  /** Inclusive byte range to request for this chunk. */
  startByte: number;
  endByte: number;
  startSeconds: number;
}

/**
 * Split a whole recording into record-aligned byte ranges. Whole-anaesthetic
 * EDFs run to hundreds of megabytes, which no serverless worker can hold; the
 * chunks are decoded one at a time and only derived epochs are kept.
 */
export function planEdfChunks(header: EdfHeader, targetBytes: number): EdfChunkPlan[] {
  const recordBytes = edfRecordBytes(header);
  if (!recordBytes || !Number.isFinite(header.numRecords) || header.numRecords <= 0) return [];
  const perChunk = Math.max(1, Math.floor(Math.max(recordBytes, targetBytes) / recordBytes));
  const out: EdfChunkPlan[] = [];
  for (let first = 0; first < header.numRecords; first += perChunk) {
    const records = Math.min(perChunk, header.numRecords - first);
    const startByte = header.headerBytes + first * recordBytes;
    out.push({
      firstRecord: first,
      records,
      startByte,
      endByte: startByte + records * recordBytes - 1,
      startSeconds: first * header.recordDurationSeconds,
    });
  }
  return out;
}

/**
 * Decode one channel from a slab of *data records only* (no header bytes),
 * such as the body of an HTTP range response planned by `planEdfChunks`.
 * Incomplete trailing records are ignored rather than producing torn samples.
 */
export function decodeEdfChunk(
  dataBytes: Uint8Array,
  header: EdfHeader,
  channelIndex: number,
): EdfChannel {
  const spr = header.samplesPerRecord;
  const perRecord = spr[channelIndex] ?? 0;
  if (!perRecord) throw new Error(`channel ${header.channels[channelIndex]} carries no samples`);
  const recordSamples = spr.reduce((a, b) => a + b, 0);
  const offsetSamples = spr.slice(0, channelIndex).reduce((a, b) => a + b, 0);
  const records = Math.floor(dataBytes.byteLength / (recordSamples * 2));
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);

  const dMin = header.digitalMin[channelIndex] ?? -32768;
  const dMax = header.digitalMax[channelIndex] ?? 32767;
  const pMin = header.physicalMin[channelIndex] ?? -1;
  const pMax = header.physicalMax[channelIndex] ?? 1;
  const span = dMax - dMin;
  const gain = span === 0 ? 1 : (pMax - pMin) / span;
  const unit = (header.units[channelIndex] ?? "uV").toLowerCase();
  const toMicrovolts = unit.startsWith("mv") ? 1000 : unit.startsWith("v") ? 1_000_000 : 1;

  const out = new Float64Array(records * perRecord);
  let w = 0;
  for (let r = 0; r < records; r++) {
    let p = (r * recordSamples + offsetSamples) * 2;
    for (let s = 0; s < perRecord; s++, p += 2) {
      out[w++] = (pMin + (view.getInt16(p, true) - dMin) * gain) * toMicrovolts;
    }
  }
  return {
    channel: header.channels[channelIndex] ?? "eeg",
    sampleRate: perRecord / header.recordDurationSeconds,
    signal: out,
    durationSeconds: records * header.recordDurationSeconds,
  };
}

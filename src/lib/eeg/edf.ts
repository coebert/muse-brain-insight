/**
 * Minimal EDF / EDF+ / BDF reader.
 *
 * Public clinical EEG collections publish raw signals as EDF rather than CSV.
 * Only what the intake needs is implemented: the header, the signal table, one
 * selected channel decoded to microvolts, and — for EDF+ files such as the
 * OpenNeuro sleep records — the annotation track that carries the scored
 * intervals inside the recording itself.
 *
 * Whole-file decoding of every channel is avoided deliberately: a whole-night
 * 23-channel record is hundreds of megabytes and only the frontal channel is
 * comparable with the app's own montage.
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
  /** 2 for EDF/EDF+, 3 for BDF (BioSemi 24-bit). */
  bytesPerSample: number;
  /** Indices of EDF+ annotation channels, which carry text rather than signal. */
  annotationChannels: number[];
  /** EDF+D: data records are not contiguous in time. */
  discontinuous: boolean;
}

export interface EdfChannel {
  channel: string;
  sampleRate: number;
  /** Signal in microvolts, oldest sample first. */
  signal: Float64Array;
  durationSeconds: number;
}

/** One scored interval taken from an EDF+ annotation track. */
export interface EdfAnnotation {
  onsetSeconds: number;
  durationSeconds: number;
  text: string;
}

const latin1 = new TextDecoder("latin1");

const ascii = (bytes: Uint8Array, from: number, length: number) =>
  latin1.decode(bytes.subarray(from, from + length)).trim();

const num = (bytes: Uint8Array, from: number, length: number) => {
  const v = Number(ascii(bytes, from, length));
  return Number.isFinite(v) ? v : Number.NaN;
};

const isAnnotationLabel = (label: string) => /annotation/i.test(label);

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

  // BioSemi BDF marks itself with a 0xFF first byte and "BIOSEMI"; its samples
  // are three bytes rather than two. Everything else in the layout matches EDF.
  const reserved = ascii(bytes, 192, 44);
  const isBdf = bytes[0] === 0xff || /biosemi/i.test(ascii(bytes, 1, 7));
  const discontinuous = /^EDF\+D/i.test(reserved);

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

  const channels = strings(0);
  return {
    channels,
    units: strings(2),
    physicalMin: numbers(3),
    physicalMax: numbers(4),
    digitalMin: numbers(5),
    digitalMax: numbers(6),
    samplesPerRecord: numbers(8),
    numRecords,
    recordDurationSeconds,
    headerBytes: Number.isFinite(headerBytes) ? headerBytes : HEADER_BYTES * (ns + 1),
    bytesPerSample: isBdf ? 3 : 2,
    annotationChannels: channels
      .map((c, i) => (isAnnotationLabel(c) ? i : -1))
      .filter((i) => i >= 0),
    discontinuous,
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
    if (i >= 0 && !isAnnotationLabel(channels[i] ?? "")) return i;
  }
  const fallback = channels.findIndex((c) => !isAnnotationLabel(c));
  return fallback >= 0 ? fallback : 0;
}

/** Signed sample at a byte offset: 16-bit EDF or 24-bit BDF, little-endian. */
function sampleAt(view: DataView, offset: number, bytesPerSample: number): number {
  if (bytesPerSample === 3) {
    const raw =
      view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    return raw & 0x800000 ? raw - 0x1000000 : raw;
  }
  return view.getInt16(offset, true);
}

interface Scale {
  pMin: number;
  dMin: number;
  gain: number;
  toMicrovolts: number;
}

function scaleFor(header: EdfHeader, index: number): Scale {
  const dMin = header.digitalMin[index] ?? -32768;
  const dMax = header.digitalMax[index] ?? 32767;
  const pMin = header.physicalMin[index] ?? -1;
  const pMax = header.physicalMax[index] ?? 1;
  const span = dMax - dMin;
  const unit = (header.units[index] ?? "uV").toLowerCase();
  return {
    pMin,
    dMin,
    gain: span === 0 ? 1 : (pMax - pMin) / span,
    toMicrovolts: unit.startsWith("mv") ? 1000 : unit.startsWith("v") ? 1_000_000 : 1,
  };
}

/**
 * Decode one channel to microvolts, scaled by the header's digital→physical
 * mapping; a millivolt or volt unit is converted so every stored epoch is on
 * one amplitude scale.
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

  const width = header.bytesPerSample;
  const recordSamples = spr.reduce((a, b) => a + b, 0);
  const offsetSamples = spr.slice(0, index).reduce((a, b) => a + b, 0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dataStart = header.headerBytes;
  const available = Math.floor((bytes.byteLength - dataStart) / (recordSamples * width));
  // Truncated downloads are common; keep whatever complete records arrived.
  const records = Math.max(0, Math.min(header.numRecords, available));
  if (!records) throw new Error("EDF file carries no complete data records");

  const { pMin, dMin, gain, toMicrovolts } = scaleFor(header, index);
  const out = new Float64Array(records * perRecord);
  let w = 0;
  for (let r = 0; r < records; r++) {
    let p = dataStart + (r * recordSamples + offsetSamples) * width;
    for (let s = 0; s < perRecord; s++, p += width) {
      out[w++] = (pMin + (sampleAt(view, p, width) - dMin) * gain) * toMicrovolts;
    }
  }

  return {
    channel: header.channels[index] ?? "eeg",
    sampleRate: perRecord / header.recordDurationSeconds,
    signal: out,
    durationSeconds: records * header.recordDurationSeconds,
  };
}

/* ---------------------------------------------------------- annotations --- */

/**
 * Decode the EDF+ annotation track: the scored intervals a sleep or
 * suppression record carries inside the file itself, so no separate label
 * file is needed.
 *
 * Each data record holds one or more "TALs" — onset, optional duration, then
 * one or more texts — separated by control bytes and padded with NULs. The
 * first TAL of a record is a timekeeping stamp with no text and is skipped.
 */
export function readEdfAnnotations(
  bytes: Uint8Array,
  header = parseEdfHeader(bytes),
): EdfAnnotation[] {
  if (!header.annotationChannels.length) return [];
  const width = header.bytesPerSample;
  const spr = header.samplesPerRecord;
  const recordSamples = spr.reduce((a, b) => a + b, 0);
  if (!recordSamples) return [];
  const recordBytes = recordSamples * width;
  const available = Math.floor((bytes.byteLength - header.headerBytes) / recordBytes);
  const records = Math.max(0, Math.min(header.numRecords, available));

  const out: EdfAnnotation[] = [];
  for (let r = 0; r < records; r++) {
    for (const channel of header.annotationChannels) {
      const perRecord = spr[channel] ?? 0;
      if (!perRecord) continue;
      const offsetSamples = spr.slice(0, channel).reduce((a, b) => a + b, 0);
      const start = header.headerBytes + r * recordBytes + offsetSamples * width;
      const text = latin1.decode(bytes.subarray(start, start + perRecord * width));
      out.push(...parseTalBlock(text));
    }
  }
  // Records repeat the timekeeping stamp; keep one entry per onset+text pair.
  const seen = new Set<string>();
  return out.filter((a) => {
    const key = `${a.onsetSeconds}|${a.durationSeconds}|${a.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Parse the NUL-separated TALs held in one annotation-channel block. */
export function parseTalBlock(block: string): EdfAnnotation[] {
  const out: EdfAnnotation[] = [];
  for (const tal of block.split("\u0000")) {
    if (!tal) continue;
    const parts = tal.split("\u0014");
    const head = parts.shift() ?? "";
    const [onsetRaw, durationRaw] = head.split("\u0015");
    const onset = Number(onsetRaw);
    if (!Number.isFinite(onset)) continue;
    const duration = Number(durationRaw);
    for (const raw of parts) {
      const label = raw.replace(/\u0000/g, "").trim();
      if (!label) continue; // timekeeping stamp, or the trailing empty field
      out.push({
        onsetSeconds: onset,
        durationSeconds: Number.isFinite(duration) ? duration : 0,
        text: label,
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------ streaming --- */

/** Bytes occupied by one EDF data record (all signals interleaved). */
export function edfRecordBytes(header: EdfHeader): number {
  return header.samplesPerRecord.reduce((a, b) => a + b, 0) * header.bytesPerSample;
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
  const width = header.bytesPerSample;
  const recordSamples = spr.reduce((a, b) => a + b, 0);
  const offsetSamples = spr.slice(0, channelIndex).reduce((a, b) => a + b, 0);
  const records = Math.floor(dataBytes.byteLength / (recordSamples * width));
  const view = new DataView(dataBytes.buffer, dataBytes.byteOffset, dataBytes.byteLength);

  const { pMin, dMin, gain, toMicrovolts } = scaleFor(header, channelIndex);
  const out = new Float64Array(records * perRecord);
  let w = 0;
  for (let r = 0; r < records; r++) {
    let p = (r * recordSamples + offsetSamples) * width;
    for (let s = 0; s < perRecord; s++, p += width) {
      out[w++] = (pMin + (sampleAt(view, p, width) - dMin) * gain) * toMicrovolts;
    }
  }
  return {
    channel: header.channels[channelIndex] ?? "eeg",
    sampleRate: perRecord / header.recordDurationSeconds,
    signal: out,
    durationSeconds: records * header.recordDurationSeconds,
  };
}

/**
 * Generic EEG ingest.
 *
 * Everything downstream of the monitor (DSA, SEF95, suppression ratio, depth
 * index, COEBIS) assumes four frontal/temporal channels of microvolts at
 * 256 Hz. This module lets non-Muse hardware feed that pipeline by
 *
 *   1. parsing a sample stream out of a transport (CSV file, serial line
 *      protocol, or an LSL→WebSocket bridge),
 *   2. converting whatever amplitude unit the device emits into microvolts,
 *   3. resampling the device's rate onto the analysis rate,
 *   4. mapping the device's channel names onto the four analysis electrodes.
 *
 * Replay is deliberately paced in real time: the analyser is a streaming
 * component with time-based epoching, so a file dumped in at once would
 * collapse the whole recording into a single epoch.
 */

import { MUSE_SAMPLE_RATE } from "@/lib/eeg/dsp";
import {
  MUSE_CHANNELS,
  type EegSource,
  type MuseChannel,
  type SampleHandler,
  type SourceState,
  type SourceStateHandler,
} from "@/lib/eeg/muse";

/** Amplitude unit a device reports its samples in. */
export type AmplitudeUnit = "uV" | "mV" | "V" | "counts";

export const AMPLITUDE_UNITS: { value: AmplitudeUnit; label: string; detail: string }[] = [
  { value: "uV", label: "Microvolts (µV)", detail: "Already in analysis units — no scaling." },
  { value: "mV", label: "Millivolts (mV)", detail: "Multiplied by 1000." },
  { value: "V", label: "Volts (V)", detail: "Multiplied by 1 000 000 — common in EDF/BDF exports." },
  {
    value: "counts",
    label: "Raw ADC counts",
    detail: "Needs the device's µV-per-count scale factor (e.g. 0.02235 for an OpenBCI Cyton).",
  },
];

/** Fixed multiplier that converts one sample in `unit` into microvolts. */
export function unitScale(unit: AmplitudeUnit, uvPerCount = 1): number {
  switch (unit) {
    case "uV":
      return 1;
    case "mV":
      return 1_000;
    case "V":
      return 1_000_000;
    case "counts":
      return Number.isFinite(uvPerCount) && uvPerCount > 0 ? uvPerCount : 1;
  }
}

/**
 * Guesses the amplitude unit from the signal itself. Scalp EEG sits around
 * 5–200 µV peak, so the order of magnitude of a robust amplitude estimate
 * identifies the unit far more reliably than a file header does.
 */
export function inferUnit(samples: number[]): { unit: AmplitudeUnit; p95: number } {
  const finite = samples.filter((v) => Number.isFinite(v)).map(Math.abs);
  if (finite.length === 0) return { unit: "uV", p95: 0 };
  finite.sort((a, b) => a - b);
  const p95 = finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.95))] ?? 0;
  if (p95 === 0) return { unit: "uV", p95 };
  if (p95 < 0.02) return { unit: "V", p95 };
  if (p95 < 20) return { unit: "mV", p95 };
  if (p95 > 5_000) return { unit: "counts", p95 };
  return { unit: "uV", p95 };
}

/** Per-channel amplitude sanity check after conversion to µV. */
export interface AmplitudeCheck {
  ok: boolean;
  p95uV: number;
  note: string;
}

export function checkAmplitude(samples: number[], scale: number): AmplitudeCheck {
  const { p95 } = inferUnit(samples);
  const p95uV = p95 * scale;
  if (p95uV === 0) return { ok: false, p95uV, note: "Flat trace — no signal in this column." };
  if (p95uV < 2)
    return {
      ok: false,
      p95uV,
      note: "Below 2 µV after scaling — the unit or scale factor is probably too small.",
    };
  if (p95uV > 2_000)
    return {
      ok: false,
      p95uV,
      note: "Above 2000 µV after scaling — the unit or scale factor is probably too large.",
    };
  return { ok: true, p95uV, note: "Plausible scalp EEG amplitude." };
}

/* ------------------------------------------------------------------ */
/* Resampling                                                          */
/* ------------------------------------------------------------------ */

/**
 * Streaming linear-interpolation resampler. It keeps the last input sample
 * and the fractional read position across calls, so chunk boundaries do not
 * introduce a discontinuity — a step at every chunk edge would show up as
 * broadband noise in the DSA and inflate the seizure score.
 */
export class Resampler {
  private previous: number | null = null;
  /** Position of the next output sample, in input-sample units from `previous`. */
  private phase = 0;
  private readonly step: number;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new Error("Sample rates must be positive.");
    this.step = fromRate / toRate;
  }

  /** Feeds input samples and returns the output samples produced so far. */
  process(input: ArrayLike<number>): Float64Array {
    const out: number[] = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i] as number;
      if (this.previous === null) {
        this.previous = current;
        out.push(current);
        this.phase = this.step;
        continue;
      }
      // Emit every output sample that falls inside [previous, current).
      while (this.phase <= 1) {
        out.push(this.previous + (current - this.previous) * this.phase);
        this.phase += this.step;
      }
      this.phase -= 1;
      this.previous = current;
    }
    return Float64Array.from(out);
  }

  reset() {
    this.previous = null;
    this.phase = 0;
  }
}

/** One-shot resample of a whole array (used for previews and tests). */
export function resample(input: ArrayLike<number>, fromRate: number, toRate: number): Float64Array {
  if (fromRate === toRate) return Float64Array.from(input as ArrayLike<number>);
  return new Resampler(fromRate, toRate).process(input);
}

/* ------------------------------------------------------------------ */
/* CSV parsing                                                         */
/* ------------------------------------------------------------------ */

export interface ParsedCsv {
  /** Column names, synthesised as "col 1…" when the file has no header. */
  columns: string[];
  /** Column-major numeric data, one array per column. */
  data: number[][];
  /** Index of the detected time column, or null when none was found. */
  timeColumn: number | null;
  /** Sample rate inferred from the time column, or null when unknown. */
  inferredRate: number | null;
  rowCount: number;
  delimiter: string;
  hasHeader: boolean;
  /** Non-fatal parsing observations shown to the clinician. */
  warnings: string[];
}

function detectDelimiter(line: string): string {
  const candidates = [",", "\t", ";", " "];
  let best = ",";
  let bestCount = 0;
  for (const d of candidates) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function splitRow(line: string, delimiter: string): string[] {
  const parts = delimiter === " " ? line.trim().split(/\s+/) : line.split(delimiter);
  return parts.map((p) => p.trim());
}

function isNumeric(value: string): boolean {
  return value !== "" && Number.isFinite(Number(value));
}

/** Median of a numeric array (used for robust interval estimates). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : (((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Works out the sample rate from a time column, tolerating seconds,
 * milliseconds or microseconds — exporters disagree, and a rate that is out
 * by 1000 silently ruins every frequency-domain metric.
 */
export function inferRateFromTime(times: number[]): { rate: number; unit: "s" | "ms" | "us" } | null {
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    const d = (times[i] as number) - (times[i - 1] as number);
    if (Number.isFinite(d) && d > 0) diffs.push(d);
  }
  if (diffs.length < 8) return null;
  const step = median(diffs);
  if (!(step > 0)) return null;
  for (const [unit, perSecond] of [
    ["s", 1],
    ["ms", 1_000],
    ["us", 1_000_000],
  ] as const) {
    const rate = perSecond / step;
    if (rate >= 20 && rate <= 20_000) return { rate: Math.round(rate * 100) / 100, unit };
  }
  return null;
}

const TIME_NAME = /^(time|timestamp|t|secs?|seconds|ms|millis|sample_?time)$/i;

/** Parses a delimited EEG export into columns plus a sample-rate estimate. */
export function parseEegCsv(text: string, maxRows = 2_000_000): ParsedCsv {
  const warnings: string[] = [];
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#") && !l.startsWith("%"));
  if (lines.length === 0) throw new Error("The file has no readable rows.");

  const delimiter = detectDelimiter(lines[0] as string);
  const firstRow = splitRow(lines[0] as string, delimiter);
  const hasHeader = firstRow.some((cell) => !isNumeric(cell));
  const columns = hasHeader
    ? firstRow.map((cell, i) => (cell === "" ? `col ${i + 1}` : cell))
    : firstRow.map((_, i) => `col ${i + 1}`);

  const body = hasHeader ? lines.slice(1) : lines;
  if (body.length === 0) throw new Error("The file has a header but no data rows.");

  const data: number[][] = columns.map(() => []);
  let skipped = 0;
  const limit = Math.min(body.length, maxRows);
  for (let r = 0; r < limit; r++) {
    const cells = splitRow(body[r] as string, delimiter);
    if (cells.length < columns.length) {
      skipped++;
      continue;
    }
    for (let c = 0; c < columns.length; c++) {
      const raw = cells[c] as string;
      const value = Number(raw);
      (data[c] as number[]).push(Number.isFinite(value) ? value : Number.NaN);
    }
  }
  const rowCount = (data[0] as number[]).length;
  if (rowCount === 0) throw new Error("No numeric rows could be read from the file.");
  if (skipped > 0) warnings.push(`${skipped} short row(s) skipped.`);
  if (body.length > limit) warnings.push(`Only the first ${limit} rows were read.`);

  // A time column is either named like one, or is the first column and rises
  // monotonically at a plausible EEG interval.
  let timeColumn: number | null = null;
  for (let c = 0; c < columns.length; c++) {
    if (TIME_NAME.test((columns[c] as string).replace(/\s|\(.*\)/g, ""))) {
      timeColumn = c;
      break;
    }
  }
  if (timeColumn === null && rowCount > 8) {
    const first = data[0] as number[];
    const rising = first.every((v, i) => i === 0 || v > (first[i - 1] as number));
    if (rising && inferRateFromTime(first)) timeColumn = 0;
  }

  let inferredRate: number | null = null;
  if (timeColumn !== null) {
    const est = inferRateFromTime(data[timeColumn] as number[]);
    if (est) {
      inferredRate = est.rate;
      if (est.unit !== "s") warnings.push(`Time column read as ${est.unit}.`);
    } else {
      warnings.push("Time column found but the interval was irregular — set the rate manually.");
    }
  }

  return {
    columns,
    data,
    timeColumn,
    inferredRate,
    rowCount,
    delimiter,
    hasHeader,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Channel mapping                                                     */
/* ------------------------------------------------------------------ */

/** Maps each analysis electrode onto a source column name (or null). */
export type ChannelMap = Record<MuseChannel, string | null>;

export const EMPTY_CHANNEL_MAP: ChannelMap = { TP9: null, AF7: null, AF8: null, TP10: null };

/**
 * Best-effort automatic mapping. Exact electrode names win; otherwise the
 * usable columns are spread across the four analysis positions in order, so a
 * two-channel frontal device still lands on the two frontal electrodes.
 */
export function suggestChannelMap(columns: string[], skip: number[] = []): ChannelMap {
  const usable = columns.filter((_, i) => !skip.includes(i));
  const map: ChannelMap = { ...EMPTY_CHANNEL_MAP };
  const taken = new Set<string>();
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  // 1. Exact electrode names (TP9/AF7/AF8/TP10) anywhere in the column name.
  for (const electrode of MUSE_CHANNELS) {
    const hit = usable.find((c) => !taken.has(c) && norm(c).includes(norm(electrode)));
    if (hit) {
      map[electrode] = hit;
      taken.add(hit);
    }
  }
  // 2. Common frontal aliases from other headsets.
  const aliases: Partial<Record<MuseChannel, RegExp>> = {
    AF7: /(^|[^a-z])(fp1|af3|left ?front)/i,
    AF8: /(^|[^a-z])(fp2|af4|right ?front)/i,
    TP9: /(^|[^a-z])(t3|t7|left ?temp)/i,
    TP10: /(^|[^a-z])(t4|t8|right ?temp)/i,
  };
  for (const electrode of MUSE_CHANNELS) {
    if (map[electrode]) continue;
    const pattern = aliases[electrode];
    if (!pattern) continue;
    const hit = usable.find((c) => !taken.has(c) && pattern.test(c));
    if (hit) {
      map[electrode] = hit;
      taken.add(hit);
    }
  }
  // 3. Fill what is left in column order.
  const remaining = usable.filter((c) => !taken.has(c));
  for (const electrode of MUSE_CHANNELS) {
    if (map[electrode]) continue;
    const next = remaining.shift();
    if (!next) break;
    map[electrode] = next;
  }
  return map;
}

/** Describes what a channel map means clinically, including what is missing. */
export function describeChannelMap(map: ChannelMap): {
  mapped: MuseChannel[];
  missing: MuseChannel[];
  bilateral: boolean;
  note: string;
} {
  const mapped = MUSE_CHANNELS.filter((c) => map[c]);
  const missing = MUSE_CHANNELS.filter((c) => !map[c]);
  const left = Boolean(map.TP9 || map.AF7);
  const right = Boolean(map.AF8 || map.TP10);
  const bilateral = left && right;
  let note: string;
  if (mapped.length === 0) note = "No channels mapped — nothing will be analysed.";
  else if (mapped.length === 4) note = "Full four-electrode montage — all metrics behave as designed.";
  else if (bilateral)
    note = `${mapped.length} of 4 electrodes mapped. Both hemispheres are covered, but per-side quality gating has less to work with.`;
  else
    note = `${mapped.length} of 4 electrodes mapped on one side only. Hemispheric comparison, side preference and bilateral coherence are unavailable, and the unmapped side reads as a flat trace.`;
  return { mapped, missing, bilateral, note };
}

/* ------------------------------------------------------------------ */
/* Ingest configuration + base source                                  */
/* ------------------------------------------------------------------ */

export interface IngestConfig {
  /** Rate the device samples at, before resampling to the analysis rate. */
  sampleRate: number;
  unit: AmplitudeUnit;
  /** µV per ADC count; only used when `unit` is "counts". */
  uvPerCount?: number;
  channelMap: ChannelMap;
  /** Replay speed for file sources (1 = real time). */
  speed?: number;
  label?: string;
}

/** Column-major samples for one push into an ingest source. */
export type IngestFrame = Record<string, ArrayLike<number>>;

/**
 * Shared normalisation stage: unit conversion, resampling to the analysis
 * rate, and dispatch onto the analysis electrodes. Transports (file, serial,
 * bridge) feed it `push()` and never touch scaling themselves.
 */
export class IngestPipeline {
  private readonly scale: number;
  private readonly resamplers = new Map<MuseChannel, Resampler>();
  private readonly inverse = new Map<string, MuseChannel[]>();

  constructor(
    private readonly config: IngestConfig,
    private readonly onSamples: SampleHandler,
  ) {
    this.scale = unitScale(config.unit, config.uvPerCount ?? 1);
    for (const electrode of MUSE_CHANNELS) {
      const column = config.channelMap[electrode];
      if (!column) continue;
      const list = this.inverse.get(column) ?? [];
      list.push(electrode);
      this.inverse.set(column, list);
      this.resamplers.set(electrode, new Resampler(config.sampleRate, MUSE_SAMPLE_RATE));
    }
  }

  /** Number of analysis electrodes this configuration actually feeds. */
  get mappedCount(): number {
    return this.resamplers.size;
  }

  /** Converts, resamples and emits one frame of source samples. */
  push(frame: IngestFrame) {
    for (const [column, values] of Object.entries(frame)) {
      const electrodes = this.inverse.get(column);
      if (!electrodes) continue;
      for (const electrode of electrodes) {
        const resampler = this.resamplers.get(electrode);
        if (!resampler) continue;
        const scaled = new Float64Array(values.length);
        for (let i = 0; i < values.length; i++) {
          const v = (values as ArrayLike<number>)[i] as number;
          // A dropped sample must not become a spike: hold at zero instead.
          scaled[i] = Number.isFinite(v) ? v * this.scale : 0;
        }
        const out = resampler.process(scaled);
        if (out.length > 0) this.onSamples(electrode, out);
      }
    }
  }

  reset() {
    for (const r of this.resamplers.values()) r.reset();
  }
}

/** Progress of a file replay, reported so the clinician can see it advance. */
export interface ReplayProgress {
  /** 0–1 through the recording. */
  fraction: number;
  elapsedSeconds: number;
  totalSeconds: number;
  finished: boolean;
}

/**
 * Replays parsed samples in real time (or at a chosen speed) as if they were
 * arriving from hardware, so every streaming metric behaves exactly as it
 * does at the bedside.
 */
export class ReplaySource implements EegSource {
  readonly name: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pipeline: IngestPipeline | null = null;
  private cursor = 0;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;
  private progressCb: ((p: ReplayProgress) => void) | null = null;
  private readonly speed: number;
  private readonly totalSamples: number;

  constructor(
    /** Column-major source samples, keyed by column name. */
    private readonly columns: Record<string, ArrayLike<number>>,
    private readonly config: IngestConfig,
  ) {
    this.name = config.label ?? "File replay";
    this.speed = config.speed && config.speed > 0 ? config.speed : 1;
    this.totalSamples = Math.max(
      0,
      ...Object.values(columns).map((c) => (c as ArrayLike<number>).length),
    );
  }

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  /** Reports replay position; the panel uses it to show progress. */
  onProgress(cb: (p: ReplayProgress) => void) {
    this.progressCb = cb;
  }

  get durationSeconds(): number {
    return this.totalSamples / this.config.sampleRate;
  }

  async start(onSamples: SampleHandler) {
    if (this.totalSamples === 0) throw new Error("The recording has no samples to replay.");
    this.pipeline = new IngestPipeline(this.config, onSamples);
    if (this.pipeline.mappedCount === 0)
      throw new Error("Map at least one source column onto an analysis electrode.");
    this.cursor = 0;
    const tickMs = 100;
    const perTick = Math.max(1, Math.round((this.config.sampleRate * this.speed * tickMs) / 1000));
    this.stateCb?.({ kind: "connected" });
    this.timer = setInterval(() => {
      if (this.cursor >= this.totalSamples) {
        this.finish();
        return;
      }
      const end = Math.min(this.totalSamples, this.cursor + perTick);
      const frame: IngestFrame = {};
      for (const [column, values] of Object.entries(this.columns)) {
        const src = values as ArrayLike<number>;
        const slice = new Float64Array(Math.max(0, Math.min(end, src.length) - this.cursor));
        for (let i = 0; i < slice.length; i++) slice[i] = src[this.cursor + i] as number;
        if (slice.length > 0) frame[column] = slice;
      }
      this.pipeline?.push(frame);
      this.cursor = end;
      this.emitProgress(false);
    }, tickMs);
  }

  private emitProgress(finished: boolean) {
    this.progressCb?.({
      fraction: this.totalSamples ? this.cursor / this.totalSamples : 1,
      elapsedSeconds: this.cursor / this.config.sampleRate,
      totalSeconds: this.durationSeconds,
      finished,
    });
  }

  private finish() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emitProgress(true);
    // End of file is a clean stop, not a fault: the case stays open so the
    // recording can be reviewed and filed.
    this.stateCb?.({ kind: "lost", reason: "Replay finished — the whole file has been played." });
    this.disconnectCb?.();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/* ------------------------------------------------------------------ */
/* Line-oriented transports (serial + LSL bridge)                      */
/* ------------------------------------------------------------------ */

/**
 * Parses one line of a streaming text protocol into per-column values.
 * Accepts plain delimited numbers and JSON objects/arrays, which covers the
 * common serial firmwares and every LSL→WebSocket bridge we have seen.
 */
export function parseStreamLine(line: string, columns: string[]): IngestFrame | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith("%")) return null;

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return null;
    }
    // { "data": [[c0,c1,...], ...] } or { "TP9": [..], ... } or [c0, c1, ...]
    const frame: IngestFrame = {};
    const pushRow = (row: unknown) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, i) => {
        const column = columns[i];
        if (!column || typeof value !== "number") return;
        const existing = (frame[column] as number[] | undefined) ?? [];
        existing.push(value);
        frame[column] = existing;
      });
    };
    if (Array.isArray(payload)) {
      if (Array.isArray(payload[0])) payload.forEach(pushRow);
      else pushRow(payload);
    } else if (payload && typeof payload === "object") {
      const record = payload as Record<string, unknown>;
      const data = record["data"] ?? record["samples"] ?? record["chunk"];
      if (Array.isArray(data)) {
        if (Array.isArray(data[0])) data.forEach(pushRow);
        else pushRow(data);
      } else {
        for (const [key, value] of Object.entries(record)) {
          if (typeof value === "number") frame[key] = [value];
          else if (Array.isArray(value) && value.every((v) => typeof v === "number"))
            frame[key] = value as number[];
        }
      }
    }
    return Object.keys(frame).length > 0 ? frame : null;
  }

  const parts = splitRow(trimmed, detectDelimiter(trimmed));
  const frame: IngestFrame = {};
  parts.forEach((cell, i) => {
    const column = columns[i];
    if (!column) return;
    const value = Number(cell);
    if (Number.isFinite(value)) frame[column] = [value];
  });
  return Object.keys(frame).length > 0 ? frame : null;
}

/** True when this browser can open a serial port. */
export function isWebSerialAvailable(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

export const WEB_SERIAL_HELP =
  "Web Serial is unavailable in this browser. Use Chrome or Edge on desktop, or replay a CSV export instead.";

interface SerialOptions {
  baudRate: number;
  columns: string[];
  config: IngestConfig;
  port?: unknown;
}

/**
 * Reads a line-per-sample serial firmware (OpenBCI-style text mode, Arduino
 * sketches, most research amplifiers' debug output).
 */
export class SerialIngestSource implements EegSource {
  readonly name: string;
  private port: any = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private pipeline: IngestPipeline | null = null;
  private buffer = "";
  private stopping = false;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;

  constructor(private readonly options: SerialOptions) {
    this.name = options.config.label ?? `Serial ${options.baudRate} baud`;
  }

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  async start(onSamples: SampleHandler) {
    if (!isWebSerialAvailable()) throw new Error(WEB_SERIAL_HELP);
    this.stopping = false;
    this.pipeline = new IngestPipeline(this.options.config, onSamples);
    if (this.pipeline.mappedCount === 0)
      throw new Error("Map at least one source column onto an analysis electrode.");
    const serial = (navigator as unknown as { serial: any }).serial;
    this.port = this.options.port ?? (await serial.requestPort());
    await this.port.open({ baudRate: this.options.baudRate });
    this.stateCb?.({ kind: "connected" });
    void this.readLoop();
  }

  private async readLoop() {
    const decoder = new TextDecoder();
    try {
      while (this.port?.readable && !this.stopping) {
        this.reader = this.port.readable.getReader();
        try {
          for (;;) {
            const { value, done } = await this.reader!.read();
            if (done) break;
            if (!value) continue;
            this.buffer += decoder.decode(value, { stream: true });
            const lines = this.buffer.split(/\r?\n/);
            this.buffer = lines.pop() ?? "";
            for (const line of lines) {
              const frame = parseStreamLine(line, this.options.columns);
              if (frame) this.pipeline?.push(frame);
            }
          }
        } finally {
          this.reader?.releaseLock();
          this.reader = null;
        }
      }
    } catch (error) {
      if (!this.stopping) {
        const reason = error instanceof Error ? error.message : "Serial link lost.";
        this.stateCb?.({ kind: "lost", reason } satisfies SourceState);
        this.disconnectCb?.();
      }
    }
  }

  async stop() {
    this.stopping = true;
    try {
      await this.reader?.cancel();
    } catch {
      /* the port may already be gone */
    }
    try {
      await this.port?.close();
    } catch {
      /* ignore */
    }
    this.port = null;
  }
}

interface BridgeOptions {
  url: string;
  columns: string[];
  config: IngestConfig;
  /** Injectable for tests. */
  socketFactory?: (url: string) => WebSocket;
}

/**
 * Consumes an LSL (or any other) stream through a local WebSocket bridge.
 * Browsers cannot speak LSL directly, so a small relay on the recording
 * machine forwards the stream as text lines or JSON chunks.
 */
export class LslBridgeSource implements EegSource {
  readonly name: string;
  private socket: WebSocket | null = null;
  private pipeline: IngestPipeline | null = null;
  private stopping = false;
  private disconnectCb: (() => void) | null = null;
  private stateCb: SourceStateHandler | null = null;

  constructor(private readonly options: BridgeOptions) {
    this.name = options.config.label ?? `LSL bridge (${options.url})`;
  }

  onDisconnect(cb: () => void) {
    this.disconnectCb = cb;
  }

  onState(cb: SourceStateHandler) {
    this.stateCb = cb;
  }

  async start(onSamples: SampleHandler) {
    this.stopping = false;
    this.pipeline = new IngestPipeline(this.options.config, onSamples);
    if (this.pipeline.mappedCount === 0)
      throw new Error("Map at least one source column onto an analysis electrode.");
    const factory = this.options.socketFactory ?? ((url: string) => new WebSocket(url));
    const socket = factory(this.options.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The bridge did not answer within 8 s.")), 8000);
      socket.onopen = () => {
        clearTimeout(timeout);
        this.stateCb?.({ kind: "connected" });
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error(`Could not reach the bridge at ${this.options.url}.`));
      };
    });
    socket.onmessage = (event: MessageEvent) => {
      const text = typeof event.data === "string" ? event.data : "";
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const frame = parseStreamLine(line, this.options.columns);
        if (frame) this.pipeline?.push(frame);
      }
    };
    socket.onclose = () => {
      if (this.stopping) return;
      this.stateCb?.({ kind: "lost", reason: "The bridge closed the connection." });
      this.disconnectCb?.();
    };
  }

  async stop() {
    this.stopping = true;
    this.socket?.close();
    this.socket = null;
  }
}

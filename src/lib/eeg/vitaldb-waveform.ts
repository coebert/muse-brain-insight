/**
 * VitalDB raw EEG waveform import — turning reference-only cases into *paired*
 * readings COEBIS can actually be refitted on.
 *
 * VitalDB publishes the bedside EEG itself, not just the monitor numerics:
 *
 *   https://api.vitaldb.net/{caseid}?tracks=SNUADC/EEG1_WAV,SNUADC/EEG2_WAV,BIS/BIS,...
 *
 * The waveform tracks are the two frontal channels feeding the BIS sensor,
 * sampled at 128 Hz. Because we have the signal, we can replay it through the
 * app's own estimator — the same 4 s window, suppression rule and spectral
 * code path the bedside monitor uses — and obtain an app index for the same
 * second the commercial monitor reported a BIS. That pair {app index, BIS} is
 * what the refit needs and what a numerics-only VitalDB import can never give.
 *
 * Two honesty constraints are enforced here rather than left to the caller:
 *
 *  1. These are *not* Muse readings. They are filed under their own acquisition
 *     lineage (`vitaldb-snuadc|AF7-AF8|128`), so a fit trained on them is never
 *     silently applied to a Muse recording.
 *  2. A pair is only emitted when the replayed index and the monitor reading
 *     refer to the same moment within the match tolerance, and when the
 *     monitor's own signal-quality index passes; anything else is counted as
 *     rejected, not quietly dropped.
 */

import { lineageKey, type DataLineage } from "./model-lineage";
import { replayRawEeg } from "./replay";
import {
  ageBandOf,
  frailtyFromAsa,
  regimenOf,
  sexOf,
  VITALDB_SOURCE,
  type VitalDbCaseInfo,
  type VitalDbCovariates,
  type VitalDbTrackSample,
} from "./vitaldb";

/** Device id the VitalDB bedside frontal montage is filed under. */
export const VITALDB_WAVE_DEVICE_ID = "vitaldb-snuadc";
/** Native rate of the SNUADC EEG waveform tracks. */
export const VITALDB_WAVE_SAMPLE_RATE = 128;

/** Track list to request from the VitalDB API for a paired import. */
export const VITALDB_PAIRED_TRACKS =
  "SNUADC/EEG1_WAV,SNUADC/EEG2_WAV,BIS/BIS,BIS/SEF,BIS/SR,BIS/EMG,BIS/SQI," +
  "Orchestra/PPF20_CE,Orchestra/RFTN20_CE";

/**
 * SNUADC EEG1/EEG2 are the left and right frontal derivations under the BIS
 * sensor, so they occupy the app's frontal analysis positions.
 */
const WAVE_ALIASES: Record<string, "AF7" | "AF8"> = {
  "snuadc/eeg1_wav": "AF7",
  eeg1_wav: "AF7",
  eeg1: "AF7",
  "snuadc/eeg2_wav": "AF8",
  eeg2_wav: "AF8",
  eeg2: "AF8",
};

const TIME_KEYS = new Set(["time", "timestamp", "t", "seconds"]);

export interface VitalDbWaveChannel {
  channel: "AF7" | "AF8";
  samples: Float64Array;
}

export interface VitalDbWaveform {
  channels: VitalDbWaveChannel[];
  sampleRate: number;
  /** Seconds from case start at which the first waveform sample sits. */
  startSeconds: number;
  durationSeconds: number;
}

export function vitalDbWaveLineage(
  channels: ("AF7" | "AF8")[],
  sampleRate = VITALDB_WAVE_SAMPLE_RATE,
): DataLineage {
  return {
    deviceId: VITALDB_WAVE_DEVICE_ID,
    deviceLabel: "VitalDB bedside frontal EEG",
    transport: "ingest",
    channels: channels.slice().sort((a, b) => (a === "AF7" ? -1 : b === "AF7" ? 1 : 0)),
    sampleRate,
  };
}

function num(raw: string | undefined): number | null {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v || v.toLowerCase() === "nan" || v.toLowerCase() === "n/a") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a VitalDB track export that includes waveform columns.
 *
 * The API returns one row per waveform sample with the slow numeric tracks
 * blank in between, so the waveform grid — not the numeric grid — sets the
 * sample rate. Blank waveform cells inside the record are held at the previous
 * sample rather than zeroed, which would read as suppression.
 */
export function parseVitalDbWaveCsv(
  text: string,
  fallbackSampleRate = VITALDB_WAVE_SAMPLE_RATE,
): VitalDbWaveform {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) throw new Error("The waveform file is empty.");
  const header = lines[0]!.split(",").map((h) => h.trim().replace(/^"|"$/g, "").toLowerCase());
  const iTime = header.findIndex((h) => TIME_KEYS.has(h));
  const waveCols: { index: number; channel: "AF7" | "AF8" }[] = [];
  header.forEach((h, i) => {
    const ch = WAVE_ALIASES[h];
    if (ch && !waveCols.some((w) => w.channel === ch)) waveCols.push({ index: i, channel: ch });
  });
  if (!waveCols.length) {
    throw new Error(
      "No SNUADC/EEG*_WAV columns found — request the waveform tracks in the VitalDB URL.",
    );
  }

  const times: number[] = [];
  const buffers = waveCols.map(() => [] as number[]);
  const last = waveCols.map(() => 0);
  const seen = waveCols.map(() => false);

  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const values = waveCols.map((w) => num(cells[w.index]));
    // Rows carrying only slow numerics have no waveform sample at all.
    if (values.every((v) => v == null)) continue;
    values.forEach((v, c) => {
      if (v == null) {
        buffers[c]!.push(last[c]!);
      } else {
        last[c] = v;
        seen[c] = true;
        buffers[c]!.push(v);
      }
    });
    if (iTime >= 0) {
      const t = num(cells[iTime]);
      if (t != null) times.push(t);
    }
  }

  const n = buffers[0]?.length ?? 0;
  if (!n) throw new Error("No numeric EEG waveform samples were found.");

  let sampleRate = fallbackSampleRate;
  let startSeconds = 0;
  if (times.length > 2) {
    const span = times[times.length - 1]! - times[0]!;
    // Exports timestamped in milliseconds are common; detect and rescale.
    const scale = span > times.length * 10 ? 1000 : 1;
    const seconds = span / scale;
    if (seconds > 0) sampleRate = (times.length - 1) / seconds;
    startSeconds = times[0]! / scale;
  }
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) sampleRate = fallbackSampleRate;

  const channels = waveCols
    .map((w, c) =>
      seen[c] ? { channel: w.channel, samples: Float64Array.from(buffers[c]!) } : null,
    )
    .filter((c): c is VitalDbWaveChannel => c != null);
  if (!channels.length) throw new Error("The waveform columns were present but empty.");

  return {
    channels,
    sampleRate: Math.round(sampleRate * 100) / 100,
    startSeconds,
    durationSeconds: n / sampleRate,
  };
}

/** Average the available frontal channels into the analysis signal. */
export function combineChannels(wave: VitalDbWaveform): Float64Array {
  const [first, ...rest] = wave.channels;
  if (!first) return new Float64Array(0);
  if (!rest.length) return first.samples;
  const n = Math.min(...wave.channels.map((c) => c.samples.length));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of wave.channels) sum += c.samples[i]!;
    out[i] = sum / wave.channels.length;
  }
  return out;
}

/* --------------------------------------------------------------- pairing -- */

export interface VitalDbPairedPoint {
  atSeconds: number;
  bis: number;
  bisSef: number | null;
  bisSr: number | null;
  sqi: number | null;
  appIndex: number;
  appSef: number | null;
  appSr: number | null;
  reliable: boolean;
  /** Seconds between the monitor reading and the replayed second it matched. */
  lagSeconds: number;
  ce: Record<string, number>;
  externalRef: string;
}

export interface VitalDbPairedCase {
  caseRef: string;
  lineageKey: string;
  lineage: DataLineage;
  covariates: VitalDbCovariates;
  channels: ("AF7" | "AF8")[];
  sampleRate: number;
  durationSeconds: number;
  points: VitalDbPairedPoint[];
  rejected: { noBis: number; badRange: number; lowSqi: number; unmatched: number; noIndex: number };
}

export interface PairOptions {
  /** One retained pair per this many seconds of case time. */
  strideSeconds?: number;
  minSqi?: number;
  /** How far a monitor reading may sit from a replayed second and still pair. */
  toleranceSeconds?: number;
}

/**
 * Replay a case's waveform through the app estimator and pair each second with
 * the monitor reading recorded at the same moment.
 */
export function pairVitalDbCase(
  info: VitalDbCaseInfo,
  wave: VitalDbWaveform,
  numerics: VitalDbTrackSample[],
  options: PairOptions = {},
): VitalDbPairedCase {
  const stride = Math.max(1, options.strideSeconds ?? 10);
  const minSqi = options.minSqi ?? 50;
  const tolerance = options.toleranceSeconds ?? 2;
  const rejected = { noBis: 0, badRange: 0, lowSqi: 0, unmatched: 0, noIndex: 0 };

  const signal = combineChannels(wave);
  const channels = wave.channels.map((c) => c.channel);
  const lineage = vitalDbWaveLineage(channels, Math.round(wave.sampleRate));
  const caseRef = `vitaldb-${info.caseId}`;

  const replay = replayRawEeg({ samples: signal, sampleRate: wave.sampleRate });
  // Replay seconds are relative to the first waveform sample; monitor readings
  // are stamped from case start, so shift onto one shared clock.
  const frames = replay.frames.map((f) => ({ ...f, t: f.t + wave.startSeconds }));

  const usable = numerics
    .filter((s) => {
      if (s.bis == null) {
        rejected.noBis++;
        return false;
      }
      if (s.bis <= 0 || s.bis > 100) {
        rejected.badRange++;
        return false;
      }
      if (s.sqi != null && s.sqi < minSqi) {
        rejected.lowSqi++;
        return false;
      }
      return true;
    })
    .sort((a, b) => a.t - b.t);

  const points: VitalDbPairedPoint[] = [];
  let taken = -Infinity;
  let j = 0;
  for (const s of usable) {
    if (s.t - taken < stride) continue;
    while (j + 1 < frames.length && Math.abs(frames[j + 1]!.t - s.t) <= Math.abs(frames[j]!.t - s.t))
      j++;
    const frame = frames[j];
    if (!frame || Math.abs(frame.t - s.t) > tolerance) {
      rejected.unmatched++;
      continue;
    }
    if (frame.appIndex == null) {
      rejected.noIndex++;
      continue;
    }
    const at = Math.round(s.t * 10) / 10;
    points.push({
      atSeconds: at,
      bis: Number(s.bis!.toFixed(1)),
      bisSef: s.sef,
      bisSr: s.sr,
      sqi: s.sqi,
      appIndex: Number(frame.appIndex.toFixed(2)),
      appSef: Number(frame.sef95.toFixed(2)),
      appSr: Number(frame.suppressionRatio.toFixed(2)),
      // The monitor's own SQI decides reliability; the replay index is only as
      // trustworthy as the signal the monitor was reading at the time.
      reliable: s.sqi == null ? true : s.sqi >= minSqi,
      lagSeconds: Number((frame.t - s.t).toFixed(2)),
      ce: { ...s.ce },
      externalRef: `${VITALDB_SOURCE}:wave:${info.caseId}:${at}`,
    });
    taken = s.t;
  }

  const usedCe = new Set<string>();
  for (const p of points) for (const [d, v] of Object.entries(p.ce)) if (v > 0) usedCe.add(d);

  return {
    caseRef,
    lineageKey: lineageKey(lineage),
    lineage,
    covariates: {
      ageBand: ageBandOf(info.age),
      sex: sexOf(info.sex),
      regimen: regimenOf(info, usedCe),
      frailty: frailtyFromAsa(info.asa),
      asa: info.asa,
    },
    channels,
    sampleRate: wave.sampleRate,
    durationSeconds: Math.round(wave.durationSeconds),
    points,
    rejected,
  };
}

/**
 * Build a full-feature training corpus for a from-scratch COEBIS rebuild.
 *
 * The paired readings already in the database store only three scalars per
 * moment (app index, SEF, SR), which is enough to *recalibrate* the existing
 * index but far too little to *replace* it. This script re-replays the VitalDB
 * bedside EEG waveform and writes, for every second the monitor reported a
 * BIS, the whole spectral feature vector the window supports — band powers,
 * relative powers, ratios, spectral edges, entropies, suppression and burst
 * metrics, short-horizon trends — alongside the monitor's own BIS/SR/SEF and
 * the case covariates.
 *
 * Nothing here is written to the database: the corpus is a local artefact used
 * for model search, so no fit can be promoted off data that was never graded.
 *
 * Usage: bun scripts/build-coebis-corpus.ts [caseCount] [startIndex]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";

import { computePsd, spectralEntropies, type Psd } from "@/lib/eeg/dsp";
import { DepthIndexEstimator } from "@/lib/eeg/depth";
import { parseVitalDbClinicalCsv, ageBandOf, regimenOf, sexOf } from "@/lib/eeg/vitaldb";
import {
  assembleVitalDbNumerics,
  assembleVitalDbWaveform,
  type VitalDbTrackFile,
} from "@/lib/eeg/vitaldb-waveform";

const API = "https://api.vitaldb.net";
const CACHE = "/tmp/vdb";
const OUT = "/tmp/coebis-corpus";
const WANTED = [
  "BIS/EEG1_WAV",
  "BIS/BIS",
  "BIS/SEF",
  "BIS/SR",
  "BIS/EMG",
  "BIS/SQI",
  "Orchestra/PPF20_CE",
  "Orchestra/RFTN20_CE",
];
const REQUIRED = ["BIS/EEG1_WAV", "BIS/BIS", "BIS/SR", "BIS/SQI"];

const EPOCH_SECONDS = 4;

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

async function cached(path: string, url: string): Promise<string> {
  if (existsSync(path)) return readFileSync(path, "utf8");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const text = await res.text();
  writeFileSync(path, text);
  return text;
}

/* ---------------------------------------------------------------- */
/* Feature extraction                                                */
/* ---------------------------------------------------------------- */

function bandPower(psd: Psd, lo: number, hi: number): number {
  let sum = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= lo && f < hi) sum += psd.power[i]! * psd.binWidth;
  }
  return sum;
}

function edgeFreq(psd: Psd, fraction: number, lo = 0.5, hi = 45): number {
  let total = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= lo && f <= hi) total += psd.power[i]!;
  }
  if (total <= 0) return lo;
  let acc = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f < lo || f > hi) continue;
    acc += psd.power[i]!;
    if (acc >= total * fraction) return f;
  }
  return hi;
}

/** Frequency and prominence of the strongest peak between 7 and 17 Hz. */
function alphaPeak(psd: Psd): { freq: number; prominence: number } {
  let best = 0;
  let bestF = 0;
  let floor = 0;
  let floorN = 0;
  for (let i = 0; i < psd.freqs.length; i++) {
    const f = psd.freqs[i]!;
    if (f >= 7 && f <= 17 && psd.power[i]! > best) {
      best = psd.power[i]!;
      bestF = f;
    }
    if (f >= 2 && f <= 30) {
      floor += psd.power[i]!;
      floorN++;
    }
  }
  const mean = floorN ? floor / floorN : 0;
  return { freq: bestF, prominence: mean > 0 ? Math.log10((best + 1e-12) / (mean + 1e-12)) : 0 };
}

const L = (x: number) => Math.log10(Math.max(x, 1e-9));

export interface CorpusRow {
  caseRef: string;
  t: number;
  bis: number;
  bisSr: number | null;
  bisSef: number | null;
  sqi: number | null;
  appIndex: number | null;
  f: Record<string, number>;
  cov: { age: number | null; sexMale: number | null; propofol: number; opioid: number };
}

function windowFeatures(
  win: Float64Array,
  fs: number,
): { f: Record<string, number>; suppFraction: number } {
  const psd = computePsd(win, fs);
  const total = bandPower(psd, 0.5, 45);
  const slow = bandPower(psd, 0.5, 1);
  const delta = bandPower(psd, 1, 4);
  const theta = bandPower(psd, 4, 8);
  const alpha = bandPower(psd, 8, 13);
  const beta = bandPower(psd, 13, 30);
  const gamma = bandPower(psd, 30, 45);
  const rel = (x: number) => x / Math.max(total, 1e-12);
  const sef95 = edgeFreq(psd, 0.95);
  const ent = spectralEntropies(psd, sef95);
  const peak = alphaPeak(psd);

  // Amplitude / suppression on 0.5 s segments, BIS-style 5 µV criterion.
  const seg = Math.max(1, Math.round(0.5 * fs));
  let suppressed = 0;
  let segments = 0;
  let rms = 0;
  let ptpMax = 0;
  for (let i = 0; i + seg <= win.length; i += seg) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = i; j < i + seg; j++) {
      const v = win[j]!;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      rms += v * v;
    }
    const ptp = hi - lo;
    if (ptp > ptpMax) ptpMax = ptp;
    if (ptp < 5) suppressed++;
    segments++;
  }
  rms = Math.sqrt(rms / Math.max(win.length, 1));
  const suppFraction = segments ? suppressed / segments : 0;

  return {
    suppFraction,
    f: {
      logTotal: L(total),
      logSlow: L(slow),
      logDelta: L(delta),
      logTheta: L(theta),
      logAlpha: L(alpha),
      logBeta: L(beta),
      logGamma: L(gamma),
      relSlow: rel(slow),
      relDelta: rel(delta),
      relTheta: rel(theta),
      relAlpha: rel(alpha),
      relBeta: rel(beta),
      relGamma: rel(gamma),
      // The classic BIS-lineage ratios, kept in log space so they stay linear.
      betaRatio: L(beta / Math.max(alpha, 1e-12)),
      syncFastSlow: L((beta + gamma) / Math.max(delta + theta, 1e-12)),
      alphaDelta: L(alpha / Math.max(delta, 1e-12)),
      thetaAlpha: L(theta / Math.max(alpha, 1e-12)),
      sef50: edgeFreq(psd, 0.5),
      sef75: edgeFreq(psd, 0.75),
      sef90: edgeFreq(psd, 0.9),
      sef95,
      entShannon: ent.shannon,
      entSe95: ent.se95,
      entState: ent.state,
      entResponse: ent.response,
      peakFreq: peak.freq,
      peakProminence: peak.prominence,
      logRms: L(rms),
      logPtp: L(ptpMax),
      suppFraction,
    },
  };
}

/* ---------------------------------------------------------------- */
/* Per-case replay                                                   */
/* ---------------------------------------------------------------- */

const clinicalText = await cached("/tmp/vdb/cases.csv", `${API}/cases`);
const clinical = parseVitalDbClinicalCsv(clinicalText);
const trkText = await cached("/tmp/vdb/trks.csv", `${API}/trks`);

const tracks = new Map<string, Map<string, string>>();
for (const line of trkText.split(/\r?\n/).slice(1)) {
  const [caseId, tname, tid] = line.split(",");
  if (!caseId || !tname || !tid) continue;
  if (!WANTED.includes(tname)) continue;
  const m = tracks.get(caseId) ?? new Map<string, string>();
  m.set(tname, tid.trim());
  tracks.set(caseId, m);
}

const eligible = [...tracks.entries()]
  .filter(([, m]) => REQUIRED.every((t) => m.has(t)))
  .map(([c]) => c)
  .sort((a, b) => Number(a) - Number(b));

const count = Number(process.argv[2] ?? 5);
const start = Number(process.argv[3] ?? 0);
const caseIds = eligible.slice(start, start + count);
console.log(`${eligible.length} eligible; building ${caseIds.length} from index ${start}`);

for (const caseId of caseIds) {
  const outPath = `${OUT}/case-${caseId}.jsonl`;
  if (existsSync(outPath)) {
    console.log(`case ${caseId}: already built`);
    continue;
  }
  const info = clinical.get(caseId);
  const trk = tracks.get(caseId);
  if (!info || !trk) continue;

  const files: VitalDbTrackFile[] = [];
  try {
    for (const [name, tid] of trk) {
      files.push({
        name,
        text: await cached(`${CACHE}/${caseId}-${tid}.csv`, `${API}/${tid}`),
      });
    }
  } catch (err) {
    console.log(`case ${caseId}: download failed — ${(err as Error).message}`);
    continue;
  }

  let wave;
  try {
    wave = assembleVitalDbWaveform(files);
  } catch (err) {
    console.log(`case ${caseId}: ${(err as Error).message}`);
    continue;
  }
  const numerics = assembleVitalDbNumerics(files);
  const byT = new Map(numerics.map((n) => [Math.round(n.t), n]));

  const fs = wave.sampleRate;
  const chan = wave.channels[0]!;
  const samples = chan.samples;
  const win = Math.round(EPOCH_SECONDS * fs);
  const hop = Math.round(fs);
  if (samples.length < win) {
    console.log(`case ${caseId}: waveform shorter than one window`);
    continue;
  }

  const est = new DepthIndexEstimator();
  const history: { t: number; fraction: number }[] = [];
  const trend: { t: number; f: Record<string, number> }[] = [];
  const rows: CorpusRow[] = [];

  const cov = {
    age: info.age,
    sexMale: info.sex == null ? null : /m/i.test(info.sex) ? 1 : 0,
    propofol: info.propofol ? 1 : 0,
    opioid: info.opioid ? 1 : 0,
  };

  for (let end = win; end <= samples.length; end += hop) {
    const slice = Float64Array.from(samples.subarray(end - win, end));
    const tSec = Math.round(wave.startSeconds + end / fs);
    const reading = est.update(slice, fs, { usable: true }, 1);

    const { f, suppFraction } = windowFeatures(slice, fs);

    // Trailing 60 s suppression ratio, and 30 s trends on the descriptors that
    // move with depth — a single 4 s window cannot see a burst pattern.
    history.push({ t: tSec, fraction: suppFraction });
    while (history.length && tSec - history[0]!.t > 60) history.shift();
    f["sr60"] =
      (history.reduce((a, h) => a + h.fraction, 0) / Math.max(history.length, 1)) * 100;

    trend.push({ t: tSec, f });
    while (trend.length && tSec - trend[0]!.t > 30) trend.shift();
    const mean = (k: string) =>
      trend.reduce((a, r) => a + (r.f[k] ?? 0), 0) / Math.max(trend.length, 1);
    f["sef95Mean30"] = mean("sef95");
    f["relBetaMean30"] = mean("relBeta");
    f["relDeltaMean30"] = mean("relDelta");
    f["entStateMean30"] = mean("entState");
    f["sef95Delta30"] = f["sef95"]! - f["sef95Mean30"]!;

    const monitor = byT.get(tSec);
    if (!monitor || monitor.bis == null) continue;
    if (monitor.sqi != null && monitor.sqi < 50) continue;

    rows.push({
      caseRef: `vitaldb-${caseId}`,
      t: tSec,
      bis: monitor.bis,
      bisSr: monitor.sr,
      bisSef: monitor.sef,
      sqi: monitor.sqi,
      appIndex: reading.index,
      f: { ...f },
      cov,
    });
  }

  if (!rows.length) {
    console.log(`case ${caseId}: no paired seconds`);
    continue;
  }
  writeFileSync(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  appendFileSync(
    `${OUT}/manifest.jsonl`,
    JSON.stringify({
      caseRef: `vitaldb-${caseId}`,
      rows: rows.length,
      ageBand: ageBandOf(info.age),
      sex: sexOf(info.sex),
      regimen: regimenOf(info, new Set<string>()),
      bisMin: Math.min(...rows.map((r) => r.bis)),
      bisMax: Math.max(...rows.map((r) => r.bis)),
    }) + "\n",
  );
  console.log(`case ${caseId}: ${rows.length} paired seconds → ${outPath}`);
}

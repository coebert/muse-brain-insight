// Distribution of artefact metrics over contaminated vs clean sessions.
import { readFileSync } from "fs";
import { computePsd, makeEegFilter, signalQuality } from "../../src/lib/eeg/dsp";
import { preprocessForDepth } from "../../src/lib/eeg/artifact";

const FS = 256,
  WIN = 4 * FS;
const name = process.argv[2] ?? "steady_ga";
for (const prefix of ["sess", "art"]) {
  const raw = readFileSync(`/tmp/valid/${prefix}_${name}.csv`, "utf8").trim().split("\n").map(Number);
  const f = makeEegFilter(FS);
  const sig = Float64Array.from(raw, (v) => f.process(v));
  const cols: Record<string, number[]> = { emg: [], repaired: [], ecg: [], q: [], sigma: [] };
  for (let end = WIN; end <= sig.length; end += FS) {
    const w = sig.subarray(end - WIN, end);
    const psd = computePsd(w, FS);
    const q = signalQuality(w, psd, FS);
    const p = preprocessForDepth(w, psd, FS, q.score);
    cols['emg']!.push(p.report.emgIndex);
    cols['repaired']!.push(p.report.repairedFraction);
    cols['ecg']!.push(p.report.ecgLikeness);
    cols['q']!.push(q.score);
    cols['sigma']!.push(p.report.robustSigmaUv);
  }
  const pct = (a: number[], p: number) => {
    const s = [...a].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
  };
  console.log(
    prefix,
    Object.entries(cols)
      .map(([k, v]) => `${k} p50=${pct(v, 50).toFixed(3)} p90=${pct(v, 90).toFixed(3)} max=${Math.max(...v).toFixed(3)}`)
      .join(" | "),
  );
}
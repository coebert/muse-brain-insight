// Runs the depth index over artefact-contaminated sessions, with the new
// preprocessing gate enabled ("gated") or bypassed ("raw").
import { readFileSync, writeFileSync } from "fs";
import { computePsd, makeEegFilter, signalQuality } from "../../src/lib/eeg/dsp";
import { DepthArtifactGate } from "../../src/lib/eeg/artifact";
import { DepthIndexEstimator } from "../../src/lib/eeg/depth";

const FS = 256,
  WIN = 4 * FS,
  HOP = FS;
const mode = process.argv[3] ?? "gated";
const ref = JSON.parse(readFileSync("/tmp/valid/reference.json", "utf8"));
const out: Record<string, { t: number[]; idx: (number | null)[] }> = {};
let gated = 0;
let total = 0;
for (const name of Object.keys(ref)) {
  const raw = readFileSync(`/tmp/valid/${process.argv[4] ?? "art"}_${name}.csv`, "utf8").trim().split("\n").map(Number);
  const f = makeEegFilter(FS);
  const sig = Float64Array.from(raw, (v) => f.process(v));
  const est = new DepthIndexEstimator();
  const gate = new DepthArtifactGate();
  const t: number[] = [];
  const idx: (number | null)[] = [];
  for (let end = WIN; end <= sig.length; end += HOP) {
    const w = sig.subarray(end - WIN, end);
    let r;
    if (mode === "raw") {
      r = est.update(w, FS, { usable: true }, 1);
    } else {
      const psd = computePsd(w, FS);
      const q = signalQuality(w, psd, FS);
      const p = gate.evaluate(w, psd, FS, q.score);
      if (!p.report.usable) gated++;
      total++;
      r = est.update(p.signal, FS, { usable: p.report.usable, reasons: p.report.reasons }, 1);
    }
    t.push(end / FS);
    idx.push(r.index);
  }
  out[name] = { t, idx };
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log(mode, total ? `gated ${((100 * gated) / total).toFixed(1)}% of epochs` : "");
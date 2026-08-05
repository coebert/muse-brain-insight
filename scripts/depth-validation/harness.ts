import { readFileSync, writeFileSync } from "fs";
import { makeEegFilter } from "../../src/lib/eeg/dsp";
import { DepthIndexEstimator } from "../../src/lib/eeg/depth";

const FS = 256,
  WIN = 4 * FS,
  HOP = FS;
const filtered = process.argv[3] === "filtered";
const ref = JSON.parse(readFileSync("/tmp/valid/reference.json", "utf8"));
const out: Record<string, { t: number[]; idx: (number | null)[] }> = {};
for (const name of Object.keys(ref)) {
  let sig = Float64Array.from(
    readFileSync(`/tmp/valid/sess_${name}.csv`, "utf8").trim().split("\n").map(Number),
  );
  if (filtered) {
    const f = makeEegFilter(FS);
    sig = Float64Array.from(sig, (v) => f.process(v));
  }
  const est = new DepthIndexEstimator();
  const t: number[] = [],
    idx: (number | null)[] = [];
  for (let end = WIN; end <= sig.length; end += HOP) {
    const r = est.update(sig.subarray(end - WIN, end), FS, { usable: true }, 1);
    t.push(end / FS);
    idx.push(r.index);
  }
  out[name] = { t, idx };
}
writeFileSync(process.argv[2], JSON.stringify(out));
console.log("ok");

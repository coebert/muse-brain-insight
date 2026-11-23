export const seizureChannels = ["FP1-F7", "FP2-F8"] as const;
const bands = [[0.5, 4], [4, 8], [8, 13], [13, 30], [30, 45]] as const;

export interface ResearchWeights {
  mean: number[];
  scale: number[];
  coef: number[];
  intercept: number;
}

export interface ResearchWaveform {
  hz: number;
  channels: string[];
  samples: number[][];
  units: "uV" | "source-amplitude";
  timedAndGapFree: true;
}

export function researchWindowFeatures(samples: number[], hz: number): number[] | null {
  if (!Number.isInteger(hz) || hz < 100 || hz > 512 || samples.length < 4 * hz ||
      samples.length > 8 * hz || samples.some((x) => !Number.isFinite(x))) return null;
  const n = samples.length;
  const mean = samples.reduce((sum, x) => sum + x, 0) / n;
  let square = 0;
  let line = 0;
  const tapered = samples.map((sample, i) => {
    const x = sample - mean;
    square += x * x;
    if (i > 0) line += Math.abs(sample - samples[i - 1]!);
    return x * (1 - Math.cos(2 * Math.PI * i / (n - 1))) / 2;
  });
  const rms = Math.sqrt(square / n);
  if (rms <= 1e-8) return null;

  const spectrum = [];
  const step = hz / n;
  let total = 0;
  for (let bin = 1; bin <= Math.floor(n / 2); bin++) {
    const hzAtBin = bin * step;
    if (hzAtBin < 0.5) continue;
    if (hzAtBin >= 45) break;
    const coefficient = 2 * Math.cos(2 * Math.PI * bin / n);
    let prev = 0;
    let beforePrev = 0;
    for (const sample of tapered) {
      const next = sample + coefficient * prev - beforePrev;
      beforePrev = prev;
      prev = next;
    }
    const power = Math.max(0, prev * prev + beforePrev * beforePrev - coefficient * prev * beforePrev);
    spectrum.push({ hz: hzAtBin, power });
    total += power;
  }
  if (!(total > 0) || !Number.isFinite(total)) return null;
  const values: number[] = [Math.log1p(rms), Math.log1p(line * hz / (n - 1))];
  for (const [lo, hi] of bands) {
    values.push(spectrum.reduce((sum, row) => row.hz >= lo && row.hz < hi ? sum + row.power : sum, 0) / total);
  }
  let mass = 0;
  let entropy = 0;
  let sef95 = spectrum.at(-1)!.hz;
  for (const { hz: hzAtBin, power } of spectrum) {
    const fraction = power / total;
    if (mass < 0.95 && mass + fraction >= 0.95) sef95 = hzAtBin;
    mass += fraction;
    if (fraction > 0) entropy -= fraction * Math.log(fraction);
  }
  return [...values, sef95, entropy / Math.log(spectrum.length)];
}

export function scoreResearchWindow(
  task: "seizure_window" | "bis_agreement_only",
  weights: ResearchWeights,
  input: ResearchWaveform,
): number | null {
  if (input.timedAndGapFree !== true) return null;
  const expectedChannels = task === "seizure_window" ? seizureChannels : ["Figshare BIS frontal"];
  const expectedUnits = task === "seizure_window" ? "uV" : "source-amplitude";
  const expectedSeconds = task === "seizure_window" ? 4 : 5;
  const rates = task === "seizure_window" ? [256, 512] : [125];
  if (input.units !== expectedUnits || !rates.includes(input.hz) ||
      input.channels.length !== expectedChannels.length ||
      input.samples.length !== expectedChannels.length ||
      expectedChannels.some((name, i) => input.channels[i] !== name) ||
      input.samples.some((signal) => signal.length !== input.hz * expectedSeconds)) return null;
  const values = input.samples.map((signal) => researchWindowFeatures(signal, input.hz));
  if (values.some((features) => features === null)) return null;
  const flat = values.flat() as number[];
  if (!Number.isFinite(weights.intercept) ||
      [weights.mean, weights.scale, weights.coef].some((array) =>
        array.length !== flat.length || array.some((item) => !Number.isFinite(item)),
      ) || weights.scale.some((value) => value <= 0)) return null;
  const score = flat.reduce(
    (sum, value, i) => sum + ((value - weights.mean[i]!) / weights.scale[i]!) * weights.coef[i]!,
    weights.intercept,
  );
  if (!Number.isFinite(score)) return null;
  return task === "seizure_window" ? 1 / (1 + Math.exp(-score)) : Math.max(0, Math.min(100, score));
}

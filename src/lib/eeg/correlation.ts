/** Correlation helpers for comparing depth index against other EEG metrics. */

export interface CorrelationResult {
  /** Pearson r, null when there is not enough variance/samples. */
  r: number | null;
  /** Number of paired samples used. */
  n: number;
  /** Two-sided p-value approximation for r (null when r is null). */
  p: number | null;
  /** Lag in samples where |r| peaks, searched over +/- maxLag. */
  bestLag: number;
  /** r at bestLag. */
  bestLagR: number | null;
}

function meanOf(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = meanOf(xs.slice(0, n));
  const my = meanOf(ys.slice(0, n));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-9 || syy < 1e-9) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

function lgamma(z: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  const zz = z - 1;
  let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i]! / (zz + i + 1);
  const t = zz + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (zz + 0.5) * Math.log(t) - t + Math.log(x);
}

/** Student-t two-sided tail via the regularised incomplete beta function. */
function tToP(t: number, df: number): number {
  if (!Number.isFinite(t) || df <= 0) return 1;
  const x = df / (df + t * t);
  const a = df / 2;
  const b = 0.5;
  const lbeta = lgamma(a) + lgamma(b) - lgamma(a + b);
  const front = Math.exp(a * Math.log(x) + b * Math.log(1 - x) - lbeta) / a;
  let f = 1;
  let c = 1;
  let d = 0;
  for (let i = 0; i <= 200; i++) {
    const m = Math.floor(i / 2);
    let numerator: number;
    if (i === 0) numerator = 1;
    else if (i % 2 === 0) numerator = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    else numerator = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + numerator * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    d = 1 / d;
    c = 1 + numerator / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    const cd = c * d;
    f *= cd;
    if (Math.abs(1 - cd) < 1e-10) break;
  }
  return Math.min(1, Math.max(0, front * (f - 1)));
}

export function correlate(xs: number[], ys: number[], maxLag = 10): CorrelationResult {
  const n = Math.min(xs.length, ys.length);
  const r = pearson(xs, ys);
  let bestLag = 0;
  let bestLagR = r;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    if (lag === 0) continue;
    const a = lag > 0 ? xs.slice(lag) : xs.slice(0, n + lag);
    const b = lag > 0 ? ys.slice(0, n - lag) : ys.slice(-lag);
    const lr = pearson(a, b);
    if (lr !== null && (bestLagR === null || Math.abs(lr) > Math.abs(bestLagR))) {
      bestLagR = lr;
      bestLag = lag;
    }
  }
  let p: number | null = null;
  if (r !== null && n > 2) {
    const denom = Math.max(1e-9, 1 - r * r);
    const t = Math.abs(r) * Math.sqrt((n - 2) / denom);
    p = tToP(t, n - 2);
  }
  return { r, n, p, bestLag, bestLagR };
}

/** Sliding-window Pearson r, returned aligned to the window centre index. */
export function rollingCorrelation(xs: number[], ys: number[], window: number): (number | null)[] {
  const n = Math.min(xs.length, ys.length);
  const out: (number | null)[] = new Array(n).fill(null);
  if (n < window || window < 3) return out;
  for (let end = window; end <= n; end++) {
    const start = end - window;
    out[start + Math.floor(window / 2)] = pearson(xs.slice(start, end), ys.slice(start, end));
  }
  return out;
}

export function correlationStrength(r: number | null): string {
  if (r === null) return "insufficient data";
  const a = Math.abs(r);
  const dir = r < 0 ? "inverse" : "direct";
  if (a >= 0.8) return `very strong ${dir}`;
  if (a >= 0.6) return `strong ${dir}`;
  if (a >= 0.4) return `moderate ${dir}`;
  if (a >= 0.2) return `weak ${dir}`;
  return "negligible";
}

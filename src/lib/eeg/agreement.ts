/**
 * Agreement analysis between a reference depth-of-anaesthesia trace
 * (e.g. output of the published openibis.m, or a recorded BIS trend) and the
 * depth index this app computes.
 *
 * Two upload shapes are supported:
 *  - a reference index file: time + index columns, compared directly;
 *  - a raw EEG file: time + microvolt samples, replayed through the app's
 *    own estimator so the comparison can be run without a live session.
 */

import { pearson } from "./correlation";
import { DepthIndexEstimator } from "./depth";

export interface Point {
  /** Seconds from the start of the record. */
  t: number;
  v: number;
}

export interface ParsedTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

const DELIMITERS = [",", "\t", ";", "|"];

function splitLine(line: string, d: string): string[] {
  if (d !== ",") return line.split(d).map((c) => c.trim());
  // Minimal RFC4180 handling for quoted commas.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

export function parseDelimited(text: string): ParsedTable {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("%"));
  if (!lines.length) return { headers: [], rows: [], delimiter: "," };

  const first = lines[0]!;
  let delimiter = ",";
  let best = 0;
  for (const d of DELIMITERS) {
    const count = splitLine(first, d).length;
    if (count > best) {
      best = count;
      delimiter = d;
    }
  }

  const cells = lines.map((l) => splitLine(l, delimiter));
  const head = cells[0]!;
  const headerLooksNumeric = head.every((c) => c !== "" && Number.isFinite(Number(c)));
  if (headerLooksNumeric) {
    const headers = head.map((_, i) => `column ${i + 1}`);
    return { headers, rows: cells, delimiter };
  }
  return { headers: head.map((h) => h.replace(/^"|"$/g, "")), rows: cells.slice(1), delimiter };
}

/** Parse seconds, mm:ss, hh:mm:ss or an ISO timestamp into seconds. */
export function parseTime(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return Number(s);
  if (/^\d{1,3}:\d{2}(:\d{2})?(\.\d+)?$/.test(s)) {
    const parts = s.split(":").map(Number);
    return parts.length === 3
      ? parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
      : parts[0]! * 60 + parts[1]!;
  }
  const d = Date.parse(s);
  return Number.isFinite(d) ? d / 1000 : null;
}

const TIME_HINTS = ["time", "t_", "timestamp", "seconds", "sec", "elapsed", "clock", "offset"];
const INDEX_HINTS = ["bis", "openibis", "depth", "index", "doa", "reference", "ref"];
const EEG_HINTS = ["eeg", "raw", "uv", "µv", "microvolt", "signal", "amplitude", "ch", "af7", "af8", "tp9", "tp10"];

function score(header: string, hints: string[]): number {
  const h = header.toLowerCase();
  let best = 0;
  hints.forEach((hint, i) => {
    if (h === hint) best = Math.max(best, 100 - i);
    else if (h.includes(hint)) best = Math.max(best, 50 - i);
  });
  return best;
}

export interface ColumnGuess {
  timeColumn: number | null;
  indexColumn: number | null;
  eegColumn: number | null;
}

export function guessColumns(table: ParsedTable): ColumnGuess {
  const { headers, rows } = table;
  const numeric = headers.map((_, c) =>
    rows.slice(0, 50).every((r) => {
      const cell = r[c] ?? "";
      return cell === "" || parseTime(cell) !== null;
    }),
  );

  const pick = (hints: string[], exclude: (number | null)[]) => {
    let bestCol: number | null = null;
    let bestScore = 0;
    headers.forEach((h, c) => {
      if (exclude.includes(c) || !numeric[c]) return;
      const s = score(h, hints);
      if (s > bestScore) {
        bestScore = s;
        bestCol = c;
      }
    });
    return bestCol;
  };

  let timeColumn = pick(TIME_HINTS, []);
  const indexColumn = pick(INDEX_HINTS, [timeColumn]);
  const eegColumn = pick(EEG_HINTS, [timeColumn, indexColumn]);

  // Fall back to positional defaults when the headers are unlabelled.
  if (timeColumn === null && numeric[0]) timeColumn = 0;
  const firstFreeNumeric = headers.findIndex(
    (_, c) => numeric[c] && c !== timeColumn && c !== indexColumn && c !== eegColumn,
  );
  return {
    timeColumn,
    indexColumn:
      indexColumn ?? (eegColumn === null && firstFreeNumeric >= 0 ? firstFreeNumeric : null),
    eegColumn,
  };
}

/** Read a numeric series out of a parsed table. */
export function readSeries(
  table: ParsedTable,
  timeColumn: number | null,
  valueColumn: number,
  fallbackHz = 1,
): Point[] {
  const out: Point[] = [];
  let t0: number | null = null;
  table.rows.forEach((r, i) => {
    const vRaw = r[valueColumn];
    if (vRaw === undefined || vRaw === "") return;
    const v = Number(vRaw);
    if (!Number.isFinite(v)) return;
    let t: number;
    if (timeColumn === null) t = i / fallbackHz;
    else {
      const parsed = parseTime(r[timeColumn] ?? "");
      if (parsed === null) return;
      if (t0 === null) t0 = parsed;
      t = parsed - t0;
    }
    out.push({ t, v });
  });
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Median sample interval of a series, seconds. */
export function medianInterval(points: Point[]): number {
  const diffs = points
    .slice(1)
    .map((p, i) => p.t - points[i]!.t)
    .filter((d) => d > 0)
    .sort((a, b) => a - b);
  return diffs.length ? diffs[Math.floor(diffs.length / 2)]! : 1;
}

/**
 * Replay raw EEG samples through the app's estimator, producing a depth trend
 * at 1 s cadence — the same code path the live monitor uses.
 */
export function depthFromSamples(samples: number[], fs: number): Point[] {
  const est = new DepthIndexEstimator();
  const windowLen = Math.max(Math.round(4 * fs), 8);
  const hop = Math.max(1, Math.round(fs));
  const out: Point[] = [];
  for (let end = windowLen; end <= samples.length; end += hop) {
    const win = Float64Array.from(samples.slice(end - windowLen, end));
    const reading = est.update(win, fs, { usable: true }, 1);
    if (reading.index !== null) out.push({ t: end / fs, v: reading.index });
  }
  return out;
}

export interface AlignedPair {
  t: number;
  reference: number;
  test: number;
}

/**
 * Nearest-neighbour alignment of two irregular series, with an optional lag
 * (seconds) applied to the test series before matching.
 */
export function alignSeries(
  reference: Point[],
  test: Point[],
  tolerance: number,
  lagSeconds = 0,
): AlignedPair[] {
  if (!reference.length || !test.length) return [];
  const shifted = test.map((p) => ({ t: p.t + lagSeconds, v: p.v }));
  const out: AlignedPair[] = [];
  let j = 0;
  for (const ref of reference) {
    while (j + 1 < shifted.length && Math.abs(shifted[j + 1]!.t - ref.t) <= Math.abs(shifted[j]!.t - ref.t)) {
      j++;
    }
    const cand = shifted[j]!;
    if (Math.abs(cand.t - ref.t) <= tolerance) {
      out.push({ t: ref.t, reference: ref.v, test: cand.v });
    }
  }
  return out;
}

export interface AgreementMetrics {
  n: number;
  r: number | null;
  /** Lin's concordance correlation coefficient. */
  ccc: number | null;
  /** Mean of (test - reference). */
  bias: number;
  sd: number;
  loaLower: number;
  loaUpper: number;
  rmse: number;
  mae: number;
  within5: number;
  within10: number;
  /** Ordinary least-squares fit of test on reference. */
  slope: number | null;
  intercept: number | null;
}

export function agreementMetrics(pairs: AlignedPair[]): AgreementMetrics {
  const n = pairs.length;
  const empty: AgreementMetrics = {
    n,
    r: null,
    ccc: null,
    bias: 0,
    sd: 0,
    loaLower: 0,
    loaUpper: 0,
    rmse: 0,
    mae: 0,
    within5: 0,
    within10: 0,
    slope: null,
    intercept: null,
  };
  if (n < 3) return empty;

  const refs = pairs.map((p) => p.reference);
  const tests = pairs.map((p) => p.test);
  const diffs = pairs.map((p) => p.test - p.reference);
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const mr = mean(refs);
  const mt = mean(tests);
  const bias = mean(diffs);
  const variance = (v: number[], m: number) =>
    v.reduce((a, b) => a + (b - m) * (b - m), 0) / Math.max(1, v.length - 1);
  const sd = Math.sqrt(variance(diffs, bias));
  const vr = variance(refs, mr);
  const vt = variance(tests, mt);
  const cov = pairs.reduce((a, p) => a + (p.reference - mr) * (p.test - mt), 0) / Math.max(1, n - 1);
  const r = pearson(refs, tests);
  const cccDenom = vr + vt + (mr - mt) * (mr - mt);
  const ccc = cccDenom > 1e-9 ? (2 * cov) / cccDenom : null;
  const rmse = Math.sqrt(mean(diffs.map((d) => d * d)));
  const mae = mean(diffs.map((d) => Math.abs(d)));
  const slope = vr > 1e-9 ? cov / vr : null;
  const intercept = slope === null ? null : mt - slope * mr;

  return {
    n,
    r,
    ccc,
    bias,
    sd,
    loaLower: bias - 1.96 * sd,
    loaUpper: bias + 1.96 * sd,
    rmse,
    mae,
    within5: (100 * diffs.filter((d) => Math.abs(d) <= 5).length) / n,
    within10: (100 * diffs.filter((d) => Math.abs(d) <= 10).length) / n,
    slope,
    intercept,
  };
}

/** Search a lag range (seconds) for the alignment that maximises Pearson r. */
export function bestLagSeconds(
  reference: Point[],
  test: Point[],
  tolerance: number,
  maxLag = 30,
  step = 1,
): { lag: number; r: number | null } {
  let best = { lag: 0, r: null as number | null };
  for (let lag = -maxLag; lag <= maxLag; lag += step) {
    const pairs = alignSeries(reference, test, tolerance, lag);
    if (pairs.length < 5) continue;
    const r = pearson(pairs.map((p) => p.reference), pairs.map((p) => p.test));
    if (r !== null && (best.r === null || r > best.r)) best = { lag, r };
  }
  return best;
}

export function agreementVerdict(m: AgreementMetrics): string {
  if (m.n < 5) return "Not enough overlapping samples to judge agreement.";
  const r = m.r ?? 0;
  const spread = Math.max(Math.abs(m.loaLower), Math.abs(m.loaUpper));
  if (r >= 0.9 && spread <= 10) return "Excellent agreement — tracks the reference closely.";
  if (r >= 0.8 && spread <= 15) return "Good agreement — trends match with a modest offset.";
  if (r >= 0.6) return "Moderate agreement — usable as a trend, absolute values differ.";
  return "Poor agreement — check montage, sample rate and time alignment before relying on it.";
}

export interface ReportContext {
  fileName: string;
  sourceLabel: string;
  comparisonLabel: string;
  lagSeconds: number;
  toleranceSeconds: number;
  generatedAt: Date;
}

export function buildReportMarkdown(
  m: AgreementMetrics,
  ctx: ReportContext,
  pairs: AlignedPair[],
): string {
  const f = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? "—" : v.toFixed(d));
  const duration = pairs.length ? pairs[pairs.length - 1]!.t - pairs[0]!.t : 0;
  return [
    "# Depth index agreement report",
    "",
    `Generated: ${ctx.generatedAt.toISOString()}`,
    `Reference file: ${ctx.fileName}`,
    `Reference series: ${ctx.sourceLabel}`,
    `Compared against: ${ctx.comparisonLabel}`,
    `Alignment: lag ${f(ctx.lagSeconds, 1)} s, match tolerance ±${f(ctx.toleranceSeconds, 1)} s`,
    "",
    "## Agreement",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    `| Paired samples | ${m.n} |`,
    `| Overlap duration | ${f(duration / 60, 1)} min |`,
    `| Pearson r | ${f(m.r, 3)} |`,
    `| Lin's CCC | ${f(m.ccc, 3)} |`,
    `| Bias (test − reference) | ${f(m.bias)} |`,
    `| 95 % limits of agreement | ${f(m.loaLower)} to ${f(m.loaUpper)} |`,
    `| RMSE | ${f(m.rmse)} |`,
    `| MAE | ${f(m.mae)} |`,
    `| Within ±5 index points | ${f(m.within5, 1)} % |`,
    `| Within ±10 index points | ${f(m.within10, 1)} % |`,
    `| Regression (test on reference) | y = ${f(m.slope, 3)}·x + ${f(m.intercept)} |`,
    "",
    "## Interpretation",
    "",
    agreementVerdict(m),
    "",
    "Depth indices here are research trends on a Muse frontal montage and are not",
    "calibrated against clinical endpoints. Do not titrate anaesthesia on this output.",
    "",
  ].join("\n");
}

export function buildPairedCsv(pairs: AlignedPair[]): string {
  const head = "t_seconds,reference,test,difference";
  const body = pairs.map(
    (p) => `${p.t.toFixed(2)},${p.reference.toFixed(3)},${p.test.toFixed(3)},${(p.test - p.reference).toFixed(3)}`,
  );
  return [head, ...body].join("\n");
}

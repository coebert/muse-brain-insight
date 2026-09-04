/**
 * BIS benchmark (pure core).
 *
 * The suppression dashboard grades COEBIS against a recorded bedside BIS on
 * the benchmark's own spectral epochs, and only two recordings carry both a
 * full spectrum and a monitor number — far too thin to conclude anything.
 * This module grades the same comparison on every paired bedside reading the
 * project holds, per acquisition lineage and per case: what the app publishes
 * today against the number the monitor actually displayed, plus the promoted
 * BIS model's estimate wherever one is in force on that lineage.
 *
 * Nothing is imputed. A reading only counts when it carries both a recorded
 * BIS and an app value at the same moment, and the model column is read on
 * exactly the same readings as the published column so it can never win on an
 * easier slice.
 */

/** One paired reading: what the monitor said, and what the app said. */
export interface BenchmarkPair {
  caseRef: string;
  lineage: string;
  /** Recorded commercial BIS, 0–100. */
  bis: number;
  /** What the app publishes today: COEBIS, or the raw index with no model. */
  published: number;
  /** The promoted BIS model's estimate, where a version is in force. */
  model: number | null;
}

export interface Agreement {
  n: number;
  cases: number;
  meanBis: number | null;
  meanEstimate: number | null;
  /** Mean absolute estimate − BIS, in index points. */
  mae: number | null;
  /** Mean signed estimate − BIS: negative means the app reads deeper. */
  bias: number | null;
  correlation: number | null;
  /** Share of readings within 5 and 10 BIS points. */
  within5: number | null;
  within10: number | null;
}

export interface CaseAgreement {
  caseRef: string;
  published: Agreement;
  model: Agreement | null;
}

export type Sufficiency = "sufficient" | "provisional" | "insufficient";

export interface LineageAgreement {
  lineage: string;
  published: Agreement;
  /** Same readings, graded through the promoted BIS model, when in force. */
  model: Agreement | null;
  modelInForce: boolean;
  sufficiency: Sufficiency;
  /** Every case in this lineage, worst agreement first. */
  cases: CaseAgreement[];
}

export interface BisBenchmark {
  /** Every lineage, biggest sample first. */
  lineages: LineageAgreement[];
  /** All lineages pooled. */
  overall: Agreement;
  /** Pooled model column, on the readings a model covers. */
  overallModel: Agreement | null;
  totalReadings: number;
  totalCases: number;
  /** Readings dropped for want of a recorded BIS or an app value. */
  unusable: number;
  verdict: string;
}

/** Fewest readings and cases before the numbers are more than orientation. */
export const MIN_BENCHMARK_READINGS = 200;
export const MIN_BENCHMARK_CASES = 5;

const mean = (v: number[]): number | null =>
  v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;

const round = (v: number | null, dp = 2): number | null =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** dp) / 10 ** dp;

function correlation(xs: number[], ys: number[]): number | null {
  if (xs.length < 3) return null;
  const mx = mean(xs)!;
  const my = mean(ys)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx <= 0 || syy <= 0 ? null : round(sxy / Math.sqrt(sxx * syy), 3);
}

const EMPTY: Agreement = {
  n: 0,
  cases: 0,
  meanBis: null,
  meanEstimate: null,
  mae: null,
  bias: null,
  correlation: null,
  within5: null,
  within10: null,
};

/** Agreement of one estimate column against the recorded BIS. */
export function agreementOf(
  pairs: BenchmarkPair[],
  pick: (p: BenchmarkPair) => number | null,
): Agreement {
  const rows = pairs
    .map((p) => ({ caseRef: p.caseRef, bis: p.bis, est: pick(p) }))
    .filter(
      (r): r is { caseRef: string; bis: number; est: number } =>
        typeof r.est === "number" && Number.isFinite(r.est) && Number.isFinite(r.bis),
    );
  if (!rows.length) return EMPTY;
  const diffs = rows.map((r) => r.est - r.bis);
  return {
    n: rows.length,
    cases: new Set(rows.map((r) => r.caseRef)).size,
    meanBis: round(mean(rows.map((r) => r.bis)), 1),
    meanEstimate: round(mean(rows.map((r) => r.est)), 1),
    mae: round(mean(diffs.map(Math.abs))),
    bias: round(mean(diffs)),
    correlation: correlation(
      rows.map((r) => r.est),
      rows.map((r) => r.bis),
    ),
    within5: round((diffs.filter((d) => Math.abs(d) <= 5).length / rows.length) * 100, 1),
    within10: round((diffs.filter((d) => Math.abs(d) <= 10).length / rows.length) * 100, 1),
  };
}

function sufficiencyOf(a: Agreement): Sufficiency {
  if (a.n >= MIN_BENCHMARK_READINGS && a.cases >= MIN_BENCHMARK_CASES) return "sufficient";
  if (a.n >= Math.ceil(MIN_BENCHMARK_READINGS / 4) && a.cases >= 1) return "provisional";
  return "insufficient";
}

function casesOf(pairs: BenchmarkPair[]): CaseAgreement[] {
  const byCase = new Map<string, BenchmarkPair[]>();
  for (const p of pairs) {
    const list = byCase.get(p.caseRef);
    if (list) list.push(p);
    else byCase.set(p.caseRef, [p]);
  }
  return [...byCase.entries()]
    .map(([caseRef, rows]) => {
      const model = agreementOf(rows, (r) => r.model);
      return {
        caseRef,
        published: agreementOf(rows, (r) => r.published),
        model: model.n ? model : null,
      };
    })
    .sort((a, b) => (b.published.mae ?? 0) - (a.published.mae ?? 0));
}

/** Grade every paired reading, grouped by acquisition lineage and case. */
export function buildBisBenchmark(pairs: BenchmarkPair[], unusable = 0): BisBenchmark {
  const usable = pairs.filter(
    (p) => Number.isFinite(p.bis) && Number.isFinite(p.published),
  );
  const byLineage = new Map<string, BenchmarkPair[]>();
  for (const p of usable) {
    const list = byLineage.get(p.lineage);
    if (list) list.push(p);
    else byLineage.set(p.lineage, [p]);
  }

  const lineages: LineageAgreement[] = [...byLineage.entries()]
    .map(([lineage, rows]) => {
      const published = agreementOf(rows, (r) => r.published);
      const model = agreementOf(rows, (r) => r.model);
      return {
        lineage,
        published,
        model: model.n ? model : null,
        modelInForce: model.n > 0,
        sufficiency: sufficiencyOf(published),
        cases: casesOf(rows),
      };
    })
    .sort((a, b) => b.published.n - a.published.n);

  const overall = agreementOf(usable, (r) => r.published);
  const overallModel = agreementOf(usable, (r) => r.model);

  const verdict = (() => {
    if (!overall.n) return "No paired bedside reading carries both a recorded BIS and an app value.";
    const dir =
      overall.bias == null || Math.abs(overall.bias) < 0.5
        ? "with no systematic offset"
        : overall.bias < 0
          ? `reading ${Math.abs(overall.bias).toFixed(1)} points deeper than the monitor`
          : `reading ${overall.bias.toFixed(1)} points lighter than the monitor`;
    const head = `Across ${overall.n.toLocaleString()} paired readings in ${overall.cases} cases and ${lineages.length} acquisition setups, the app sits ${overall.mae?.toFixed(1) ?? "—"} points from the recorded BIS on average, ${dir}, tracking it at r ${overall.correlation?.toFixed(2) ?? "—"} with ${overall.within5?.toFixed(0) ?? "—"}% of readings inside 5 points.`;
    const model =
      overallModel.n > 0
        ? ` On the ${overallModel.n.toLocaleString()} readings a promoted BIS model covers, that model sits ${overallModel.mae?.toFixed(1) ?? "—"} points away against ${agreementOf(usable.filter((p) => p.model != null), (r) => r.published).mae?.toFixed(1) ?? "—"} for what the app publishes today.`
        : " No promoted BIS model covers any of these readings.";
    return head + model;
  })();

  return {
    lineages,
    overall,
    overallModel: overallModel.n ? overallModel : null,
    totalReadings: overall.n,
    totalCases: new Set(usable.map((p) => p.caseRef)).size,
    unusable,
    verdict,
  };
}

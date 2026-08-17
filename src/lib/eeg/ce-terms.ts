/**
 * Effect-site concentration as a COEBIS predictor.
 *
 * The app already records modelled effect-site concentrations from the TCI
 * pumps at the moment each paired reading is taken, but the fit ignored them
 * and leaned on the coarse "regimen" label instead. Ce is the richest
 * available description of the drug state: it separates a patient on 2.0
 * µg/ml of propofol from one on 5.0 µg/ml, where the regimen label calls both
 * "propofol TIVA". Opioids and ketamine matter too — both shift the EEG
 * without shifting depth in the way the monitor assumes.
 *
 * Each drug contributes a smooth two-term (linear + curvature) basis in
 * normalised concentration, fitted jointly with the covariate levels and
 * shrunk the same way. Regimen stays in the model as the fallback for cases
 * with no pump data.
 */

export interface CeDrugSpec {
  key: string;
  label: string;
  unit: string;
  /** Concentration that maps to z = 1; roughly a typical maintenance target. */
  scale: number;
}

export const CE_DRUGS: CeDrugSpec[] = [
  { key: "propofol", label: "Propofol", unit: "µg/ml", scale: 3 },
  { key: "remifentanil", label: "Remifentanil", unit: "ng/ml", scale: 4 },
  { key: "alfentanil", label: "Alfentanil", unit: "ng/ml", scale: 100 },
  { key: "ketamine", label: "Ketamine", unit: "µg/ml", scale: 1 },
];

/** Learned smooth effect of one drug's effect-site concentration. */
export interface CeTerm {
  drug: string;
  /** Coefficient on normalised concentration. */
  linear: number;
  /** Coefficient on its square, allowing the effect to flatten or steepen. */
  curvature: number;
  /** Readings with a non-zero concentration of this drug. */
  n: number;
}

/** No drug term may move the index by more than this. */
export const MAX_CE_ADJUSTMENT = 5;
/** Nor all of them together. */
export const MAX_CE_TOTAL = 8;

/** Normalised concentration, clipped so an outlier target cannot dominate. */
export function ceZ(drug: CeDrugSpec, ce: Record<string, number> | null | undefined): number {
  const raw = ce?.[drug.key];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(2.5, raw / drug.scale);
}

/** The two design columns a drug contributes for one reading. */
export function ceBasis(ce: Record<string, number> | null | undefined): number[] {
  const out: number[] = [];
  for (const drug of CE_DRUGS) {
    const z = ceZ(drug, ce);
    out.push(z, z * z);
  }
  return out;
}

/** Column labels matching `ceBasis`, for diagnostics. */
export const CE_COLUMNS = CE_DRUGS.flatMap((d) => [`${d.key}:z`, `${d.key}:z2`]);

/** Total index adjustment from the fitted drug terms for one reading. */
export function ceAdjustment(
  terms: CeTerm[] | undefined,
  ce: Record<string, number> | null | undefined,
): { total: number; parts: { drug: string; dy: number }[] } {
  if (!terms?.length || !ce) return { total: 0, parts: [] };
  const parts: { drug: string; dy: number }[] = [];
  for (const drug of CE_DRUGS) {
    const term = terms.find((t) => t.drug === drug.key);
    if (!term) continue;
    const z = ceZ(drug, ce);
    if (!z) continue;
    const raw = term.linear * z + term.curvature * z * z;
    const dy = Math.max(-MAX_CE_ADJUSTMENT, Math.min(MAX_CE_ADJUSTMENT, raw));
    if (Math.abs(dy) < 0.1) continue;
    parts.push({ drug: drug.key, dy: Number(dy.toFixed(2)) });
  }
  const raw = parts.reduce((s, p) => s + p.dy, 0);
  return {
    total: Number(Math.max(-MAX_CE_TOTAL, Math.min(MAX_CE_TOTAL, raw)).toFixed(2)),
    parts,
  };
}

/** "Propofol Ce 4.0 µg/ml: +1.8 index points" */
export function describeCeTerm(term: CeTerm): string {
  const spec = CE_DRUGS.find((d) => d.key === term.drug);
  if (!spec) return term.drug;
  const at = spec.scale * 1.5;
  const z = 1.5;
  const dy = term.linear * z + term.curvature * z * z;
  return `${spec.label} Ce ${at.toFixed(spec.scale >= 10 ? 0 : 1)} ${spec.unit}: ${
    dy >= 0 ? "+" : "−"
  }${Math.abs(dy).toFixed(1)} index points`;
}

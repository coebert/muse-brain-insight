/**
 * Target-controlled infusion (TCI) models used at the bedside.
 *
 * The app does not run the pharmacokinetic model itself — the pump does. What
 * we capture is the clinician's contemporaneous record of which model is
 * running and what effect-site concentration (Ce) it is targeting, so that
 * changes can be time-aligned with the EEG and read by the AI interpreter.
 */

export type TciDrugKey = "propofol" | "alfentanil" | "ketamine" | "remifentanil";

export interface TciDrugSpec {
  key: TciDrugKey;
  label: string;
  /** Effect-site concentration unit as displayed on the pump. */
  unit: string;
  step: number;
  max: number;
  /** Typical starting Ce so a new infusion opens at a sensible value. */
  typical: number;
}

export interface TciModelSpec {
  key: string;
  label: string;
  /** Short label for chips and timeline markers. */
  short: string;
  drugs: TciDrugSpec[];
}

const PROPOFOL: TciDrugSpec = {
  key: "propofol",
  label: "Propofol",
  unit: "µg/mL",
  step: 0.1,
  max: 12,
  typical: 3,
};

const ALFENTANIL: TciDrugSpec = {
  key: "alfentanil",
  label: "Alfentanil",
  unit: "ng/mL",
  step: 5,
  max: 400,
  typical: 80,
};

const KETAMINE: TciDrugSpec = {
  key: "ketamine",
  label: "Ketamine",
  unit: "µg/mL",
  step: 0.05,
  max: 5,
  typical: 0.3,
};

const REMIFENTANIL: TciDrugSpec = {
  key: "remifentanil",
  label: "Remifentanil",
  unit: "ng/mL",
  step: 0.5,
  max: 15,
  typical: 3,
};

export const TCI_MODELS: TciModelSpec[] = [
  {
    key: "eleveld_propofol",
    label: "Eleveld — propofol",
    short: "Eleveld propofol",
    drugs: [PROPOFOL],
  },
  {
    key: "eleveld_propofol_alfentanil",
    label: "Eleveld — propofol + alfentanil",
    short: "Eleveld propofol+alfentanil",
    drugs: [PROPOFOL, ALFENTANIL],
  },
  {
    key: "eleveld_propofol_ketamine",
    label: "Eleveld — propofol + ketamine",
    short: "Eleveld propofol+ketamine",
    drugs: [PROPOFOL, KETAMINE],
  },
  {
    key: "eleveld_remifentanil",
    label: "Eleveld — remifentanil",
    short: "Eleveld remifentanil",
    drugs: [REMIFENTANIL],
  },
];

export function tciModel(key: string): TciModelSpec | undefined {
  return TCI_MODELS.find((m) => m.key === key);
}

/** One pump running for the current clinical episode. */
export interface TciInfusion {
  id: string;
  modelKey: string;
  /** Current target effect-site concentration per drug in the model. */
  targets: Record<string, number>;
  startedAt: number;
  stoppedAt: number | null;
  /** Case-clock time of the most recent Ce change, if any. */
  lastChangeAt?: number;
  /**
   * Every target the pump has held, oldest first, so the timeline overlay can
   * draw the dosing history against the EEG rather than only the latest value.
   */
  history?: TciCePoint[];
}

/** A target set held from `at` (case-clock seconds) until the next point. */
export interface TciCePoint {
  at: number;
  targets: Record<string, number>;
}

/** Distinct lane colours so each drug is recognisable on the overlay. */
export const TCI_DRUG_COLORS: Record<TciDrugKey, string> = {
  propofol: "rgb(120,220,180)",
  alfentanil: "rgb(255,176,64)",
  ketamine: "rgb(200,150,255)",
  remifentanil: "rgb(96,208,255)",
};

/**
 * Step history for one drug: the value held from each point onward. Falls back
 * to a single point at the start time for infusions recorded before history
 * tracking existed.
 */
export function ceHistory(
  infusion: TciInfusion,
  drug: TciDrugKey | string,
): { at: number; value: number }[] {
  const points =
    infusion.history && infusion.history.length > 0
      ? infusion.history
      : [{ at: infusion.startedAt, targets: infusion.targets }];
  const out: { at: number; value: number }[] = [];
  for (const p of points) {
    const value = p.targets[drug] ?? 0;
    if (out.length && out[out.length - 1]!.value === value) continue;
    out.push({ at: p.at, value });
  }
  return out;
}

/** Append a target set to the infusion's dosing history. */
export function withCePoint(infusion: TciInfusion, at: number): TciInfusion {
  const history = [...(infusion.history ?? []), { at, targets: { ...infusion.targets } }];
  return { ...infusion, history };
}

export function formatCe(value: number, drug: TciDrugSpec): string {
  const decimals = drug.step < 0.1 ? 2 : drug.step < 1 ? 1 : 0;
  return `${value.toFixed(decimals)} ${drug.unit}`;
}

/** "Ce propofol 3.0 µg/mL · alfentanil 80 ng/mL" */
export function describeTargets(model: TciModelSpec, targets: Record<string, number>): string {
  return model.drugs
    .map((d) => `${d.label.toLowerCase()} ${formatCe(targets[d.key] ?? 0, d)}`)
    .join(" · ");
}

export function defaultTargets(model: TciModelSpec): Record<string, number> {
  return Object.fromEntries(model.drugs.map((d) => [d.key, d.typical]));
}

export function clampCe(value: number, drug: TciDrugSpec): number {
  if (!Number.isFinite(value)) return 0;
  const stepped = Math.round(value / drug.step) * drug.step;
  return Math.min(drug.max, Math.max(0, Number(stepped.toFixed(3))));
}

/** One-line summary of everything currently running, for AI context. */
export function summariseInfusions(infusions: TciInfusion[]): string {
  const live = infusions.filter((i) => i.stoppedAt === null);
  if (!live.length) return "No TCI running";
  return live
    .map((i) => {
      const model = tciModel(i.modelKey);
      if (!model) return "";
      return `${model.short} (${describeTargets(model, i.targets)})`;
    })
    .filter(Boolean)
    .join("; ");
}

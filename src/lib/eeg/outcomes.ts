/**
 * Phase 6 — outcome linkage.
 *
 * The reason to measure depth at all is what happens to the patient afterwards.
 * This module defines the small post-case record the app keeps and the simple,
 * deliberately transparent comparisons it draws between EEG exposure during the
 * case and those outcomes. Nothing here is a causal claim — with a handful of
 * cases these are hypothesis-generating signals, and the wording says so.
 */

export const DELIRIUM_OPTIONS = [
  { key: "unknown", label: "Not assessed" },
  { key: "none", label: "No delirium" },
  { key: "hypoactive", label: "Hypoactive delirium" },
  { key: "hyperactive", label: "Hyperactive delirium" },
  { key: "mixed", label: "Mixed delirium" },
] as const;

export const EMERGENCE_OPTIONS = [
  { key: "unknown", label: "Not recorded" },
  { key: "smooth", label: "Smooth" },
  { key: "delayed", label: "Delayed" },
  { key: "agitated", label: "Agitated" },
] as const;

export interface CaseOutcome {
  id?: string;
  sessionId: string;
  delirium: string;
  deliriumDays: number | null;
  emergence: string;
  awareness: boolean;
  unplannedIcu: boolean;
  mortality30d: boolean;
  lengthOfStayDays: number | null;
  notes: string | null;
}

export const EMPTY_OUTCOME: Omit<CaseOutcome, "sessionId"> = {
  delirium: "unknown",
  deliriumDays: null,
  emergence: "unknown",
  awareness: false,
  unplannedIcu: false,
  mortality30d: false,
  lengthOfStayDays: null,
  notes: null,
};

/** EEG exposure summary for one case, joined to its outcome. */
export interface OutcomeCase {
  sessionId: string;
  caseCode: string;
  ageBand: string | null;
  /** When the case was recorded, ISO stamp; null for imported rows. */
  startedAt: string | null;
  durationMinutes: number;
  /** Mean depth index across the case. */
  meanDepth: number | null;
  /** Minutes spent with the depth index below 40. */
  minutesDeep: number;
  /** Mean suppression ratio, %. */
  meanSr: number;
  /** Minutes with any suppression. */
  minutesSuppressed: number;
  outcome: CaseOutcome | null;
}

export interface OutcomeSignal {
  /** Outcome examined, e.g. "Delirium". */
  outcome: string;
  /** EEG exposure compared, e.g. "Minutes with suppression". */
  exposure: string;
  withOutcome: { n: number; mean: number };
  withoutOutcome: { n: number; mean: number };
  difference: number;
  /** Plain-language reading of the comparison. */
  note: string;
  /** True once both arms have at least 5 cases. */
  meaningful: boolean;
}

const mean = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);

function hasDelirium(o: CaseOutcome | null): boolean | null {
  if (!o || o.delirium === "unknown") return null;
  return o.delirium !== "none";
}

function poorEmergence(o: CaseOutcome | null): boolean | null {
  if (!o || o.emergence === "unknown") return null;
  return o.emergence !== "smooth";
}

const EXPOSURES: { label: string; get: (c: OutcomeCase) => number | null }[] = [
  { label: "Minutes with suppression", get: (c) => c.minutesSuppressed },
  { label: "Minutes with depth index below 40", get: (c) => c.minutesDeep },
  { label: "Mean suppression ratio (%)", get: (c) => c.meanSr },
  { label: "Mean depth index", get: (c) => c.meanDepth },
  { label: "Case duration (minutes)", get: (c) => c.durationMinutes },
];

const OUTCOMES: { label: string; get: (o: CaseOutcome | null) => boolean | null }[] = [
  { label: "Delirium", get: hasDelirium },
  { label: "Non-smooth emergence", get: poorEmergence },
  { label: "Unplanned ICU admission", get: (o) => (o ? o.unplannedIcu : null) },
];

/**
 * Compare EEG exposure between cases with and without each recorded outcome.
 * Signals from thin arms are still returned, flagged as not yet meaningful, so
 * the clinician can see what is accumulating rather than nothing at all.
 */
export function analyseOutcomeSignals(cases: OutcomeCase[]): OutcomeSignal[] {
  const signals: OutcomeSignal[] = [];
  for (const outcome of OUTCOMES) {
    const withIt = cases.filter((c) => outcome.get(c.outcome) === true);
    const without = cases.filter((c) => outcome.get(c.outcome) === false);
    if (!withIt.length || !without.length) continue;
    for (const exposure of EXPOSURES) {
      const a = withIt.map(exposure.get).filter((v): v is number => v != null);
      const b = without.map(exposure.get).filter((v): v is number => v != null);
      if (!a.length || !b.length) continue;
      const ma = mean(a);
      const mb = mean(b);
      const diff = ma - mb;
      const meaningful = a.length >= 5 && b.length >= 5;
      signals.push({
        outcome: outcome.label,
        exposure: exposure.label,
        withOutcome: { n: a.length, mean: Number(ma.toFixed(1)) },
        withoutOutcome: { n: b.length, mean: Number(mb.toFixed(1)) },
        difference: Number(diff.toFixed(1)),
        meaningful,
        note: meaningful
          ? `Cases with ${outcome.label.toLowerCase()} averaged ${Math.abs(diff).toFixed(1)} ${diff >= 0 ? "more" : "fewer"} than those without — a signal to watch, not a causal finding.`
          : `Only ${a.length} vs ${b.length} cases so far — too thin to read anything into.`,
      });
    }
  }
  return signals.sort((x, y) => Math.abs(y.difference) - Math.abs(x.difference));
}

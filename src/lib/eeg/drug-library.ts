/**
 * Drug library: what each registered agent does to the frontal EEG, which
 * lineages the app actually holds it in, and how many independent cases those
 * lineages contribute.
 *
 * The point of the page this feeds is honesty about coverage. Every correction
 * in {@link DRUG_SPECS} is defensible from the published EEG literature, but
 * that is not the same as having seen the agent in this app's own corpora. An
 * agent with a documented signature and no recorded case is a rule waiting for
 * data, and the library says so rather than implying the correction has been
 * exercised here.
 *
 * Coverage is counted from declarations only — a regimen entry, an effect-site
 * concentration or a clinician marker. Spectral patterns are counted
 * separately, as advisory prevalence, and never as evidence that an agent was
 * given: the same fast-frequency pattern is produced by EMG, arousal and light
 * anaesthesia.
 */

import {
  ADVISORY_SCORE,
  DRUG_SPECS,
  drugPatternScore,
  type DrugKey,
  type DrugRole,
  type DrugSpec,
} from "./drug-signatures";
import type { KetamineFeatures } from "./ketamine";

/** One scanned epoch, reduced to what the library needs. */
export interface DrugLibraryEpoch {
  lineage: string;
  caseRef: string;
  features: KetamineFeatures;
  /** Agents recorded for this case. */
  declared: DrugKey[];
}

/** Coverage of one agent within one lineage. */
export interface DrugLineageCoverage {
  lineage: string;
  /** Distinct cases in this lineage that record the agent. */
  cases: number;
  /** Epochs in those cases. */
  epochs: number;
  /** Mean 0–1 strength of the agent's own pattern across its declared epochs. */
  meanScore: number | null;
}

/** One agent's entry in the library. */
export interface DrugLibraryEntry {
  key: DrugKey;
  label: string;
  role: DrugRole;
  direction: -1 | 0 | 1;
  cap: number;
  floor?: number;
  ceiling?: number;
  rationale: string;
  /** Words that identify the agent in a regimen, note or Ce entry. */
  terms: string[];
  /** Lineages that record the agent, richest first. */
  lineages: DrugLineageCoverage[];
  /** Distinct cases recording the agent, across every lineage. */
  totalCases: number;
  totalEpochs: number;
  /**
   * Cases where the agent's pattern is strong but the agent is NOT recorded.
   * Advisory only — this is never treated as exposure.
   */
  patternOnlyCases: number;
  /** Whether any case in the corpus records this agent. */
  covered: boolean;
}

export interface DrugLibraryReport {
  entries: DrugLibraryEntry[];
  /** Epoch rows read. */
  scanned: number;
  /** Distinct cases seen at all, whatever the drug. */
  totalCases: number;
  /** Distinct lineages seen at all. */
  totalLineages: number;
  /** Cases whose record names no agent this library knows. */
  undeclaredCases: number;
  notes: string[];
}

function readableTerms(spec: DrugSpec): string[] {
  return spec.match.source
    .split("|")
    .map((t) => t.replace(/[\\^$]/g, "").trim())
    .filter(Boolean);
}

export function emptyDrugLibrary(): DrugLibraryReport {
  return {
    entries: DRUG_SPECS.map((spec) => ({
      key: spec.key,
      label: spec.label,
      role: spec.role,
      direction: spec.direction,
      cap: spec.cap,
      ...(spec.floor == null ? {} : { floor: spec.floor }),
      ...(spec.ceiling == null ? {} : { ceiling: spec.ceiling }),
      rationale: spec.rationale,
      terms: readableTerms(spec),
      lineages: [],
      totalCases: 0,
      totalEpochs: 0,
      patternOnlyCases: 0,
      covered: false,
    })),
    scanned: 0,
    totalCases: 0,
    totalLineages: 0,
    undeclaredCases: 0,
    notes: [],
  };
}

/**
 * Pool scanned epochs into per-agent coverage.
 *
 * A case counts once per lineage however many epochs it contributes, so a long
 * recording cannot make an agent look better covered than it is.
 */
export function summariseDrugLibrary(
  epochs: DrugLibraryEpoch[],
  scanned = epochs.length,
): DrugLibraryReport {
  const report = emptyDrugLibrary();
  report.scanned = scanned;

  const byKey = new Map(report.entries.map((e) => [e.key, e]));
  // drug -> lineage -> { cases, epochs, scoreSum, scoreN }
  const coverage = new Map<
    DrugKey,
    Map<string, { cases: Set<string>; epochs: number; scoreSum: number; scoreN: number }>
  >();
  const patternOnly = new Map<DrugKey, Set<string>>();
  const allCases = new Set<string>();
  const declaredCases = new Set<string>();
  const allLineages = new Set<string>();

  for (const epoch of epochs) {
    const caseKey = `${epoch.lineage}/${epoch.caseRef}`;
    allCases.add(caseKey);
    allLineages.add(epoch.lineage);
    const declared = new Set(epoch.declared);
    if (declared.size) declaredCases.add(caseKey);

    for (const key of declared) {
      if (!byKey.has(key)) continue;
      const perLineage = coverage.get(key) ?? new Map();
      const slot = perLineage.get(epoch.lineage) ?? {
        cases: new Set<string>(),
        epochs: 0,
        scoreSum: 0,
        scoreN: 0,
      };
      slot.cases.add(epoch.caseRef);
      slot.epochs += 1;
      const score = drugPatternScore(key, epoch.features);
      if (epoch.features.betaFraction != null) {
        slot.scoreSum += score;
        slot.scoreN += 1;
      }
      perLineage.set(epoch.lineage, slot);
      coverage.set(key, perLineage);
    }

    // Undeclared agents whose pattern is nonetheless present.
    for (const spec of DRUG_SPECS) {
      if (spec.role !== "corrected" || declared.has(spec.key)) continue;
      if (drugPatternScore(spec.key, epoch.features) >= ADVISORY_SCORE) {
        const set = patternOnly.get(spec.key) ?? new Set<string>();
        set.add(caseKey);
        patternOnly.set(spec.key, set);
      }
    }
  }

  for (const entry of report.entries) {
    const perLineage = coverage.get(entry.key);
    if (perLineage) {
      entry.lineages = [...perLineage.entries()]
        .map(([lineage, slot]) => ({
          lineage,
          cases: slot.cases.size,
          epochs: slot.epochs,
          meanScore: slot.scoreN ? Number((slot.scoreSum / slot.scoreN).toFixed(3)) : null,
        }))
        .sort((a, b) => b.cases - a.cases || b.epochs - a.epochs);
      entry.totalCases = entry.lineages.reduce((sum, l) => sum + l.cases, 0);
      entry.totalEpochs = entry.lineages.reduce((sum, l) => sum + l.epochs, 0);
      entry.covered = entry.totalCases > 0;
    }
    entry.patternOnlyCases = patternOnly.get(entry.key)?.size ?? 0;
  }

  report.totalCases = allCases.size;
  report.totalLineages = allLineages.size;
  report.undeclaredCases = allCases.size - declaredCases.size;

  const uncovered = report.entries.filter((e) => !e.covered);
  if (uncovered.length) {
    report.notes.push(
      `${uncovered.length} of ${report.entries.length} agents are not recorded in any case held here (${uncovered
        .map((e) => e.label.toLowerCase())
        .join(", ")}). Their corrections come from the published EEG literature and have not been exercised against this corpus.`,
    );
  }
  if (report.undeclaredCases) {
    report.notes.push(
      `${report.undeclaredCases} of ${report.totalCases} cases name no agent at all. COEBIS applies no drug correction to those — an unrecorded agent is an uncorrected one.`,
    );
  }
  report.notes.push(
    "Pattern-only counts are advisory. The same spectrum is produced by muscle activity, arousal and light anaesthesia, so a pattern never stands in for a declaration.",
  );

  return report;
}

/** Sort for display: corrected agents with coverage first, then the rest. */
export function orderedLibrary(entries: DrugLibraryEntry[]): DrugLibraryEntry[] {
  const roleRank: Record<DrugRole, number> = { corrected: 0, reference: 1, neutral: 2 };
  return [...entries].sort(
    (a, b) =>
      roleRank[a.role] - roleRank[b.role] ||
      b.totalCases - a.totalCases ||
      b.cap - a.cap ||
      a.label.localeCompare(b.label),
  );
}

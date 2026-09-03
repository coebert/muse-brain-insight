/**
 * Adoption of discovered covariate terms into COEBIS.
 *
 * Discovery emits *candidate* offsets. This module decides, with explicit and
 * auditable reasons, which of those candidates are allowed to seed the COEBIS
 * covariate fit for a lineage. The rules are deliberately conservative:
 *
 *  - Only the app's own device lineages (`app:<device>`) can seed the
 *    device-specific COEBIS fit. External datasets (VitalDB, PhysioNet,
 *    OpenNeuro, CHB-MIT …) are recorded as supporting evidence only — they are
 *    never pooled into a device fit, because their montage, reference and
 *    amplifier differ.
 *  - A term needs `candidate` status (enough independent cases per level), an
 *    offset large enough to matter clinically, and a feature association that
 *    survived false-discovery correction.
 *  - Adopted values are *seeds*: they enter the fitter as starting offsets and
 *    still have to clear the refit gate on paired reference readings before any
 *    model version is promoted.
 */

import type {
  CandidateCoebisTerm,
  DiscoveryResult,
  LineageDiscovery,
} from "./covariate-discovery";
import type { DiagnosisLineageModel } from "./diagnosis-model";

/** Minimum absolute offset, in index points, worth carrying into the fit. */
export const MIN_ADOPTED_DY = 0.5;
/** Independent cases a level needs before its term can seed the fit. */
export const MIN_ADOPTED_CASES = 5;

export type AdoptionState = "adopted" | "held" | "evidence-only";

export interface AdoptedTerm {
  lineage: string;
  group: string;
  groupLabel: string;
  level: string;
  levelLabel: string;
  /** Seed offset in index points (shrunken and capped by discovery). */
  dy: number;
  cases: number;
  state: AdoptionState;
  /** Plain-language reason for the state. */
  reason: string;
  /** Leading feature behind the offset. */
  rationale: string;
}

export interface LineageAdoption {
  lineage: string;
  /** True when this lineage may seed the device-specific COEBIS fit. */
  deviceLineage: boolean;
  cases: number;
  terms: AdoptedTerm[];
  adoptedCount: number;
  heldCount: number;
  /** Seed offsets keyed `group:level`, only for adopted terms. */
  seed: Record<string, number>;
  summary: string;
}

export interface AdoptionLedger {
  lineages: LineageAdoption[];
  adoptedTotal: number;
  heldTotal: number;
  evidenceOnlyTotal: number;
  summary: string;
}

/** A lineage the app recorded itself, on a known device. */
export function isDeviceLineage(lineage: string): boolean {
  return lineage.startsWith("app:");
}

function decide(
  term: CandidateCoebisTerm,
  deviceLineage: boolean,
): { state: AdoptionState; reason: string } {
  if (!deviceLineage) {
    return {
      state: "evidence-only",
      reason:
        "External lineage — kept as supporting evidence; a different montage and amplifier cannot seed the device fit.",
    };
  }
  if (term.status !== "candidate") {
    return {
      state: "held",
      reason: `Only ${term.cases} independent cases at this level; ${MIN_ADOPTED_CASES} needed.`,
    };
  }
  if (term.cases < MIN_ADOPTED_CASES) {
    return {
      state: "held",
      reason: `Only ${term.cases} independent cases at this level; ${MIN_ADOPTED_CASES} needed.`,
    };
  }
  if (Math.abs(term.dy) < MIN_ADOPTED_DY) {
    return {
      state: "held",
      reason: `Offset ${term.dy.toFixed(2)} pts is below the ${MIN_ADOPTED_DY} point floor — too small to change management.`,
    };
  }
  return {
    state: "adopted",
    reason: `Seeds the covariate fit at ${term.dy > 0 ? "+" : ""}${term.dy.toFixed(1)} pts; promotion still requires the refit gate on paired reference readings.`,
  };
}

/** Build the adoption ledger for one lineage. */
export function adoptLineageTerms(lineage: LineageDiscovery): LineageAdoption {
  const deviceLineage = isDeviceLineage(lineage.lineage);
  const terms: AdoptedTerm[] = lineage.candidates.map((c) => {
    const { state, reason } = decide(c, deviceLineage);
    return {
      lineage: lineage.lineage,
      group: c.group,
      groupLabel: c.groupLabel,
      level: c.level,
      levelLabel: c.levelLabel,
      dy: c.dy,
      cases: c.cases,
      state,
      reason,
      rationale: c.rationale,
    };
  });
  const seed: Record<string, number> = {};
  for (const t of terms) if (t.state === "adopted") seed[`${t.group}:${t.level}`] = t.dy;
  const adoptedCount = terms.filter((t) => t.state === "adopted").length;
  const heldCount = terms.filter((t) => t.state === "held").length;
  const summary = !deviceLineage
    ? `${terms.length} discovered term${terms.length === 1 ? "" : "s"} held as external evidence only.`
    : adoptedCount
      ? `${adoptedCount} term${adoptedCount === 1 ? "" : "s"} seed the COEBIS covariate fit; ${heldCount} still short of the case gate.`
      : `No term clears the gate yet (${heldCount} awaiting more cases or a larger offset).`;
  return {
    lineage: lineage.lineage,
    deviceLineage,
    cases: lineage.cases,
    terms,
    adoptedCount,
    heldCount,
    seed,
    summary,
  };
}

/** Adoption ledger across every discovered lineage. */
export function buildAdoptionLedger(result: DiscoveryResult): AdoptionLedger {
  const lineages = result.lineages.map(adoptLineageTerms);
  const adoptedTotal = lineages.reduce((s, l) => s + l.adoptedCount, 0);
  const heldTotal = lineages.reduce((s, l) => s + l.heldCount, 0);
  const evidenceOnlyTotal = lineages.reduce(
    (s, l) => s + l.terms.filter((t) => t.state === "evidence-only").length,
    0,
  );
  return {
    lineages,
    adoptedTotal,
    heldTotal,
    evidenceOnlyTotal,
    summary: adoptedTotal
      ? `${adoptedTotal} covariate term${adoptedTotal === 1 ? "" : "s"} seeding COEBIS, ${heldTotal} held, ${evidenceOnlyTotal} external evidence-only.`
      : `No covariate term is eligible to seed COEBIS yet — ${heldTotal} held on device lineages, ${evidenceOnlyTotal} external evidence-only.`,
  };
}

/** Combined discovery payload: associations, adoption and diagnosis models. */
export interface DiscoveryBundle extends DiscoveryResult {
  adoption: AdoptionLedger;
  diagnosis: DiagnosisLineageModel[];
}

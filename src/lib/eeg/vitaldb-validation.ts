/**
 * Validation gate between a VitalDB waveform import and the COEBIS refit.
 *
 * Replaying a waveform always produces *something*; it does not follow that the
 * result is training data. A case only helps the fit when each retained point
 * carries a real monitor BIS value and a real replayed app index taken at the
 * same moment, and when the case contributes readings across enough of its
 * duration to represent more than one depth. This module checks that before an
 * import is written, and then reports how close each lineage sits to the refit
 * gate so the operator sees why a refit did or did not run.
 *
 * Pure functions only: the panel and the tests both call the same logic.
 */

import { MIN_POINTS, MIN_SESSIONS } from "./bis-drift";
import type { VitalDbPairedCase, VitalDbPairedPoint } from "./vitaldb-waveform";

/** Points below this per case cannot represent a depth range worth fitting. */
export const MIN_POINTS_PER_CASE = 5;
/** Points must cover at least this much case time, or they are one moment. */
export const MIN_SPAN_SECONDS = 120;
/** Below this fraction of reliable points the case is admitted but flagged. */
export const MIN_RELIABLE_FRACTION = 0.5;
/** A pair further apart than this in time is not a simultaneous observation. */
export const MAX_LAG_SECONDS = 2;

export type CaseVerdict = "usable" | "flagged" | "rejected";

export interface CaseValidation {
  caseRef: string;
  lineageKey: string;
  verdict: CaseVerdict;
  points: number;
  /** Points that survived the per-point checks below. */
  validPoints: number;
  reliablePoints: number;
  spanSeconds: number;
  bisRange: { min: number; max: number } | null;
  indexRange: { min: number; max: number } | null;
  maxLagSeconds: number;
  dropped: {
    nonFinite: number;
    bisOutOfRange: number;
    indexOutOfRange: number;
    lagTooLarge: number;
    duplicate: number;
  };
  reasons: string[];
}

export interface PairingValidation {
  cases: CaseValidation[];
  /** Cases whose points may be written and used for fitting. */
  acceptedCaseRefs: string[];
  totalPoints: number;
  validPoints: number;
  reliablePoints: number;
  acceptedCases: number;
  rejectedCases: number;
  flaggedCases: number;
  /** True when at least one case produced usable paired samples. */
  ok: boolean;
  summary: string;
}

function finite(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function range(values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/** Check one case's paired points and decide whether it may enter the fit. */
export function validatePairedCase(paired: VitalDbPairedCase): CaseValidation {
  const dropped = {
    nonFinite: 0,
    bisOutOfRange: 0,
    indexOutOfRange: 0,
    lagTooLarge: 0,
    duplicate: 0,
  };
  const seen = new Set<number>();
  const valid: VitalDbPairedPoint[] = [];

  for (const p of paired.points) {
    if (!finite(p.bis) || !finite(p.appIndex) || !finite(p.atSeconds)) {
      dropped.nonFinite++;
      continue;
    }
    if (p.bis <= 0 || p.bis > 100) {
      dropped.bisOutOfRange++;
      continue;
    }
    if (p.appIndex < 0 || p.appIndex > 100) {
      dropped.indexOutOfRange++;
      continue;
    }
    if (Math.abs(p.lagSeconds ?? 0) > MAX_LAG_SECONDS) {
      dropped.lagTooLarge++;
      continue;
    }
    if (seen.has(p.atSeconds)) {
      dropped.duplicate++;
      continue;
    }
    seen.add(p.atSeconds);
    valid.push(p);
  }

  const times = valid.map((p) => p.atSeconds);
  const spanSeconds = times.length ? Math.max(...times) - Math.min(...times) : 0;
  const reliablePoints = valid.filter((p) => p.reliable).length;
  const maxLagSeconds = valid.reduce((m, p) => Math.max(m, Math.abs(p.lagSeconds ?? 0)), 0);

  const reasons: string[] = [];
  let verdict: CaseVerdict = "usable";

  if (!valid.length) {
    verdict = "rejected";
    reasons.push("No monitor reading paired with a replayed second.");
  } else if (valid.length < MIN_POINTS_PER_CASE) {
    verdict = "rejected";
    reasons.push(
      `Only ${valid.length} paired reading${valid.length === 1 ? "" : "s"}; ${MIN_POINTS_PER_CASE} are needed before a case counts.`,
    );
  } else if (spanSeconds < MIN_SPAN_SECONDS) {
    verdict = "rejected";
    reasons.push(
      `Readings cover ${Math.round(spanSeconds)}s of case time; a case must span at least ${MIN_SPAN_SECONDS}s to show more than one depth.`,
    );
  }

  if (verdict !== "rejected") {
    const reliableFraction = reliablePoints / valid.length;
    if (reliableFraction < MIN_RELIABLE_FRACTION) {
      verdict = "flagged";
      reasons.push(
        `Only ${Math.round(reliableFraction * 100)}% of readings were flagged reliable by the monitor's own signal quality.`,
      );
    }
    const bis = range(valid.map((p) => p.bis));
    if (bis && bis.max - bis.min < 10) {
      verdict = verdict === "usable" ? "flagged" : verdict;
      reasons.push(
        `Monitor BIS only moved ${(bis.max - bis.min).toFixed(0)} points, so this case adds little depth range.`,
      );
    }
  }

  const total = paired.points.length;
  const lost = total - valid.length;
  if (lost > 0 && verdict !== "rejected") {
    reasons.push(`${lost} of ${total} paired points failed a sample check and were dropped.`);
  }

  return {
    caseRef: paired.caseRef,
    lineageKey: paired.lineageKey,
    verdict,
    points: total,
    validPoints: valid.length,
    reliablePoints,
    spanSeconds: Math.round(spanSeconds),
    bisRange: range(valid.map((p) => p.bis)),
    indexRange: range(valid.map((p) => p.appIndex)),
    maxLagSeconds: Number(maxLagSeconds.toFixed(2)),
    dropped,
    reasons,
  };
}

/** Validate every replayed case in an import batch. */
export function validatePairedCases(cases: VitalDbPairedCase[]): PairingValidation {
  const results = cases.map(validatePairedCase);
  const accepted = results.filter((r) => r.verdict !== "rejected");
  const validPoints = accepted.reduce((s, r) => s + r.validPoints, 0);
  const reliablePoints = accepted.reduce((s, r) => s + r.reliablePoints, 0);
  const totalPoints = results.reduce((s, r) => s + r.points, 0);
  const rejected = results.length - accepted.length;
  const flagged = accepted.filter((r) => r.verdict === "flagged").length;

  const summary = !cases.length
    ? "No replayed cases to validate."
    : !accepted.length
      ? `None of the ${cases.length} replayed case${cases.length === 1 ? "" : "s"} produced usable EEG-index-to-BIS pairs.`
      : `${validPoints} paired reading${validPoints === 1 ? "" : "s"} across ${accepted.length} case${accepted.length === 1 ? "" : "s"} passed validation` +
        `${rejected ? `, ${rejected} case${rejected === 1 ? "" : "s"} rejected` : ""}` +
        `${flagged ? `, ${flagged} flagged` : ""}.`;

  return {
    cases: results,
    acceptedCaseRefs: accepted.map((r) => r.caseRef),
    totalPoints,
    validPoints,
    reliablePoints,
    acceptedCases: accepted.length,
    rejectedCases: rejected,
    flaggedCases: flagged,
    ok: accepted.length > 0,
    summary,
  };
}

export interface LineageCoverage {
  lineageKey: string;
  /** Readings and cases already stored for this lineage. */
  storedReadings: number;
  storedCases: number;
  /** Stored plus what this import just added. */
  readings: number;
  cases: number;
  needReadings: number;
  needCases: number;
  meetsGate: boolean;
  shortfall: string | null;
}

export interface GateCoverage {
  lineages: LineageCoverage[];
  /** True when at least one touched lineage clears the refit gate. */
  ready: boolean;
  summary: string;
}

/**
 * Report how far each touched lineage is from the refit gate, using the counts
 * stored after the import. Lineages are kept separate on purpose: readings from
 * a different montage or sample rate must never top up another lineage's count.
 */
export function assessGateCoverage(
  storedCounts: { lineageKey: string; readings: number; cases: number }[],
  touchedLineages: string[],
): GateCoverage {
  const byKey = new Map(storedCounts.map((c) => [c.lineageKey, c]));
  const lineages: LineageCoverage[] = touchedLineages.map((lineageKey) => {
    const stored = byKey.get(lineageKey);
    const readings = stored?.readings ?? 0;
    const cases = stored?.cases ?? 0;
    const meetsGate = readings >= MIN_POINTS && cases >= MIN_SESSIONS;
    const missingReadings = Math.max(0, MIN_POINTS - readings);
    const missingCases = Math.max(0, MIN_SESSIONS - cases);
    return {
      lineageKey,
      storedReadings: readings,
      storedCases: cases,
      readings,
      cases,
      needReadings: MIN_POINTS,
      needCases: MIN_SESSIONS,
      meetsGate,
      shortfall: meetsGate
        ? null
        : `${readings}/${MIN_POINTS} readings across ${cases}/${MIN_SESSIONS} cases — ` +
          [
            missingReadings ? `${missingReadings} more reading${missingReadings === 1 ? "" : "s"}` : null,
            missingCases ? `${missingCases} more case${missingCases === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" and ") +
          " needed.",
    };
  });

  const ready = lineages.some((l) => l.meetsGate);
  const summary = !lineages.length
    ? "No lineage was touched by this import."
    : ready
      ? `Gate met by ${lineages.filter((l) => l.meetsGate).map((l) => l.lineageKey).join(", ")} — refit may run.`
      : `No lineage clears ${MIN_POINTS} readings across ${MIN_SESSIONS} cases yet, so the refit was not run.`;

  return { lineages, ready, summary };
}

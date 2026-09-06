/**
 * Why a lineage has no live COEBIS model, and what would unblock it.
 *
 * Two different things stop a lineage: not enough independent cases to
 * cross-validate on (a data problem — collect more), or enough data but a
 * candidate that failed to beat the incumbent (an evidence problem — more of
 * the same readings will not help; better covariates or a better feature set
 * might). The distinction matters clinically, because only the first is fixed
 * by recording more cases, and conflating the two invites people to keep
 * feeding a model that is already at its ceiling.
 *
 * Covariate opportunity is judged the same conservative way the fit is: a
 * covariate is only "ready" when it varies across enough *independent cases*,
 * not enough readings — a single long case supplying 3,000 epochs at one age
 * band carries exactly one case's worth of information.
 */

import { MIN_POINTS, MIN_SESSIONS } from "./bis-drift";
import type { CoebisTrainingPoint } from "./coebis-covariates";
import { CE_DRUGS } from "./ce-terms";
import { covariateLevels } from "./covariates";
import { parseLineageKey } from "./model-lineage";

/**
 * Case-folds below this make a leave-one-case-out estimate too coarse to trust
 * as an improvement claim, even once the promotion gate is technically met.
 */
export const STABLE_CV_CASES = 10;
/** A covariate level needs this many independent cases before it can be fitted. */
export const MIN_LEVEL_CASES = 2;
/** And a covariate needs this share of readings filled in to be usable at all. */
export const MIN_COVERAGE = 0.6;

export type BlockerStatus =
  | "live"
  | "provisional"
  | "awaiting-refit"
  | "evidence"
  | "cases"
  | "readings"
  | "unattributed";

export interface LineageVersionRow {
  lineageKey: string;
  version: number;
  promoted: boolean;
  isActive: boolean;
  maeGain: number | null;
  createdAt: string | null;
}

export interface LineageBlocker {
  lineageKey: string;
  deviceId: string | null;
  channels: string[];
  sampleRate: number | null;
  readings: number;
  cases: number;
  activeVersion: number | null;
  latestVersion: number | null;
  latestMaeGain: number | null;
  status: BlockerStatus;
  blocked: boolean;
  /** Extra readings needed before the gate opens. */
  readingsNeeded: number;
  /** Extra independent cases needed before the gate opens. */
  casesNeeded: number;
  /** Extra cases needed for a stable leave-one-case-out estimate. */
  casesForStableCv: number;
  headline: string;
  detail: string;
}

function describeLineage(key: string): Pick<LineageBlocker, "deviceId" | "channels" | "sampleRate"> {
  const parsed = parseLineageKey(key);
  if (!parsed) return { deviceId: null, channels: [], sampleRate: null };
  return { deviceId: parsed.deviceId, channels: parsed.channels, sampleRate: parsed.sampleRate };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Group validated readings per lineage and say what is holding each one back. */
export function buildLineageBlockers(
  points: CoebisTrainingPoint[],
  versions: LineageVersionRow[],
): LineageBlocker[] {
  const readings = new Map<string, number>();
  const cases = new Map<string, Set<string>>();
  for (const p of points) {
    const key = p.lineageKey ?? "unattributed";
    readings.set(key, (readings.get(key) ?? 0) + 1);
    const set = cases.get(key) ?? new Set<string>();
    set.add(p.sessionId ?? "unfiled");
    cases.set(key, set);
  }

  const active = new Map<string, LineageVersionRow>();
  const latest = new Map<string, LineageVersionRow>();
  for (const v of versions) {
    const seen = latest.get(v.lineageKey);
    if (!seen || v.version > seen.version) latest.set(v.lineageKey, v);
    if (v.isActive && !active.has(v.lineageKey)) active.set(v.lineageKey, v);
  }
  for (const key of latest.keys()) if (!readings.has(key)) readings.set(key, 0);

  const out: LineageBlocker[] = [];
  for (const key of readings.keys()) {
    const n = readings.get(key) ?? 0;
    const caseCount = cases.get(key)?.size ?? 0;
    const base = describeLineage(key);
    const activeRow = active.get(key) ?? null;
    const latestRow = latest.get(key) ?? null;
    const readingsNeeded = Math.max(0, MIN_POINTS - n);
    const casesNeeded = Math.max(0, MIN_SESSIONS - caseCount);
    const casesForStableCv = Math.max(0, STABLE_CV_CASES - caseCount);

    let status: BlockerStatus;
    let headline: string;
    let detail: string;

    if (key === "unattributed") {
      status = "unattributed";
      headline = "No acquisition lineage recorded";
      detail =
        "These readings cannot be fitted at all: without a device, montage and sample rate they cannot be shown to belong to the same acquisition setup. File them against the headset they were recorded on.";
    } else if (casesNeeded > 0) {
      status = "cases";
      headline = `Needs ${plural(casesNeeded, "more case")} to cross-validate`;
      detail = `Leave-one-case-out validation needs at least ${MIN_SESSIONS} independent cases; this lineage has ${caseCount}. Readings from the cases already recorded do not count towards this — only new patients do.`;
    } else if (readingsNeeded > 0 && activeRow) {
      status = "provisional";
      headline = `Provisional model v${activeRow.version} in force`;
      detail = `Fitted on this headband's own ${n} paired readings across ${caseCount} cases and cross-validated case by case, but still ${plural(readingsNeeded, "reading")} short of the ${MIN_POINTS}-reading bar. It corrects a large, well-evidenced offset; treat the number as provisional until the gate is cleared.`;
    } else if (readingsNeeded > 0) {
      status = "readings";
      headline = `Needs ${plural(readingsNeeded, "more paired reading")}`;
      detail = `Case cover is met (${caseCount}/${MIN_SESSIONS}), but the gate also asks for ${MIN_POINTS} validated readings and this lineage has ${n}.`;
    } else if (!activeRow) {
      status = latestRow ? "evidence" : "awaiting-refit";
      headline = latestRow
        ? "Gate cleared, but no candidate has beaten the reference yet"
        : "Gate cleared, awaiting the next refit";
      detail = latestRow
        ? `Version ${latestRow.version} was fitted and recorded but not promoted${
            latestRow.maeGain == null
              ? ""
              : ` (held-out error changed by ${latestRow.maeGain.toFixed(2)} points)`
          }. More readings from the same cases will not fix this — it needs either more distinct patients or a covariate the model does not yet have.`
        : `${n} validated readings across ${caseCount} cases are ready; the next refit will fit and grade a candidate.`;
    } else {
      status = "live";
      headline = `Live model v${activeRow.version}`;
      detail =
        casesForStableCv > 0
          ? `Promoted, but on only ${caseCount} case-folds. ${plural(casesForStableCv, "further case")} would make the held-out estimate stable.`
          : `Promoted on ${caseCount} case-folds.`;
    }

    out.push({
      lineageKey: key,
      ...base,
      readings: n,
      cases: caseCount,
      activeVersion: activeRow?.version ?? null,
      latestVersion: latestRow?.version ?? null,
      latestMaeGain: latestRow?.maeGain ?? null,
      status,
      blocked: status !== "live",
      readingsNeeded,
      casesNeeded,
      casesForStableCv,
      headline,
      detail,
    });
  }

  const rank: Record<BlockerStatus, number> = {
    cases: 0,
    readings: 1,
    provisional: 1.5,
    evidence: 2,
    "awaiting-refit": 3,
    unattributed: 4,
    live: 5,
  };
  return out.sort(
    (a, b) => rank[a.status] - rank[b.status] || b.readings - a.readings,
  );
}

export type CovariateStatus = "ready" | "constant" | "sparse" | "missing";

export interface CovariateOpportunity {
  group: string;
  label: string;
  /** Share of validated readings that carry a value, 0–1. */
  coverage: number;
  /** Share of cases that carry a value, 0–1. */
  caseCoverage: number;
  levels: { level: string; cases: number; readings: number }[];
  /** Levels backed by at least MIN_LEVEL_CASES independent cases. */
  usableLevels: number;
  status: CovariateStatus;
  advice: string;
}

const COVARIATE_LABELS: Record<string, string> = {
  age: "Age band",
  sex: "Sex",
  regimen: "Drug regimen",
  frailty: "Frailty",
  chronic: "Chronic disease burden",
  chronic_cns: "Chronic neurological disease",
  acute: "Acute pathology class",
};

/**
 * Which covariates carry enough independent-case variation to earn a term.
 * Reported per lineage, because a covariate that discriminates in theatre data
 * may be constant in an ICU cohort.
 */
export function covariateOpportunities(points: CoebisTrainingPoint[]): CovariateOpportunity[] {
  const totalReadings = points.length;
  const allCases = new Set(points.map((p) => p.sessionId ?? "unfiled"));

  const groups = new Map<
    string,
    { readings: number; cases: Set<string>; levels: Map<string, { readings: number; cases: Set<string> }> }
  >();
  for (const group of Object.keys(COVARIATE_LABELS)) {
    groups.set(group, { readings: 0, cases: new Set(), levels: new Map() });
  }

  for (const p of points) {
    const caseId = p.sessionId ?? "unfiled";
    for (const [group, level] of covariateLevels(p.cov)) {
      const entry = groups.get(group);
      if (!entry) continue;
      entry.readings++;
      entry.cases.add(caseId);
      const lv = entry.levels.get(level) ?? { readings: 0, cases: new Set<string>() };
      lv.readings++;
      lv.cases.add(caseId);
      entry.levels.set(level, lv);
    }
  }

  // Effect-site concentrations are continuous, so they are graded on how many
  // cases actually ran the drug rather than on level counts.
  for (const drug of CE_DRUGS) {
    const entry = { readings: 0, cases: new Set<string>(), levels: new Map<string, { readings: number; cases: Set<string> }>() };
    for (const p of points) {
      const value = p.ce?.[drug.key];
      if (value == null || !Number.isFinite(value) || value <= 0) continue;
      const caseId = p.sessionId ?? "unfiled";
      entry.readings++;
      entry.cases.add(caseId);
      const band = value >= drug.scale ? "at or above typical target" : "below typical target";
      const lv = entry.levels.get(band) ?? { readings: 0, cases: new Set<string>() };
      lv.readings++;
      lv.cases.add(caseId);
      entry.levels.set(band, lv);
    }
    groups.set(`ce:${drug.key}`, entry);
    COVARIATE_LABELS[`ce:${drug.key}`] = `${drug.label} effect-site (${drug.unit})`;
  }

  const out: CovariateOpportunity[] = [];
  for (const [group, entry] of groups) {
    const levels = [...entry.levels.entries()]
      .map(([level, v]) => ({ level, cases: v.cases.size, readings: v.readings }))
      .sort((a, b) => b.cases - a.cases || b.readings - a.readings);
    const usableLevels = levels.filter((l) => l.cases >= MIN_LEVEL_CASES).length;
    const coverage = totalReadings ? entry.readings / totalReadings : 0;
    const caseCoverage = allCases.size ? entry.cases.size / allCases.size : 0;

    let status: CovariateStatus;
    let advice: string;
    if (entry.readings === 0) {
      status = "missing";
      advice = "Never recorded on these readings — capture it at case filing and it becomes available to the next refit.";
    } else if (levels.length < 2) {
      status = "constant";
      advice = `Recorded, but every case reads "${levels[0]?.level ?? "?"}". A constant carries no information; it can only help once cases differ on it.`;
    } else if (usableLevels < 2 || coverage < MIN_COVERAGE) {
      status = "sparse";
      advice = `Varies, but only ${usableLevels} level${usableLevels === 1 ? "" : "s"} ${
        usableLevels === 1 ? "is" : "are"
      } backed by ${MIN_LEVEL_CASES}+ independent cases and ${Math.round(coverage * 100)}% of readings carry a value. More cases in the thin levels would make it fittable.`;
    } else {
      status = "ready";
      advice = `${usableLevels} levels across ${entry.cases.size} cases with ${Math.round(coverage * 100)}% coverage — enough to fit a shrunk residual term and grade it out of sample.`;
    }

    out.push({
      group,
      label: COVARIATE_LABELS[group] ?? group,
      coverage: Number(coverage.toFixed(3)),
      caseCoverage: Number(caseCoverage.toFixed(3)),
      levels,
      usableLevels,
      status,
      advice,
    });
  }

  const rank: Record<CovariateStatus, number> = { ready: 0, sparse: 1, constant: 2, missing: 3 };
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.coverage - a.coverage);
}

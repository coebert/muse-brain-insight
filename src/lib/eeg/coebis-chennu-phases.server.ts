/**
 * COEBIS read across the Cambridge propofol arc, phase by phase.
 *
 * The volunteers were taken through four recorded blocks at stepped
 * target-controlled propofol levels. That is not a surgical case, and saying
 * so matters: there is no airway, no stimulus, no surgery, and the deepest
 * block is moderate sedation, not anaesthesia. What the protocol *does* give
 * is the one thing a depth index has to get right — an ordered arc, from no
 * drug, up through a rising target, to a peak target, and back out again.
 *
 * The blocks map onto the phases of a case as follows, and the mapping is
 * stated rather than assumed:
 *
 *   baseline  → awake, no drug
 *   mild      → induction: the drug is rising towards its target
 *   moderate  → maintenance: the peak target held
 *   recovery  → emergence: drug withdrawn, volunteer coming back
 *
 * The grading asks only about direction, never agreement: does the index fall
 * from baseline through induction into maintenance, and rise again at
 * emergence, within the same volunteer? Within-volunteer is the whole point —
 * a between-volunteer average can look right while no individual arc does.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { CHENNU_LINEAGE } from "./chennu";
import { scoreStoredCase, type StoredSpectrum } from "./coebis-spectra";
import { COEBIS_V2_MODEL, coebisV2Applicability } from "./coebis-v2";

type Client = SupabaseClient<any, any, any>;

export const MAX_PHASE_EPOCHS = 40_000;
const PAGE = 1000;

export type CasePhase = "baseline" | "induction" | "maintenance" | "emergence";

export const PHASE_ORDER: CasePhase[] = ["baseline", "induction", "maintenance", "emergence"];

export const PHASE_TEXT: Record<CasePhase, { label: string; detail: string }> = {
  baseline: { label: "Baseline", detail: "No drug, volunteer awake" },
  induction: { label: "Induction", detail: "Propofol rising to 0.6 µg/ml" },
  maintenance: { label: "Maintenance", detail: "Peak target 1.2 µg/ml held" },
  emergence: { label: "Emergence", detail: "Drug withdrawn, recovering" },
};

/** The recorded block a phase is read from. */
export function phaseOfLevel(level: string | null): CasePhase | null {
  switch (level) {
    case "baseline":
      return "baseline";
    case "mild":
      return "induction";
    case "moderate":
      return "maintenance";
    case "recovery":
      return "emergence";
    default:
      return null;
  }
}

export interface PhaseScore {
  phase: CasePhase;
  label: string;
  detail: string;
  epochs: number;
  cases: number;
  meanIndex: number;
  sdIndex: number;
  minIndex: number;
  maxIndex: number;
  /** Share of readings below 60, the usual "adequate anaesthesia" line. */
  belowSixty: number;
  /** Share of readings whose volunteer was not answering at the time. */
  unresponsiveShare: number;
}

export interface CaseArc {
  caseRef: string;
  /** Mean index in each phase; null where the volunteer has no such block. */
  phases: Record<CasePhase, number | null>;
  /** Baseline → maintenance, negative when the index fell as the drug rose. */
  deepening: number | null;
  /** Maintenance → emergence, positive when the index came back up. */
  recovery: number | null;
}

export interface ChennuPhaseReport {
  lineage: string;
  modelLineage: string;
  applicability: "fitted" | "near" | "extrapolated";
  epochs: number;
  cases: number;
  byPhase: PhaseScore[];
  arcs: CaseArc[];
  /** Volunteers whose index fell from baseline to maintenance. */
  deepenedCount: number;
  /** Volunteers whose index rose again at emergence. */
  recoveredCount: number;
  /** Volunteers with both a baseline and a maintenance block. */
  comparableCount: number;
  truncated: boolean;
}

interface Row {
  caseRef: string;
  channel: string | null;
  level: string | null;
  atSeconds: number;
  label: string;
  spectrumDb: number[] | null;
  freqStart: number;
  freqStep: number;
  suppressionPct: number | null;
}

async function loadRows(
  supabase: Client,
  userId: string,
  limit: number,
): Promise<{ rows: Row[]; truncated: boolean }> {
  const rows: Row[] = [];
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select(
        "case_ref, channel, at_seconds, label, spectrum_db, freq_start_hz, freq_step_hz, suppression_ratio, covariates",
      )
      .eq("user_id", userId)
      .eq("source_lineage", CHENNU_LINEAGE)
      .order("case_ref", { ascending: true })
      .order("at_seconds", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as Record<string, unknown>[];
    for (const r of page) {
      const cov = (r["covariates"] ?? {}) as Record<string, unknown>;
      rows.push({
        caseRef: String(r["case_ref"] ?? "?"),
        channel: r["channel"] == null ? null : String(r["channel"]),
        level: typeof cov["level"] === "string" ? (cov["level"] as string) : null,
        atSeconds: Number(r["at_seconds"] ?? 0),
        label: String(r["label"] ?? ""),
        spectrumDb: Array.isArray(r["spectrum_db"]) ? (r["spectrum_db"] as number[]) : null,
        freqStart: Number(r["freq_start_hz"] ?? 0),
        freqStep: Number(r["freq_step_hz"] ?? 0),
        suppressionPct: r["suppression_ratio"] == null ? null : Number(r["suppression_ratio"]),
      });
    }
    if (page.length < PAGE) return { rows, truncated: false };
  }
  return { rows, truncated: true };
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / (xs.length - 1));
};
const round = (v: number, places = 1) => Number(v.toFixed(places));

/** Score every Cambridge block with COEBIS and read the arc phase by phase. */
export async function runChennuPhaseFit(
  supabase: Client,
  userId: string,
  limit = MAX_PHASE_EPOCHS,
): Promise<ChennuPhaseReport> {
  const { rows, truncated } = await loadRows(supabase, userId, limit);

  // One estimator run per volunteer, channel and block: each block is its own
  // recording with its own clock, so they must never be scored as one track.
  const tracks = new Map<string, Row[]>();
  for (const r of rows) {
    const key = `${r.caseRef}::${r.channel ?? "eeg"}::${r.level ?? "-"}`;
    const list = tracks.get(key);
    if (list) list.push(r);
    else tracks.set(key, [r]);
  }

  const perPhase = new Map<CasePhase, { index: number[]; cases: Set<string>; unresp: number }>();
  const perCasePhase = new Map<string, Map<CasePhase, number[]>>();
  let scored = 0;

  for (const track of tracks.values()) {
    const spectra: StoredSpectrum[] = track.map((r) => ({
      atSeconds: r.atSeconds,
      spectrumDb: r.spectrumDb,
      freqStart: r.freqStart,
      freqStep: r.freqStep,
      suppressionPct: r.suppressionPct,
    }));
    const byTime = new Map(scoreStoredCase(spectra).map((x) => [x.atSeconds, x.index]));

    for (const r of track) {
      const phase = phaseOfLevel(r.level);
      const index = byTime.get(r.atSeconds);
      if (!phase || index == null) continue;
      scored++;

      const bucket = perPhase.get(phase) ?? { index: [], cases: new Set<string>(), unresp: 0 };
      bucket.index.push(index);
      bucket.cases.add(r.caseRef);
      if (r.label === "sedated_unresponsive") bucket.unresp++;
      perPhase.set(phase, bucket);

      const caseMap = perCasePhase.get(r.caseRef) ?? new Map<CasePhase, number[]>();
      const list = caseMap.get(phase) ?? [];
      list.push(index);
      caseMap.set(phase, list);
      perCasePhase.set(r.caseRef, caseMap);
    }
  }

  const byPhase: PhaseScore[] = PHASE_ORDER.filter((p) => perPhase.has(p)).map((phase) => {
    const b = perPhase.get(phase)!;
    return {
      phase,
      label: PHASE_TEXT[phase].label,
      detail: PHASE_TEXT[phase].detail,
      epochs: b.index.length,
      cases: b.cases.size,
      meanIndex: round(mean(b.index)),
      sdIndex: round(sd(b.index)),
      minIndex: round(Math.min(...b.index)),
      maxIndex: round(Math.max(...b.index)),
      belowSixty: b.index.filter((v) => v < 60).length / b.index.length,
      unresponsiveShare: b.unresp / b.index.length,
    };
  });

  const arcs: CaseArc[] = [...perCasePhase.entries()]
    .map(([caseRef, phases]) => {
      const at = (p: CasePhase) => {
        const xs = phases.get(p);
        return xs && xs.length ? round(mean(xs)) : null;
      };
      const baseline = at("baseline");
      const maintenance = at("maintenance");
      const emergence = at("emergence");
      return {
        caseRef,
        phases: {
          baseline,
          induction: at("induction"),
          maintenance,
          emergence,
        },
        deepening:
          baseline != null && maintenance != null ? round(maintenance - baseline) : null,
        recovery:
          maintenance != null && emergence != null ? round(emergence - maintenance) : null,
      };
    })
    .sort((a, b) => a.caseRef.localeCompare(b.caseRef));

  const comparable = arcs.filter((a) => a.deepening != null);
  return {
    lineage: CHENNU_LINEAGE,
    modelLineage: COEBIS_V2_MODEL.meta.lineage,
    applicability: coebisV2Applicability(CHENNU_LINEAGE, 250, null),
    epochs: scored,
    cases: perCasePhase.size,
    byPhase,
    arcs,
    deepenedCount: comparable.filter((a) => (a.deepening ?? 0) < 0).length,
    recoveredCount: arcs.filter((a) => (a.recovery ?? 0) > 0).length,
    comparableCount: comparable.length,
    truncated,
  };
}

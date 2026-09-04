/**
 * Server-only loader for the pathology dashboard.
 *
 * Collects every analysed epoch that carries a label established *outside* the
 * app's analysis path, and attaches the scores the app produced at that moment.
 * Two label origins are accepted:
 *
 *  - dataset annotations on imported spectral epochs (e.g. an EEG corpus that
 *    marks ictal intervals, or a participant file recording CNS disease), and
 *  - clinician timeline annotations on the app's own cases.
 *
 * The app's own seizure detections (`eeg_events.kind = "seizure"`) are
 * deliberately NOT treated as labels: grading a detector against itself would
 * report perfect accuracy and mean nothing.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { ACUTE_PATHOLOGY, CHRONIC_CONDITIONS, NONE_KEY } from "./clinical-covariates";
import {
  evaluatePathologyLabels,
  MONITOR_CLEAR_PCT,
  MONITOR_SUPPRESSED_PCT,
  type DepthStateLabel,
  type LabelledEpoch,
  type PathologyLabelEvaluation,
  type SuppressionLabel,
} from "./pathology-labels";

type Client = SupabaseClient<any, any, any>;

const PAGE = 1000;
/** Epochs kept per case before thinning, so one long recording cannot dominate. */
const MAX_EPOCHS_PER_CASE = 600;
/** Clinician annotations without a duration are read as this many seconds of ictal time. */
export const DEFAULT_ANNOTATION_SECONDS = 30;

/** Wording a clinician uses when marking seizure activity on the timeline. */
const SEIZURE_ANNOTATION = /seizure|ictal|convuls|status epilepticus|fitting|jerking|twitch/i;

const NEURO_KEYS = new Set(
  [...CHRONIC_CONDITIONS, ...ACUTE_PATHOLOGY]
    .filter((c) => c.system === "neuro")
    .map((c) => c.key),
);

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Normalise a stored suppression figure to percent. */
function asPercent(v: number | null): number | null {
  if (v == null) return null;
  return v > 0 && v <= 1 ? v * 100 : v;
}

/** Ictal status a dataset recorded for one imported epoch, if any. */
export function datasetSeizureLabel(
  covariates: Record<string, unknown> | null,
  label: string | null,
  labelSource: string | null,
): LabelledEpoch["seizure"] {
  if (labelSource === "dataset" && typeof label === "string") {
    if (/^(ictal|seizure)$/i.test(label)) return "ictal";
    if (/^(interictal|baseline_eeg)$/i.test(label)) return "interictal";
  }
  const intervals = num(covariates?.["seizure_intervals"]);
  if (intervals != null) return intervals > 0 ? "ictal" : "interictal";
  const flag = covariates?.["ictal"];
  if (typeof flag === "boolean") return flag ? "ictal" : "interictal";
  return null;
}

/** CNS disease a dataset recorded for one imported case, if any. */
export function datasetCnsLabel(covariates: Record<string, unknown> | null): string | null {
  const explicit = covariates?.["cns_disease"] ?? covariates?.["diagnosis"];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const category = covariates?.["pathology_category"];
  if (typeof category === "string") {
    if (/seizure|epilep/i.test(category)) return "seizure_disorder";
    if (/control|healthy/i.test(category)) return "none";
    if (/stroke|tbi|hypox|encephal/i.test(category)) return category.toLowerCase();
  }
  return null;
}

/** CNS disease a case record establishes: a neuro condition, or an explicit "none". */
export function caseCnsLabel(
  chronic: string[] | null,
  acute: string[] | null,
  clinicalFeatures: string[] | null,
): string | null {
  const chronicList = chronic ?? [];
  const acuteList = acute ?? [];
  const neuro = [...chronicList, ...acuteList].find((k) => NEURO_KEYS.has(k));
  if (neuro) return neuro;
  const featureNeuro = (clinicalFeatures ?? [])
    .map((f) => f.toLowerCase().trim())
    .find((f) => /stroke|seizure|epilep|hypox|ihca|oohca|arrest|tbi|haemorrhage|delirium/.test(f));
  if (featureNeuro) {
    if (/ihca|oohca|arrest|hypox/.test(featureNeuro)) return "hypoxic_brain_injury";
    if (/stroke/.test(featureNeuro)) return "acute_stroke";
    if (/seizure|epilep/.test(featureNeuro)) return "epilepsy";
    if (/tbi/.test(featureNeuro)) return "tbi";
    if (/haemorrhage/.test(featureNeuro)) return "ich";
    if (/delirium/.test(featureNeuro)) return "delirium";
  }
  // Only claim "no CNS disease" when the clinician actually filed "None";
  // an empty form means unrecorded, which is not a control.
  const filedNone =
    (chronicList.length > 0 || acuteList.length > 0) &&
    chronicList.every((k) => k === NONE_KEY || !NEURO_KEYS.has(k)) &&
    acuteList.every((k) => k === NONE_KEY || !NEURO_KEYS.has(k)) &&
    (chronicList.includes(NONE_KEY) || acuteList.includes(NONE_KEY));
  return filedNone ? "none" : null;
}

interface ExternalRow {
  source_lineage: string;
  case_ref: string;
  at_seconds: number | null;
  label: string | null;
  label_source: string | null;
  sef95: number | null;
  suppression_ratio: number | null;
  covariates: Record<string, unknown> | null;
}

interface AppEpochRow {
  session_id: string;
  t_offset_seconds: number | null;
  seizure_score: number | null;
  suppression_ratio: number | null;
  spectral_edge_95: number | null;
  depth_index: number | null;
  depth_components: Record<string, unknown> | null;
}

interface SessionRow {
  id: string;
  chronic_conditions: string[] | null;
  acute_pathology: string[] | null;
  clinical_features: string[] | null;
  device_name: string | null;
}

interface EventRow {
  session_id: string;
  kind: string;
  detail: string | null;
  t_offset_seconds: number | null;
  duration_seconds: number | null;
}

function keep(counts: Map<string, number>, caseRef: string): boolean {
  const seen = counts.get(caseRef) ?? 0;
  counts.set(caseRef, seen + 1);
  if (seen < MAX_EPOCHS_PER_CASE) return true;
  return seen % 10 === 0;
}

/** Anaesthetic state a dataset's own event file recorded for one epoch. */
export function datasetStateLabel(
  label: string | null,
  labelSource: string | null,
): DepthStateLabel | null {
  if (labelSource !== "dataset" || typeof label !== "string") return null;
  const l = label.trim().toLowerCase();
  if (l === "awake" || l === "baseline") return "awake";
  if (l === "induction") return "induction";
  if (l === "anaesthetised" || l === "anesthetised" || l === "maintenance") return "anaesthetised";
  if (l === "emergence" || l === "recovery") return "emergence";
  return null;
}

/** Suppression a dataset annotated for one epoch, if it says so explicitly. */
export function datasetSuppressionLabel(
  covariates: Record<string, unknown> | null,
  label: string | null,
): SuppressionLabel | null {
  if (typeof label === "string" && /^(burst[_ -]?suppression|suppressed)$/i.test(label.trim())) {
    return "suppressed";
  }
  const monitorSr = num(covariates?.["monitor_suppression_ratio"] ?? covariates?.["bis_sr"]);
  return monitorSuppressionLabel(monitorSr);
}

/**
 * Suppression status a bedside monitor recorded. The ambiguous band between
 * the two thresholds is returned as `null` so nothing is guessed.
 */
export function monitorSuppressionLabel(sr: number | null): SuppressionLabel | null {
  const pct = asPercent(sr);
  if (pct == null) return null;
  if (pct >= MONITOR_SUPPRESSED_PCT) return "suppressed";
  if (pct <= MONITOR_CLEAR_PCT) return "not_suppressed";
  return null;
}

interface MonitorRow {
  source: string;
  source_lineage: string;
  case_ref: string;
  at_seconds: number | null;
  bis_sr: number | null;
  bis_sef: number | null;
}

interface PairedRow {
  source_lineage: string | null;
  external_ref: string | null;
  at_seconds: number | null;
  bis: number | null;
  bis_sr: number | null;
  app_index: number | null;
  app_sr: number | null;
  features: Record<string, unknown> | null;
}


/**
 * Case key a paired app reading belongs to. Paired refs are
 * `openneuro-ds004541:<case>:<channel>:<t>`, `vitaldb:<case>:<t>` for the
 * monitor-numerics import and `vitaldb:wave:<case>:<t>` for a reading produced
 * by replaying the bedside EEG waveform through the app's own estimator.
 */
export function pairedCaseRef(ref: string | null): string | null {
  if (!ref) return null;
  const parts = ref.split(":");
  if (parts.length < 3) return null;
  if (/^vitaldb/i.test(parts[0] ?? "")) {
    const rest = parts[1] === "wave" ? parts.slice(2) : parts.slice(1);
    return rest[0] ? `vitaldb-${rest[0]}` : null;
  }
  return parts[1] ?? null;
}

export interface PairedScore {
  coebis: number | null;
  suppressionRatio: number | null;
}

/** Replayed app scores per case, ordered by case time for nearest matching. */
export type PairedScoreIndex = Map<string, { at: number; score: PairedScore }[]>;

/**
 * How far a replayed second may sit from a labelled second and still be read as
 * the same moment. The monitor labels are bucketed on a 10 s grid while the
 * replay lands on the waveform's own clock, so an exact-second join would
 * silently discard every VitalDB pairing.
 */
export const PAIRED_MATCH_SECONDS = 5;

/** Nearest replayed score to a labelled second, or null outside tolerance. */
export function pairedScoreAt(
  index: PairedScoreIndex,
  caseRef: string,
  atSeconds: number,
  tolerance = PAIRED_MATCH_SECONDS,
): PairedScore | null {
  const list = index.get(caseRef);
  if (!list?.length) return null;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.at < atSeconds) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [list[lo - 1], list[lo], list[lo + 1]].filter(Boolean) as {
    at: number;
    score: PairedScore;
  }[];
  let best: { at: number; score: PairedScore } | null = null;
  for (const c of candidates) {
    if (Math.abs(c.at - atSeconds) > tolerance) continue;
    if (!best || Math.abs(c.at - atSeconds) < Math.abs(best.at - atSeconds)) best = c;
  }
  return best?.score ?? null;
}


/**
 * The Data API caps a single response at 1,000 rows, so every load here pages
 * explicitly. Without this a large lineage silently truncates and the
 * dashboard reports a fraction of the cases it actually holds.
 */
const PAGE_SIZE = 1000;

async function pageAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < limit; from += PAGE_SIZE) {
    const to = Math.min(from + PAGE_SIZE, limit) - 1;
    const { data, error } = await query(from, to);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < to - from + 1) break;
  }
  return out;
}

/** Anaesthetic state a paired reading carries from its source recording. */
export function pairedStateLabel(state: unknown): DepthStateLabel | null {
  if (typeof state !== "string") return null;
  const s = state.trim().toLowerCase();
  if (s === "awake" || s === "baseline") return "awake";
  if (s === "induction") return "induction";
  if (s === "anaesthetised" || s === "anesthetised" || s === "maintenance") return "anaesthetised";
  if (s === "emergence" || s === "recovery") return "emergence";
  // "sedated" and anything else is deliberately not forced onto the
  // anaesthetised/awake contrast.
  return null;
}

/**
 * Every paired reading in the database, in one pass: the app-side score index
 * used to grade other label tables, plus the labels the paired rows themselves
 * carry (a bedside suppression ratio, or the source recording's own state).
 *
 * This is what makes the grading lineage-agnostic: VitalDB is not the only
 * lineage with a recorded reference, and the non-VitalDB lineages
 * (ds004541 event states, DOSE-I MOAA/S states, Muse cases with a bedside SR)
 * were previously scored but never graded.
 */
async function loadPaired(
  supabase: Client,
): Promise<{ index: PairedScoreIndex; labels: LabelledEpoch[]; scanned: number }> {
  const index: PairedScoreIndex = new Map();
  const rows = await pageAll<PairedRow>(
    (from, to) =>
      supabase
        .from("bis_paired_points")
        .select(
          "source_lineage, external_ref, at_seconds, bis, bis_sr, app_index, app_sr, features",
        )
        .order("id", { ascending: true })
        .range(from, to),
    40000,
  );
  const labels: LabelledEpoch[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const features = (r.features ?? {}) as Record<string, unknown>;
    const featureCase = typeof features["caseRef"] === "string" ? features["caseRef"] : null;
    const caseRef = featureCase ?? pairedCaseRef(r.external_ref);
    const at = Number(r.at_seconds ?? 0);
    const scores: PairedScore = {
      coebis: num(r.app_index),
      suppressionRatio: asPercent(num(r.app_sr)),
    };
    if (caseRef) {
      const list = index.get(caseRef) ?? [];
      list.push({ at, score: scores });
      index.set(caseRef, list);
    }

    const suppression = monitorSuppressionLabel(num(r.bis_sr));
    const state = pairedStateLabel(features["state"]);
    if (!suppression && !state) continue;
    const lineage = r.source_lineage ?? "unlabelled";
    const key = caseRef ?? `${lineage}/unkeyed`;
    if (!keep(counts, key)) continue;
    labels.push({
      lineage,
      caseRef: key,
      atSeconds: at,
      // A recorded reference travelling with the reading: a monitor's own
      // suppression ratio, or the source recording's state annotation.
      labelSource: suppression ? "monitor" : "dataset",
      seizure: null,
      cns: null,
      suppression,
      state,
      scores: {
        coebis: scores.coebis,
        seizureScore: null,
        suppressionRatio: scores.suppressionRatio,
        sef95: null,
      },
    });
  }
  for (const list of index.values()) list.sort((a, b) => a.at - b.at);
  return { index, labels, scanned: rows.length };
}




/** Monitor-recorded suppression labels (e.g. VitalDB bedside BIS SR). */
async function loadMonitorLabels(
  supabase: Client,
  paired: PairedScoreIndex,
): Promise<{ rows: LabelledEpoch[]; scanned: number }> {
  const page = await pageAll<MonitorRow>(
    (from, to) =>
      supabase
        .from("external_reference_points")
        .select("source, source_lineage, case_ref, at_seconds, bis_sr, bis_sef")
        .not("bis_sr", "is", null)
        .order("case_ref", { ascending: true })
        .order("at_seconds", { ascending: true })
        .range(from, to),
    20000,
  );

  const counts = new Map<string, number>();
  const rows: LabelledEpoch[] = [];
  for (const r of page) {
    const suppression = monitorSuppressionLabel(num(r.bis_sr));
    if (!suppression) continue;
    const caseRef = `${r.source_lineage}/${r.case_ref}`;
    if (!keep(counts, caseRef)) continue;
    const at = Number(r.at_seconds ?? 0);
    const scores = pairedScoreAt(paired, r.case_ref, at);
    rows.push({
      lineage: r.source_lineage,
      caseRef,
      atSeconds: at,
      labelSource: "monitor",
      seizure: null,
      cns: null,
      suppression,
      state: null,
      scores: {
        coebis: scores?.coebis ?? null,
        seizureScore: null,
        // The app's own suppression figure when the recording was replayed;
        // never the monitor's own SR, which is the label being graded.
        suppressionRatio: scores?.suppressionRatio ?? null,
        sef95: null,
      },
    });
  }
  return { rows, scanned: page.length };
}

async function loadExternal(
  supabase: Client,
  limit: number,
  paired: PairedScoreIndex,
): Promise<{
  rows: LabelledEpoch[];
  scanned: number;
}> {
  const rows: LabelledEpoch[] = [];
  const counts = new Map<string, number>();
  let scanned = 0;
  for (let from = 0; from < limit; from += PAGE) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select(
        "source_lineage, case_ref, at_seconds, label, label_source, sef95, suppression_ratio, covariates",
      )
      .order("created_at", { ascending: true })
      .range(from, Math.min(from + PAGE, limit) - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as unknown as ExternalRow[];
    scanned += page.length;
    for (const r of page) {
      const covariates = r.covariates ?? null;
      const seizure = datasetSeizureLabel(covariates, r.label, r.label_source);
      const cns = datasetCnsLabel(covariates);
      const state = datasetStateLabel(r.label, r.label_source);
      const suppression = datasetSuppressionLabel(covariates, r.label);
      if (!seizure && !cns && !state && !suppression) continue;
      const caseRef = `${r.source_lineage}/${r.case_ref}`;
      if (!keep(counts, caseRef)) continue;
      const at = Number(r.at_seconds ?? 0);
      const appScores = pairedScoreAt(paired, r.case_ref, at);
      rows.push({
        lineage: r.source_lineage,
        caseRef,
        atSeconds: at,
        labelSource: "dataset",
        seizure,
        cns,
        suppression,
        state,
        scores: {
          coebis: appScores?.coebis ?? null,
          seizureScore: null,
          suppressionRatio: appScores?.suppressionRatio ?? asPercent(num(r.suppression_ratio)),
          sef95: num(r.sef95),
        },
      });
    }
    if (page.length < PAGE) break;
  }

  return { rows, scanned };
}

async function loadApp(supabase: Client, limit: number): Promise<{
  rows: LabelledEpoch[];
  scanned: number;
}> {
  const { data: sessionData, error: sessionError } = await supabase
    .from("eeg_sessions")
    .select("id, chronic_conditions, acute_pathology, clinical_features, device_name")
    .order("started_at", { ascending: false })
    .limit(200);
  if (sessionError) throw new Error(sessionError.message);
  const sessions = (sessionData ?? []) as unknown as SessionRow[];
  if (!sessions.length) return { rows: [], scanned: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const { data: eventData, error: eventError } = await supabase
    .from("eeg_events")
    .select("session_id, kind, detail, t_offset_seconds, duration_seconds")
    .in("session_id", [...byId.keys()])
    .eq("kind", "annotation")
    .limit(2000);
  if (eventError) throw new Error(eventError.message);

  // A session only becomes evidence about seizures once a clinician marked at
  // least one; silence elsewhere is not a negative label.
  const ictalIntervals = new Map<string, { start: number; end: number }[]>();
  for (const e of (eventData ?? []) as unknown as EventRow[]) {
    if (!e.detail || !SEIZURE_ANNOTATION.test(e.detail)) continue;
    const start = Number(e.t_offset_seconds ?? 0);
    const duration = Number(e.duration_seconds ?? 0) || DEFAULT_ANNOTATION_SECONDS;
    ictalIntervals.set(e.session_id, [
      ...(ictalIntervals.get(e.session_id) ?? []),
      { start, end: start + duration },
    ]);
  }

  const { data, error } = await supabase
    .from("eeg_epochs")
    .select(
      "session_id, t_offset_seconds, seizure_score, suppression_ratio, spectral_edge_95, depth_index, depth_components",
    )
    .in("session_id", [...byId.keys()])
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const counts = new Map<string, number>();
  const rows: LabelledEpoch[] = [];
  const epochs = (data ?? []) as unknown as AppEpochRow[];
  for (const r of epochs) {
    const session = byId.get(r.session_id);
    if (!session) continue;
    const cns = caseCnsLabel(
      session.chronic_conditions,
      session.acute_pathology,
      session.clinical_features,
    );
    const marks = ictalIntervals.get(r.session_id);
    const t = Number(r.t_offset_seconds ?? 0);
    const seizure: LabelledEpoch["seizure"] = marks
      ? marks.some((m) => t >= m.start && t < m.end)
        ? "ictal"
        : "interictal"
      : null;
    if (!seizure && !cns) continue;
    const caseRef = `app/${r.session_id}`;
    if (!keep(counts, caseRef)) continue;
    const coebis = num(r.depth_components?.["coebis"]) ?? num(r.depth_index);
    rows.push({
      lineage: `app:${session.device_name ?? "device"}`,
      caseRef,
      atSeconds: t,
      labelSource: seizure ? "clinician" : "clinician",
      seizure,
      cns,
      scores: {
        coebis,
        seizureScore: num(r.seizure_score),
        suppressionRatio: asPercent(num(r.suppression_ratio)),
        sef95: num(r.spectral_edge_95),
      },
    });
  }
  return { rows, scanned: epochs.length };
}

export async function loadPathologyLabelEvaluation(
  supabase: Client,
  limit = 8000,
): Promise<PathologyLabelEvaluation> {
  const paired = await loadPaired(supabase);
  const [external, monitor, app] = await Promise.all([
    loadExternal(supabase, limit, paired.index),
    loadMonitorLabels(supabase, paired.index),
    loadApp(supabase, Math.min(limit, 5000)),
  ]);
  // A case whose reference already arrived through another table must not be
  // counted twice through its paired readings.
  const bare = (ref: string) => ref.slice(ref.indexOf("/") + 1);
  const monitorCases = new Set(monitor.rows.map((r) => bare(r.caseRef)));
  const datasetStateCases = new Set(
    external.rows.filter((r) => r.state != null).map((r) => bare(r.caseRef)),
  );
  const pairedLabels: LabelledEpoch[] = paired.labels
    .map((r) => ({
      ...r,
      suppression: monitorCases.has(r.caseRef) ? null : (r.suppression ?? null),
      state: datasetStateCases.has(r.caseRef) ? null : (r.state ?? null),
    }))
    .filter((r) => r.suppression != null || r.state != null);


  return evaluatePathologyLabels(
    [...external.rows, ...monitor.rows, ...pairedLabels, ...app.rows],
    external.scanned + monitor.scanned + paired.scanned + app.scanned,
  );

}

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
  type LabelledEpoch,
  type PathologyLabelEvaluation,
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

async function loadExternal(supabase: Client, limit: number): Promise<{
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
      if (!seizure && !cns) continue;
      const caseRef = `${r.source_lineage}/${r.case_ref}`;
      if (!keep(counts, caseRef)) continue;
      rows.push({
        lineage: r.source_lineage,
        caseRef,
        atSeconds: Number(r.at_seconds ?? 0),
        labelSource: "dataset",
        seizure,
        cns,
        scores: {
          coebis: null,
          seizureScore: null,
          suppressionRatio: asPercent(num(r.suppression_ratio)),
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
  const [external, app] = await Promise.all([
    loadExternal(supabase, limit),
    loadApp(supabase, Math.min(limit, 5000)),
  ]);
  return evaluatePathologyLabels(
    [...external.rows, ...app.rows],
    external.scanned + app.scanned,
  );
}

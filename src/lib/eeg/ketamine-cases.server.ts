/**
 * Server-only loader for the ketamine signature dashboard.
 *
 * Reads every case the app holds spectra for — imported corpora and the app's
 * own recordings — measures the ketamine spectral pattern from the stored band
 * powers, and attaches whatever independent labels that case carries so the
 * suppression and depth-state grades sit next to the correction.
 *
 * Ketamine exposure is only ever taken from the record (regimen, effect-site
 * entry, clinician marker). A pattern with no declaration is reported as an
 * advisory and moves nothing, exactly as the live correction behaves.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { featuresFromBands, summariseKetamineCases, type KetamineCaseEpoch, type KetamineCaseReport } from "./ketamine-cases";
import { ketamineDeclared } from "./ketamine";
import {
  canonicalCaseKey,
  datasetStateLabel,
  datasetSuppressionLabel,
  monitorSuppressionLabel,
  pairedCaseRef,
  pairedScoreAt,
  type PairedScoreIndex,
} from "./pathology-labels.server";
import { pairedStateLabel } from "./pathology-labels.server";

type Client = SupabaseClient<any, any, any>;

const PAGE_SIZE = 1000;
/** Epochs kept per case, so one long recording cannot dominate the page. */
const MAX_EPOCHS_PER_CASE = 400;

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function asPercent(v: number | null): number | null {
  if (v == null) return null;
  return v > 0 && v <= 1 ? v * 100 : v;
}

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

function keeper(): (caseRef: string) => boolean {
  const counts = new Map<string, number>();
  return (caseRef: string) => {
    const seen = counts.get(caseRef) ?? 0;
    counts.set(caseRef, seen + 1);
    if (seen < MAX_EPOCHS_PER_CASE) return true;
    return seen % 10 === 0;
  };
}

interface PairedRow {
  source_lineage: string | null;
  external_ref: string | null;
  at_seconds: number | null;
  bis_sr: number | null;
  app_index: number | null;
  app_sr: number | null;
  features: Record<string, unknown> | null;
}

/** Replayed COEBIS per case, plus the state / suppression labels those rows carry. */
async function loadPaired(supabase: Client, limit: number): Promise<{
  index: PairedScoreIndex;
  labels: Map<string, { at: number; suppression: ReturnType<typeof monitorSuppressionLabel>; state: ReturnType<typeof pairedStateLabel> }[]>;
}> {
  const rows = await pageAll<PairedRow>(
    (from, to) =>
      supabase
        .from("bis_paired_points")
        .select("source_lineage, external_ref, at_seconds, bis_sr, app_index, app_sr, features")
        .order("id", { ascending: true })
        .range(from, to),
    limit,
  );
  const index: PairedScoreIndex = new Map();
  const labels = new Map<
    string,
    { at: number; suppression: ReturnType<typeof monitorSuppressionLabel>; state: ReturnType<typeof pairedStateLabel> }[]
  >();
  for (const r of rows) {
    const features = (r.features ?? {}) as Record<string, unknown>;
    const featureCase = typeof features["caseRef"] === "string" ? features["caseRef"] : null;
    const caseRef = featureCase ?? pairedCaseRef(r.external_ref);
    if (!caseRef) continue;
    const at = Number(r.at_seconds ?? 0);
    const score = { coebis: num(r.app_index), suppressionRatio: asPercent(num(r.app_sr)) };
    for (const key of new Set([caseRef, canonicalCaseKey(caseRef)])) {
      const list = index.get(key) ?? [];
      list.push({ at, score });
      index.set(key, list);
      const labelList = labels.get(key) ?? [];
      labelList.push({
        at,
        suppression: monitorSuppressionLabel(num(r.bis_sr)),
        state: pairedStateLabel(features["state"]),
      });
      labels.set(key, labelList);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.at - b.at);
  for (const list of labels.values()) list.sort((a, b) => a.at - b.at);
  return { index, labels };
}

function nearestLabel(
  labels: Map<string, { at: number; suppression: any; state: any }[]>,
  caseRef: string,
  at: number,
  tolerance = 5,
): { suppression: any; state: any } | null {
  const list = labels.get(caseRef) ?? labels.get(canonicalCaseKey(caseRef));
  if (!list?.length) return null;
  let best: { at: number; suppression: any; state: any } | null = null;
  for (const row of list) {
    const gap = Math.abs(row.at - at);
    if (gap > tolerance) continue;
    if (!best || gap < Math.abs(best.at - at)) best = row;
  }
  return best ? { suppression: best.suppression, state: best.state } : null;
}

interface ExternalRow {
  source_lineage: string;
  case_ref: string;
  at_seconds: number | null;
  label: string | null;
  label_source: string | null;
  suppression_ratio: number | null;
  bands: Record<string, unknown> | null;
  covariates: Record<string, unknown> | null;
}

async function loadExternal(
  supabase: Client,
  limit: number,
  paired: Awaited<ReturnType<typeof loadPaired>>,
): Promise<{ epochs: KetamineCaseEpoch[]; scanned: number }> {
  const rows = await pageAll<ExternalRow>(
    (from, to) =>
      supabase
        .from("external_spectral_epochs")
        .select(
          "source_lineage, case_ref, at_seconds, label, label_source, suppression_ratio, bands, covariates",
        )
        .order("case_ref", { ascending: true })
        .order("at_seconds", { ascending: true })
        .range(from, to),
      limit,
  );
  const keep = keeper();
  const epochs: KetamineCaseEpoch[] = [];
  for (const r of rows) {
    if (!keep(`${r.source_lineage}/${r.case_ref}`)) continue;
    const covariates = r.covariates ?? null;
    const at = Number(r.at_seconds ?? 0);
    const score = pairedScoreAt(paired.index, r.case_ref, at);
    const pairedLabel = nearestLabel(paired.labels, r.case_ref, at);
    const ce = (covariates?.["ce"] ?? null) as Record<string, unknown> | null;
    epochs.push({
      lineage: r.source_lineage,
      caseRef: r.case_ref,
      atSeconds: at,
      features: featuresFromBands(r.bands),
      coebis: score?.coebis ?? null,
      suppressionPct: score?.suppressionRatio ?? asPercent(num(r.suppression_ratio)),
      suppressionLabel:
        datasetSuppressionLabel(covariates, r.label) ?? pairedLabel?.suppression ?? null,
      stateLabel: datasetStateLabel(r.label, r.label_source) ?? pairedLabel?.state ?? null,
      declared: ketamineDeclared({
        regimen: typeof covariates?.["regimen"] === "string" ? (covariates["regimen"] as string) : null,
        ketamineCe: num(ce?.["ketamine"]),
      }),
    });
  }
  return { epochs, scanned: rows.length };
}

interface SessionRow {
  id: string;
  case_code: string | null;
  regimen: string | null;
  device_name: string | null;
  clinical_features: string[] | null;
}

interface AppEpochRow {
  session_id: string;
  t_offset_seconds: number | null;
  suppression_ratio: number | null;
  depth_index: number | null;
  depth_components: Record<string, unknown> | null;
  bands: Record<string, unknown> | null;
}

interface StateLabelRow {
  session_id: string;
  label: string;
  start_seconds: number | null;
  end_seconds: number | null;
}

/** The app's own recordings, with clinician state labels and marker-declared ketamine. */
async function loadApp(
  supabase: Client,
  limit: number,
): Promise<{ epochs: KetamineCaseEpoch[]; scanned: number }> {
  const { data: sessionData, error: sessionError } = await supabase
    .from("eeg_sessions")
    .select("id, case_code, regimen, device_name, clinical_features")
    .order("started_at", { ascending: false })
    .limit(200);
  if (sessionError) throw new Error(sessionError.message);
  const sessions = (sessionData ?? []) as unknown as SessionRow[];
  if (!sessions.length) return { epochs: [], scanned: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ids = [...byId.keys()];

  const [{ data: markerData }, { data: labelData }] = await Promise.all([
    supabase
      .from("eeg_events")
      .select("session_id, detail")
      .in("session_id", ids)
      .eq("kind", "annotation")
      .limit(2000),
    supabase
      .from("depth_state_labels")
      .select("session_id, label, start_seconds, end_seconds")
      .in("session_id", ids)
      .limit(2000),
  ]);

  const markers = new Map<string, string[]>();
  for (const m of (markerData ?? []) as { session_id: string; detail: string | null }[]) {
    if (!m.detail) continue;
    markers.set(m.session_id, [...(markers.get(m.session_id) ?? []), m.detail]);
  }
  const stateLabels = new Map<string, StateLabelRow[]>();
  for (const l of (labelData ?? []) as unknown as StateLabelRow[]) {
    stateLabels.set(l.session_id, [...(stateLabels.get(l.session_id) ?? []), l]);
  }

  const { data, error } = await supabase
    .from("eeg_epochs")
    .select("session_id, t_offset_seconds, suppression_ratio, depth_index, depth_components, bands")
    .in("session_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as AppEpochRow[];

  const keep = keeper();
  const epochs: KetamineCaseEpoch[] = [];
  for (const r of rows) {
    const session = byId.get(r.session_id);
    if (!session) continue;
    const caseRef = session.case_code || r.session_id.slice(0, 8);
    if (!keep(`app/${caseRef}`)) continue;
    const at = Number(r.t_offset_seconds ?? 0);
    const marked = stateLabels
      .get(r.session_id)
      ?.find((l) => at >= Number(l.start_seconds ?? 0) && at < Number(l.end_seconds ?? 0));
    epochs.push({
      lineage: `app:${session.device_name ?? "device"}`,
      caseRef,
      atSeconds: at,
      features: featuresFromBands(r.bands),
      coebis: num(r.depth_components?.["coebis"]) ?? num(r.depth_index),
      suppressionPct: asPercent(num(r.suppression_ratio)),
      // Local recordings carry no independent suppression reference.
      suppressionLabel: null,
      stateLabel: marked ? pairedStateLabel(marked.label) : null,
      declared: ketamineDeclared({
        regimen: session.regimen,
        markers: [...(markers.get(r.session_id) ?? []), ...(session.clinical_features ?? [])],
      }),
    });
  }
  return { epochs, scanned: rows.length };
}

/** Per-case ketamine signatures with suppression and depth-state grades. */
export async function loadKetamineCases(
  supabase: Client,
  limit = 40000,
): Promise<KetamineCaseReport> {
  const paired = await loadPaired(supabase, limit);
  const [external, app] = await Promise.all([
    loadExternal(supabase, limit, paired),
    loadApp(supabase, 5000),
  ]);
  return summariseKetamineCases(
    [...external.epochs, ...app.epochs],
    external.scanned + app.scanned,
  );
}

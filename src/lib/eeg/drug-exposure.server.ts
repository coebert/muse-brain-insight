/**
 * Server-only loader for the drug exposure dashboard.
 *
 * Same corpus as the ketamine page — imported spectral epochs plus the app's
 * own recordings — but every recorded agent is read, not just ketamine, and the
 * independent suppression / depth-state labels travel with each epoch so the
 * cohorts can be graded rather than merely described.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { declaredDrugs } from "./drug-signatures";
import { summariseDrugExposure, type DrugExposureEpoch, type DrugExposureReport } from "./drug-exposure";
import { featuresFromBands } from "./ketamine-cases";
import {
  canonicalCaseKey,
  datasetStateLabel,
  datasetSuppressionLabel,
  monitorSuppressionLabel,
  pairedCaseRef,
  pairedScoreAt,
  pairedStateLabel,
  type PairedScoreIndex,
} from "./pathology-labels.server";

type Client = SupabaseClient<any, any, any>;

const PAGE_SIZE = 1000;
/** Epochs kept per case, so one long recording cannot dominate the page. */
const MAX_EPOCHS_PER_CASE = 150;

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

type LabelRow = {
  at: number;
  suppression: ReturnType<typeof monitorSuppressionLabel>;
  state: ReturnType<typeof pairedStateLabel>;
};

interface PairedRow {
  external_ref: string | null;
  at_seconds: number | null;
  bis_sr: number | null;
  app_index: number | null;
  app_sr: number | null;
  features: Record<string, unknown> | null;
}

/** Replayed COEBIS per case, plus the labels those paired rows carry. */
async function loadPaired(
  supabase: Client,
  limit: number,
): Promise<{ index: PairedScoreIndex; labels: Map<string, LabelRow[]> }> {
  const rows = await pageAll<PairedRow>(
    (from, to) =>
      supabase
        .from("bis_paired_points")
        .select("external_ref, at_seconds, bis, bis_sr, app_index, app_sr, features")
        .order("id", { ascending: true })
        .range(from, to),
    limit,
  );
  const index: PairedScoreIndex = new Map();
  const labels = new Map<string, LabelRow[]>();
  for (const r of rows) {
    const features = (r.features ?? {}) as Record<string, unknown>;
    const featureCase = typeof features["caseRef"] === "string" ? features["caseRef"] : null;
    const caseRef = featureCase ?? pairedCaseRef(r.external_ref);
    if (!caseRef) continue;
    const at = Number(r.at_seconds ?? 0);
    const score = {
      coebis: num(r.app_index),
      suppressionRatio: asPercent(num(r.app_sr)),
      bis: num(r.bis),
    };
    for (const key of new Set([caseRef, canonicalCaseKey(caseRef)])) {
      index.set(key, [...(index.get(key) ?? []), { at, score }]);
      labels.set(key, [
        ...(labels.get(key) ?? []),
        {
          at,
          suppression: monitorSuppressionLabel(num(r.bis_sr)),
          state: pairedStateLabel(features["state"]),
        },
      ]);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.at - b.at);
  for (const list of labels.values()) list.sort((a, b) => a.at - b.at);
  return { index, labels };
}

function nearestLabel(
  labels: Map<string, LabelRow[]>,
  caseRef: string,
  at: number,
  tolerance = 5,
): LabelRow | null {
  const list = labels.get(caseRef) ?? labels.get(canonicalCaseKey(caseRef));
  if (!list?.length) return null;
  let best: LabelRow | null = null;
  for (const row of list) {
    const gap = Math.abs(row.at - at);
    if (gap > tolerance) continue;
    if (!best || gap < Math.abs(best.at - at)) best = row;
  }
  return best;
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

/** Lineage names, from the small intake and reference tables. */
async function knownLineages(supabase: Client): Promise<string[]> {
  const [{ data: intake }, { data: reference }] = await Promise.all([
    supabase.from("dataset_intake_files").select("lineage").limit(2000),
    supabase.from("external_reference_points").select("source_lineage").limit(2000),
  ]);
  const set = new Set<string>();
  for (const r of (intake ?? []) as { lineage: string | null }[]) if (r.lineage) set.add(r.lineage);
  for (const r of (reference ?? []) as { source_lineage: string | null }[]) {
    if (r.source_lineage) set.add(r.source_lineage);
  }
  return [...set];
}

const SELECT_COLUMNS =
  "source_lineage, case_ref, at_seconds, label, label_source, suppression_ratio, bands, covariates";

/** Case keys for a lineage, walked one row at a time so nothing large is read. */
async function lineageCases(supabase: Client, lineage: string, maxCases = 400): Promise<string[]> {
  const out: string[] = [];
  let after = "";
  for (let i = 0; i < maxCases; i += 1) {
    const { data, error } = await supabase
      .from("external_spectral_epochs")
      .select("case_ref")
      .eq("source_lineage", lineage)
      .gt("case_ref", after)
      .order("case_ref", { ascending: true })
      .limit(1);
    if (error) throw new Error(error.message);
    const ref = ((data ?? []) as { case_ref: string }[])[0]?.case_ref;
    if (!ref) break;
    out.push(ref);
    after = ref;
  }
  return out;
}

/** Run tasks with a bounded number in flight. */
async function pooled<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    }),
  );
  return out;
}

/**
 * Read case by case rather than straight off the table.
 *
 * A single ordered scan fills its budget with the first corpus it meets and the
 * remaining cases never appear at all, so every case is sampled in its own
 * right: the opening of the recording and its tail, which is where induction
 * and emergence — and therefore the awake labels — live.
 */
async function loadExternal(
  supabase: Client,
  limit: number,
  paired: Awaited<ReturnType<typeof loadPaired>>,
): Promise<{ epochs: DrugExposureEpoch[]; scanned: number }> {
  const lineages = await knownLineages(supabase);
  const cases = (
    await Promise.all(
      lineages.map(async (lineage) =>
        (await lineageCases(supabase, lineage)).map((caseRef) => ({ lineage, caseRef })),
      ),
    )
  ).flat();
  const perCase = Math.max(
    80,
    Math.min(MAX_EPOCHS_PER_CASE, Math.floor(limit / Math.max(1, cases.length))),
  );
  const head = Math.ceil(perCase * 0.6);
  const tail = perCase - head;

  /** Labelled epochs pulled on top of the profile slice, so grades have data. */
  const labelSlice = Math.max(perCase, 200);

  const slices = await pooled(cases, 8, async ({ lineage, caseRef }) => {
    const base = () =>
      supabase
        .from("external_spectral_epochs")
        .select(SELECT_COLUMNS)
        .eq("source_lineage", lineage)
        .eq("case_ref", caseRef);
    const [
      { data: first, error: firstError },
      { data: last, error: lastError },
      { data: labelled, error: labelError },
    ] = await Promise.all([
      base().order("at_seconds", { ascending: true }).limit(head),
      base().order("at_seconds", { ascending: false }).limit(tail),
      base().not("label", "is", null).order("at_seconds", { ascending: true }).limit(labelSlice),
    ]);
    if (firstError) throw new Error(firstError.message);
    if (lastError) throw new Error(lastError.message);
    if (labelError) throw new Error(labelError.message);
    const seen = new Set<number>();
    const merged: { row: ExternalRow; labelSlice: boolean }[] = [];
    const add = (rows: ExternalRow[], fromLabelSlice: boolean) => {
      for (const row of rows) {
        const at = Number(row.at_seconds ?? 0);
        if (seen.has(at)) continue;
        seen.add(at);
        merged.push({ row, labelSlice: fromLabelSlice });
      }
    };
    add((first ?? []) as ExternalRow[], false);
    add((last ?? []) as ExternalRow[], false);
    add((labelled ?? []) as ExternalRow[], true);
    return merged;
  });
  const rows = slices.flat();

  const epochs: DrugExposureEpoch[] = [];
  for (const { row: r, labelSlice: fromLabelSlice } of rows) {
    const covariates = r.covariates ?? {};

    const at = Number(r.at_seconds ?? 0);
    const score = pairedScoreAt(paired.index, r.case_ref, at);
    const pairedLabel = nearestLabel(paired.labels, r.case_ref, at);
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
      labelSlice: fromLabelSlice,
      declared: declaredDrugs({
        regimen: typeof covariates["regimen"] === "string" ? (covariates["regimen"] as string) : null,
        notes: [
          typeof covariates["drugs"] === "string" ? (covariates["drugs"] as string) : null,
          typeof covariates["anaesthetic"] === "string" ? (covariates["anaesthetic"] as string) : null,
          typeof covariates["notes"] === "string" ? (covariates["notes"] as string) : null,
        ],
        ce: (covariates["ce"] ?? null) as Record<string, unknown> | null,
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

/** The app's own recordings, with clinician state labels and marker-declared agents. */
async function loadApp(
  supabase: Client,
  limit: number,
): Promise<{ epochs: DrugExposureEpoch[]; scanned: number }> {
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
  const epochs: DrugExposureEpoch[] = [];
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
      declared: declaredDrugs({
        regimen: session.regimen,
        notes: [...(markers.get(r.session_id) ?? []), ...(session.clinical_features ?? [])],
      }),
    });
  }
  return { epochs, scanned: rows.length };
}

/** Per-case drug exposure with COEBIS and suppression grades. */
export async function loadDrugExposure(supabase: Client, limit = 30000): Promise<DrugExposureReport> {
  const paired = await loadPaired(supabase, 10000);
  const [external, app] = await Promise.all([
    loadExternal(supabase, limit, paired),
    loadApp(supabase, 5000),
  ]);
  return summariseDrugExposure(
    [...external.epochs, ...app.epochs],
    external.scanned + app.scanned,
  );
}

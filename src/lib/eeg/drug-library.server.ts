/**
 * Server-only scanner behind the drug library page.
 *
 * Reads every case the app holds spectra for — imported corpora and the app's
 * own recordings — and records which registered agents each case declares.
 * Declarations come from the regimen text, the effect-site entries and
 * clinician markers, exactly as the live depth stage reads them, so the page
 * reports the coverage the correction would actually get.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { declaredDrugs } from "./drug-signatures";
import { summariseDrugLibrary, type DrugLibraryEpoch, type DrugLibraryReport } from "./drug-library";
import { featuresFromBands } from "./ketamine-cases";

type Client = SupabaseClient<any, any, any>;

const PAGE_SIZE = 1000;
/** Epochs kept per case, so one long recording cannot dominate the scan. */
const MAX_EPOCHS_PER_CASE = 120;

async function pageAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  limit: number,
): Promise<T[]> {
  // The spectral corpus runs to tens of thousands of rows, so pages are fetched
  // in concurrent batches; a strictly serial walk makes the page feel hung.
  const CONCURRENCY = 8;
  const out: T[] = [];
  for (let base = 0; base < limit; base += PAGE_SIZE * CONCURRENCY) {
    const starts: number[] = [];
    for (let i = 0; i < CONCURRENCY; i += 1) {
      const from = base + i * PAGE_SIZE;
      if (from < limit) starts.push(from);
    }
    const pages = await Promise.all(
      starts.map(async (from) => {
        const to = Math.min(from + PAGE_SIZE, limit) - 1;
        const { data, error } = await query(from, to);
        if (error) throw new Error(error.message);
        return (data ?? []) as T[];
      }),
    );
    let short = false;
    for (const page of pages) {
      out.push(...page);
      if (page.length < PAGE_SIZE) short = true;
    }
    if (short) break;
  }
  return out;
}

function keeper(): (caseRef: string) => boolean {
  const counts = new Map<string, number>();
  return (caseRef: string) => {
    const seen = counts.get(caseRef) ?? 0;
    counts.set(caseRef, seen + 1);
    return seen < MAX_EPOCHS_PER_CASE;
  };
}

interface ExternalRow {
  source_lineage: string;
  case_ref: string;
  bands: Record<string, unknown> | null;
  covariates: Record<string, unknown> | null;
}

/**
 * Lineage names, taken from the small intake and reference tables rather than
 * from a distinct scan of the 60k-row spectral table.
 */
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

/**
 * Spectral epochs, read per lineage so no single large corpus crowds the
 * others out, and capped per case so one long recording cannot dominate.
 */
async function loadExternal(supabase: Client, perLineage: number): Promise<{
  epochs: DrugLibraryEpoch[];
  scanned: number;
}> {
  const lineages = await knownLineages(supabase);
  const perLineageRows = await Promise.all(
    lineages.map((lineage) =>
      pageAll<ExternalRow>(
        (from, to) =>
          supabase
            .from("external_spectral_epochs")
            .select("source_lineage, case_ref, bands, covariates")
            .eq("source_lineage", lineage)
            .order("case_ref", { ascending: true })
            .order("at_seconds", { ascending: true })
            .range(from, to),
        perLineage,
      ),
    ),
  );
  const rows = perLineageRows.flat();
  const keep = keeper();
  const epochs: DrugLibraryEpoch[] = [];
  for (const r of rows) {
    if (!keep(`${r.source_lineage}/${r.case_ref}`)) continue;
    const covariates = r.covariates ?? {};
    const regimen = typeof covariates["regimen"] === "string" ? (covariates["regimen"] as string) : null;
    const notes = [
      typeof covariates["drugs"] === "string" ? (covariates["drugs"] as string) : null,
      typeof covariates["anaesthetic"] === "string" ? (covariates["anaesthetic"] as string) : null,
      typeof covariates["notes"] === "string" ? (covariates["notes"] as string) : null,
    ];
    epochs.push({
      lineage: r.source_lineage,
      caseRef: r.case_ref,
      features: featuresFromBands(r.bands),
      declared: declaredDrugs({
        regimen,
        notes,
        ce: (covariates["ce"] ?? null) as Record<string, unknown> | null,
      }),
    });
  }
  return { epochs, scanned: rows.length };
}


interface ReferenceRow {
  source_lineage: string;
  case_ref: string;
  regimen: string | null;
  ce: Record<string, unknown> | null;
}

/**
 * Paired reference readings carry a regimen even where no spectrum was stored,
 * so a case can be covered for a drug without contributing spectral epochs.
 */
async function loadReference(supabase: Client, limit: number): Promise<{
  epochs: DrugLibraryEpoch[];
  scanned: number;
}> {
  const rows = await pageAll<ReferenceRow>(
    (from, to) =>
      supabase
        .from("external_reference_points")
        .select("source_lineage, case_ref, regimen, ce")
        .order("case_ref", { ascending: true })
        .range(from, to),
    limit,
  );
  const seen = new Set<string>();
  const epochs: DrugLibraryEpoch[] = [];
  for (const r of rows) {
    const key = `${r.source_lineage}/${r.case_ref}`;
    if (seen.has(key)) continue;
    seen.add(key);
    epochs.push({
      lineage: r.source_lineage,
      caseRef: r.case_ref,
      // No spectrum on these rows; coverage only, never a pattern score.
      features: { betaFraction: null, gammaFraction: null, alphaFraction: null, slowFraction: null },
      declared: declaredDrugs({ regimen: r.regimen, ce: r.ce }),
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
  notes: string | null;
}

interface AppEpochRow {
  session_id: string;
  bands: Record<string, unknown> | null;
}

async function loadApp(supabase: Client, limit: number): Promise<{
  epochs: DrugLibraryEpoch[];
  scanned: number;
}> {
  const { data: sessionData, error: sessionError } = await supabase
    .from("eeg_sessions")
    .select("id, case_code, regimen, device_name, clinical_features, notes")
    .order("started_at", { ascending: false })
    .limit(200);
  if (sessionError) throw new Error(sessionError.message);
  const sessions = (sessionData ?? []) as unknown as SessionRow[];
  if (!sessions.length) return { epochs: [], scanned: 0 };
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const ids = [...byId.keys()];

  const { data: markerData } = await supabase
    .from("eeg_events")
    .select("session_id, detail")
    .in("session_id", ids)
    .eq("kind", "annotation")
    .limit(2000);
  const markers = new Map<string, string[]>();
  for (const m of (markerData ?? []) as { session_id: string; detail: string | null }[]) {
    if (!m.detail) continue;
    markers.set(m.session_id, [...(markers.get(m.session_id) ?? []), m.detail]);
  }

  const { data, error } = await supabase
    .from("eeg_epochs")
    .select("session_id, bands")
    .in("session_id", ids)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as unknown as AppEpochRow[];

  const keep = keeper();
  const epochs: DrugLibraryEpoch[] = [];
  for (const r of rows) {
    const session = byId.get(r.session_id);
    if (!session) continue;
    const caseRef = session.case_code || r.session_id.slice(0, 8);
    if (!keep(`app/${caseRef}`)) continue;
    epochs.push({
      lineage: `app:${session.device_name ?? "device"}`,
      caseRef,
      features: featuresFromBands(r.bands),
      declared: declaredDrugs({
        regimen: session.regimen,
        notes: [session.notes, ...(markers.get(r.session_id) ?? []), ...(session.clinical_features ?? [])],
      }),
    });
  }
  return { epochs, scanned: rows.length };
}

/** Per-agent EEG signature, source lineages and case coverage. */
export async function loadDrugLibrary(supabase: Client, perLineage = 6000): Promise<DrugLibraryReport> {
  const [external, reference, app] = await Promise.all([
    loadExternal(supabase, perLineage),
    loadReference(supabase, 10000),
    loadApp(supabase, 4000),
  ]);
  return summariseDrugLibrary(
    [...external.epochs, ...reference.epochs, ...app.epochs],
    external.scanned + reference.scanned + app.scanned,
  );
}

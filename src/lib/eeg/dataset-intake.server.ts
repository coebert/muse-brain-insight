/**
 * Server-only execution of the automated public-dataset intake: discover,
 * download, parse, harmonise, store, and record provenance. Nothing here is
 * reachable from the browser bundle, and every fetched byte is licence-gated by
 * `checkEligibility` before a request is made.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  describeHarmonization,
  harmonizeEpochs,
  inferReference,
  type HarmonizationRecord,
} from "./harmonization";
import {
  buildProvenance,
  checkEligibility,
  findSource,
  INTAKE_SOURCES,
  parseRecordsIndex,
  parseZenodoIndex,
  planIntake,
  type DiscoveredFile,
  type IntakeFileResult,
  type IntakeRunResult,
  type IntakeSource,
  type IntakeSourceResult,
  type PlannedFile,
} from "./dataset-intake";
import {
  deriveEpochsFromRaw,
  parsePhysionetPowerCsv,
  parsePhysionetRawCsv,
  toImportRows,
  type PhysionetEpoch,
  type PhysionetImportRow,
} from "./physionet";
import { epochsFromRecording, parseSedationIcuCsv, toSedationIcuRows } from "./sedation-icu";
import { importPhysionetEpochs } from "./physionet.server";

type Client = SupabaseClient<any, any, any>;

const FETCH_TIMEOUT_MS = 45_000;

async function fetchText(url: string, limitBytes: number): Promise<{ text: string; bytes: number }> {
  const res = await fetch(url, {
    headers: { accept: "text/plain,text/csv,application/json;q=0.8,*/*;q=0.5" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limitBytes) {
    throw new Error(`file is ${Math.round(declared / 1e6)} MB, over the per-file cap`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > limitBytes) throw new Error("downloaded file exceeded the per-file cap");
  return { text: new TextDecoder().decode(buf), bytes: buf.byteLength };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** List the files a source currently publishes, without downloading any. */
export async function discoverFiles(source: IntakeSource): Promise<DiscoveredFile[]> {
  const listing = source.listing;
  if (listing.type === "manifest") return listing.files.map((f) => ({ ...f, bytes: null }));
  if (listing.type === "records-file") {
    const { text } = await fetchText(listing.url, 4_000_000);
    return parseRecordsIndex(text, listing.url);
  }
  const { text } = await fetchText(listing.recordUrl, 8_000_000);
  return parseZenodoIndex(JSON.parse(text));
}

/* -------------------------------------------------------------- parsing --- */

function rowsForFile(
  source: IntakeSource,
  file: PlannedFile,
  text: string,
): { rows: PhysionetImportRow[]; harmonization: HarmonizationRecord | null } {
  const epochs: (PhysionetEpoch & { harmonization?: HarmonizationRecord })[] = [];
  let record: HarmonizationRecord | null = null;

  const harmonise = (batch: PhysionetEpoch[], channel: string | null, sampleRate: number | null) => {
    const inferred = inferReference(channel);
    const out = harmonizeEpochs(batch, {
      ...source.montage,
      channel: channel ?? source.montage.channel,
      sampleRateHz: sampleRate ?? source.montage.sampleRateHz,
      ...(inferred !== "unknown" ? { reference: inferred } : {}),
    });
    if (out[0]) record = out[0].harmonization;
    epochs.push(...out);
  };

  if (source.kind === "physionet-power") {
    const parsed = parsePhysionetPowerCsv(text, { caseRef: file.caseRef });
    harmonise(parsed, parsed[0]?.channel ?? null, null);
  } else if (source.kind === "physionet-raw") {
    const rec = parsePhysionetRawCsv(text, source.fallbackSampleRate);
    rec.signals.forEach((signal, i) => {
      const channel = rec.channels[i] ?? null;
      harmonise(
        deriveEpochsFromRaw(signal, rec.sampleRate, { caseRef: file.caseRef, channel }),
        channel,
        rec.sampleRate,
      );
    });
  } else {
    const dataset = source.kind === "dose1" ? "dose1" : "icare";
    const rec = parseSedationIcuCsv(text, source.fallbackSampleRate);
    rec.channels.forEach((channel, i) => {
      harmonise(
        epochsFromRecording(rec, i, { dataset, caseRef: file.caseRef, channel }),
        channel,
        rec.sampleRate,
      );
    });
  }

  if (!epochs.length) throw new Error("no usable epochs were derived");

  const meta = { datasetVersion: source.datasetVersion };
  const rows =
    source.kind === "dose1" || source.kind === "icare"
      ? toSedationIcuRows(source.kind === "dose1" ? "dose1" : "icare", epochs, meta)
      : toImportRows(source.kind === "physionet-raw" ? "gaba" : "power", epochs, meta);
  return { rows, harmonization: record };
}

/* --------------------------------------------------------------- run --- */

async function alreadyIngested(supabase: Client, sourceId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("dataset_intake_files")
    .select("file_url, file_name")
    .eq("source_id", sourceId)
    .eq("status", "ingested")
    .limit(5000);
  const set = new Set<string>();
  for (const r of (data ?? []) as { file_url: string; file_name: string }[]) {
    set.add(r.file_url);
    set.add(r.file_name);
  }
  return set;
}

export interface IntakeRunOptions {
  sourceIds?: string[];
  maxFilesPerSource?: number;
  /** Discover and plan only; never download or store. */
  dryRun?: boolean;
}

export async function runDatasetIntake(
  supabase: Client,
  userId: string,
  options: IntakeRunOptions = {},
): Promise<IntakeRunResult> {
  const startedAt = new Date().toISOString();
  const runId = crypto.randomUUID();
  const dryRun = options.dryRun === true;
  const sources = (options.sourceIds?.length
    ? options.sourceIds.map((id) => findSource(id)).filter((s): s is IntakeSource => !!s)
    : INTAKE_SOURCES
  ).slice(0, 8);

  const results: IntakeSourceResult[] = [];

  for (const source of sources) {
    const gate = checkEligibility(source);
    const base: IntakeSourceResult = {
      sourceId: source.id,
      label: source.label,
      lineage: source.lineage,
      licence: source.licence,
      access: source.access,
      eligible: gate.eligible,
      reason: gate.reason,
      discovered: 0,
      attempted: 0,
      ingested: 0,
      epochsInserted: 0,
      files: [],
    };

    let discovered: DiscoveredFile[] = [];
    try {
      discovered = await discoverFiles(source);
    } catch (e) {
      base.reason = `Could not read the published index: ${e instanceof Error ? e.message : String(e)}`;
      results.push(base);
      continue;
    }

    const seen = gate.eligible && !dryRun ? await alreadyIngested(supabase, source.id) : new Set<string>();
    const plan = planIntake(source, discovered, seen, options.maxFilesPerSource ?? source.maxFilesPerRun);
    base.discovered = plan.discovered;
    if (!plan.eligible || dryRun) {
      base.files = plan.files.map((f) => ({
        file: f.name,
        url: f.url,
        status: "skipped" as const,
        epochs: 0,
        inserted: 0,
        detail: plan.eligible ? "planned (dry run)" : plan.reason,
        provenance: null,
      }));
      results.push(base);
      continue;
    }

    for (const file of plan.files) {
      base.attempted++;
      const outcome: IntakeFileResult = {
        file: file.name,
        url: file.url,
        status: "failed",
        epochs: 0,
        inserted: 0,
        detail: "",
        provenance: null,
      };
      try {
        const { text, bytes } = await fetchText(file.url, source.maxBytesPerFile);
        const digest = await sha256Hex(text);
        const { rows, harmonization } = rowsForFile(source, file, text);
        const withHarmonisation = rows.map((r) => ({
          ...r,
          ...(harmonization ? { harmonization } : {}),
        }));
        const stored = await importPhysionetEpochs(supabase, userId, withHarmonisation);
        outcome.status = "ingested";
        outcome.epochs = rows.length;
        outcome.inserted = stored.inserted;
        outcome.detail = stored.skipped
          ? `${stored.inserted} new epochs, ${stored.skipped} already held`
          : `${stored.inserted} new epochs`;
        outcome.provenance = buildProvenance(
          source,
          { name: file.name, url: file.url, bytes, digest },
          harmonization
            ? { version: harmonization.version, summary: describeHarmonization(harmonization) }
            : null,
        );
        base.ingested++;
        base.epochsInserted += stored.inserted;
      } catch (e) {
        outcome.detail = e instanceof Error ? e.message : String(e);
      }

      await supabase.from("dataset_intake_files").insert({
        user_id: userId,
        run_id: runId,
        source_id: source.id,
        lineage: source.lineage,
        file_name: file.name,
        file_url: file.url,
        status: outcome.status,
        epochs: outcome.epochs,
        inserted: outcome.inserted,
        detail: outcome.detail,
        licence: source.licence,
        licence_url: source.licenceUrl,
        dataset_version: source.datasetVersion,
        content_digest: outcome.provenance?.digest ?? null,
        bytes: outcome.provenance?.bytes ?? null,
        harmonization_version: outcome.provenance?.harmonizationVersion ?? null,
        provenance: (outcome.provenance ?? {}) as never,
      } as never);

      base.files.push(outcome);
    }

    results.push(base);
  }

  const finishedAt = new Date().toISOString();
  if (!dryRun) {
    await supabase.from("dataset_intake_runs").insert({
      id: runId,
      user_id: userId,
      started_at: startedAt,
      finished_at: finishedAt,
      sources_scanned: results.length,
      files_ingested: results.reduce((a, r) => a + r.ingested, 0),
      epochs_inserted: results.reduce((a, r) => a + r.epochsInserted, 0),
      summary: results as never,
    } as never);
  }

  return { runId, startedAt, finishedAt, dryRun, sources: results };
}

export interface IntakeHistoryEntry {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  sourcesScanned: number;
  filesIngested: number;
  epochsInserted: number;
}

export interface IntakeProvenanceEntry {
  sourceId: string;
  lineage: string;
  licence: string;
  licenceUrl: string | null;
  files: number;
  epochs: number;
  lastFetchedAt: string | null;
  harmonizationVersions: string[];
}

export async function loadIntakeHistory(supabase: Client): Promise<{
  runs: IntakeHistoryEntry[];
  provenance: IntakeProvenanceEntry[];
}> {
  const [{ data: runRows }, { data: fileRows }] = await Promise.all([
    supabase
      .from("dataset_intake_runs")
      .select("id, started_at, finished_at, sources_scanned, files_ingested, epochs_inserted")
      .order("started_at", { ascending: false })
      .limit(20),
    supabase
      .from("dataset_intake_files")
      .select(
        "source_id, lineage, licence, licence_url, status, epochs, inserted, harmonization_version, created_at",
      )
      .eq("status", "ingested")
      .limit(5000),
  ]);

  const groups = new Map<string, IntakeProvenanceEntry & { versions: Set<string> }>();
  for (const r of (fileRows ?? []) as {
    source_id: string;
    lineage: string;
    licence: string | null;
    licence_url: string | null;
    epochs: number | null;
    inserted: number | null;
    harmonization_version: string | null;
    created_at: string | null;
  }[]) {
    let g = groups.get(r.source_id);
    if (!g) {
      g = {
        sourceId: r.source_id,
        lineage: r.lineage,
        licence: r.licence ?? "unspecified",
        licenceUrl: r.licence_url,
        files: 0,
        epochs: 0,
        lastFetchedAt: null,
        harmonizationVersions: [],
        versions: new Set<string>(),
      };
      groups.set(r.source_id, g);
    }
    g.files++;
    g.epochs += r.inserted ?? 0;
    if (r.harmonization_version) g.versions.add(r.harmonization_version);
    if (r.created_at && (!g.lastFetchedAt || r.created_at > g.lastFetchedAt)) {
      g.lastFetchedAt = r.created_at;
    }
  }

  return {
    runs: ((runRows ?? []) as {
      id: string;
      started_at: string;
      finished_at: string | null;
      sources_scanned: number | null;
      files_ingested: number | null;
      epochs_inserted: number | null;
    }[]).map((r) => ({
      runId: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      sourcesScanned: r.sources_scanned ?? 0,
      filesIngested: r.files_ingested ?? 0,
      epochsInserted: r.epochs_inserted ?? 0,
    })),
    provenance: [...groups.values()]
      .map(({ versions, ...g }) => ({ ...g, harmonizationVersions: [...versions].sort() }))
      .sort((a, b) => b.epochs - a.epochs),
  };
}

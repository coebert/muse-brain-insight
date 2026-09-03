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
  CREDENTIAL_REALMS,
  type CredentialRealm,
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
import { dose1Covariates, parseDose1PeegCsv } from "./dose1-peeg";
import { epochsFromRecording, parseSedationIcuCsv, toSedationIcuRows } from "./sedation-icu";
import { importPhysionetEpochs } from "./physionet.server";
import { chbRows, chbSubject, chbSummaryUrl, parseChbRecording, parseChbSummary, type ChbSeizure } from "./chbmit";

type Client = SupabaseClient<any, any, any>;

const FETCH_TIMEOUT_MS = 45_000;

/** Basic-auth header per credential realm, built from the operator's stored login. */
export type AuthHeaders = Partial<Record<CredentialRealm, string>>;

/**
 * Read the configured logins. Credentials live only in backend environment
 * secrets and are never returned to the browser — only the realm name is.
 */
export function resolveCredentials(): { realms: CredentialRealm[]; headers: AuthHeaders } {
  const realms: CredentialRealm[] = [];
  const headers: AuthHeaders = {};
  for (const realm of Object.keys(CREDENTIAL_REALMS) as CredentialRealm[]) {
    const spec = CREDENTIAL_REALMS[realm];
    const user = process.env[spec.envUser];
    const pass = process.env[spec.envPassword];
    if (!user || !pass) continue;
    realms.push(realm);
    headers[realm] = `Basic ${btoa(`${user}:${pass}`)}`;
  }
  return { realms, headers };
}

/** Only send a credential to the source that owns it. */
function authFor(source: IntakeSource, headers: AuthHeaders): string | undefined {
  return source.credentialRealm ? headers[source.credentialRealm] : undefined;
}

function withAuth(base: Record<string, string>, auth?: string): Record<string, string> {
  return auth ? { ...base, authorization: auth } : base;
}

async function fetchText(
  url: string,
  limitBytes: number,
  auth?: string,
): Promise<{ text: string; bytes: number }> {
  const res = await fetch(url, {
    headers: withAuth({ accept: "text/plain,text/csv,application/json;q=0.8,*/*;q=0.5" }, auth),
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

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchBytes(
  url: string,
  limitBytes: number,
  timeoutMs = FETCH_TIMEOUT_MS * 4,
  auth?: string,
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: withAuth({ accept: "application/zip,application/octet-stream;q=0.8,*/*;q=0.5" }, auth),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > limitBytes) throw new Error("archive exceeded the per-archive cap");
  return buf;
}

/**
 * Expand a published zip in memory into one discovered file per member. The
 * member URL keeps the archive URL plus a fragment, so provenance still points
 * at the exact published artefact and re-runs de-duplicate per recording.
 */
async function expandArchive(
  source: IntakeSource,
  archive: DiscoveredFile,
  cache: Map<string, string>,
  auth?: string,
): Promise<DiscoveredFile[]> {
  const { unzipSync } = await import("fflate");
  const bytes = await fetchBytes(
    archive.url,
    source.maxArchiveBytes ?? 80_000_000,
    undefined,
    auth,
  );
  const entries = unzipSync(bytes);
  const decoder = new TextDecoder();
  const out: DiscoveredFile[] = [];
  for (const [member, content] of Object.entries(entries)) {
    if (!content.length || !source.filePattern.test(member)) continue;
    const url = `${archive.url}#${member}`;
    cache.set(url, decoder.decode(content));
    out.push({ name: member, url, bytes: content.byteLength });
  }
  return out;
}

/**
 * List the files a source currently publishes. Nothing is downloaded except a
 * published index — or, for archive-packaged records, the single archive whose
 * members are the per-recording files.
 */
export async function discoverFiles(
  source: IntakeSource,
  cache?: Map<string, string>,
  auth?: string,
): Promise<DiscoveredFile[]> {
  const listing = source.listing;
  let files: DiscoveredFile[];
  if (listing.type === "manifest") {
    files = listing.files.map((f) => ({ ...f, bytes: null }));
  } else if (listing.type === "records-file") {
    const { text } = await fetchText(listing.url, 4_000_000, auth);
    files = parseRecordsIndex(text, listing.url);
  } else {
    const { text } = await fetchText(listing.recordUrl, 8_000_000, auth);
    files = parseZenodoIndex(JSON.parse(text));
  }

  if (!source.archivePattern || !cache) return files;

  const expanded: DiscoveredFile[] = [];
  for (const f of files) {
    if (!source.archivePattern.test(f.name)) continue;
    expanded.push(...(await expandArchive(source, f, cache, auth)));
  }
  return expanded.length ? expanded : files.filter((f) => source.filePattern.test(f.name));
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

  let covariates: Record<string, string | number | null> = {};

  if (source.kind === "dose1-peeg") {
    const parsed = parseDose1PeegCsv(text, {
      caseRef: file.caseRef,
      channel: source.montage.channel,
    });
    covariates = dose1Covariates(parsed);
    harmonise(parsed.epochs, source.montage.channel, null);
  } else if (source.kind === "physionet-power") {
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

  const meta = { datasetVersion: source.datasetVersion, covariates };
  const isSedationIcu =
    source.kind === "dose1" || source.kind === "dose1-peeg" || source.kind === "icare";
  const rows = isSedationIcu
    ? toSedationIcuRows(source.kind === "icare" ? "icare" : "dose1", epochs, meta)
    : toImportRows(source.kind === "physionet-raw" ? "gaba" : "power", epochs, meta);
  return { rows, harmonization: record };
}

/**
 * Binary (EDF) sources. Only the frontal channel is decoded, and interval
 * labels come from the collection's published summary rather than the file.
 */
function rowsForBinaryFile(
  source: IntakeSource,
  file: PlannedFile,
  bytes: Uint8Array,
  summary: ChbSeizure[],
): { rows: PhysionetImportRow[]; harmonization: HarmonizationRecord | null } {
  if (source.kind !== "chbmit-edf") throw new Error(`no binary parser for ${source.kind}`);
  const parsed = parseChbRecording(bytes, {
    caseRef: file.caseRef,
    fileName: file.name,
    summary,
  });
  if (!parsed.epochs.length) throw new Error("no usable epochs were derived");

  const inferred = inferReference(parsed.channel);
  const harmonised = harmonizeEpochs(parsed.epochs, {
    ...source.montage,
    channel: parsed.channel,
    sampleRateHz: parsed.sampleRate,
    ...(inferred !== "unknown" ? { reference: inferred } : {}),
  });
  const rows = chbRows(harmonised, {
    datasetVersion: source.datasetVersion,
    subject: chbSubject(file.name),
    channel: parsed.channel,
    seizures: parsed.seizures,
  });
  return { rows, harmonization: harmonised[0]?.harmonization ?? null };
}

/** Seizure intervals for a subject, fetched once per run and reused. */
async function summaryFor(
  file: PlannedFile,
  cache: Map<string, ChbSeizure[]>,
): Promise<ChbSeizure[]> {
  const url = chbSummaryUrl(file.url);
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const { text } = await fetchText(url, 2_000_000);
    const parsed = parseChbSummary(text);
    cache.set(url, parsed);
    return parsed;
  } catch {
    // A missing summary means unlabelled epochs, not a failed file.
    cache.set(url, []);
    return [];
  }
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

  const { realms, headers: authHeaders } = resolveCredentials();
  const results: IntakeSourceResult[] = [];

  for (const source of sources) {
    const auth = authFor(source, authHeaders);
    const gate = checkEligibility(source, realms);
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
    // Members of an expanded archive, keyed by their member URL.
    const archived = new Map<string, string>();
    // Subject seizure summaries, one fetch per subject per run.
    const summaries = new Map<string, ChbSeizure[]>();
    try {
      discovered = await discoverFiles(source, gate.eligible ? archived : undefined, auth);
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
        let bytes: number;
        let digest: string;
        let parsedFile: { rows: PhysionetImportRow[]; harmonization: HarmonizationRecord | null };
        if (source.binary) {
          // Hour-long recordings are tens of megabytes, so allow a longer download.
          const raw = await fetchBytes(file.url, source.maxBytesPerFile, 300_000, auth);
          bytes = raw.byteLength;
          digest = await sha256HexBytes(raw);
          parsedFile = rowsForBinaryFile(source, file, raw, await summaryFor(file, summaries));
        } else {
          const member = archived.get(file.url);
          const fetched = member
            ? { text: member, bytes: new TextEncoder().encode(member).byteLength }
            : await fetchText(file.url, source.maxBytesPerFile, auth);
          bytes = fetched.bytes;
          digest = await sha256Hex(fetched.text);
          parsedFile = rowsForFile(source, file, fetched.text);
        }
        const { rows, harmonization } = parsedFile;
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
  /** Dataset version(s) the held files were published under. */
  datasetVersions: string[];
  /** SHA-256 of the most recently fetched file, for a re-fetch comparison. */
  latestDigest: string | null;
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
        "source_id, lineage, licence, licence_url, status, epochs, inserted, harmonization_version, dataset_version, content_digest, created_at",
      )
      .eq("status", "ingested")
      .limit(5000),
  ]);

  const groups = new Map<
    string,
    IntakeProvenanceEntry & { versions: Set<string>; datasets: Set<string> }
  >();
  for (const r of (fileRows ?? []) as {
    source_id: string;
    lineage: string;
    licence: string | null;
    licence_url: string | null;
    epochs: number | null;
    inserted: number | null;
    harmonization_version: string | null;
    dataset_version: string | null;
    content_digest: string | null;
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
        datasetVersions: [],
        latestDigest: null,
        versions: new Set<string>(),
        datasets: new Set<string>(),
      };
      groups.set(r.source_id, g);
    }
    g.files++;
    g.epochs += r.inserted ?? 0;
    if (r.harmonization_version) g.versions.add(r.harmonization_version);
    if (r.dataset_version) g.datasets.add(r.dataset_version);
    if (r.created_at && (!g.lastFetchedAt || r.created_at > g.lastFetchedAt)) {
      g.lastFetchedAt = r.created_at;
      g.latestDigest = r.content_digest;
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
      .map(({ versions, datasets, ...g }) => ({
        ...g,
        harmonizationVersions: [...versions].sort(),
        datasetVersions: [...datasets].sort(),
      }))
      .sort((a, b) => b.epochs - a.epochs),
  };
}

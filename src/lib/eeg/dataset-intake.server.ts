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
import {
  eventsUrlFor,
  openNeuroRows,
  parseBidsEvents,
  parseOpenNeuroRecording,
  type BidsEvent,
} from "./openneuro";
import { parseEdfHeader } from "./edf";
import { OpenNeuroStreamAssembler } from "./openneuro-stream";
import {
  buildEventDepthPoints,
  openNeuroDepthLineageKey,
  type EventDepthPoint,
} from "./openneuro-depth";
import { importEventDepthCases } from "./openneuro-depth.server";
import { replayRawEeg } from "./replay";
import {
  buildMoaasDepthPoints,
  clippedSeconds,
  DOSE1_DEPTH_DEVICE_ID,
  DOSE1_DEPTH_REFERENCE_KIND,
  DOSE1_DEPTH_SOURCE,
  dose1DepthLineageKey,
  moaasIntervals,
  parseDose1RawCsv,
  type Dose1DepthPoint,
} from "./dose1-raw";
import { readZipIndex, zipMemberByteRange, zipMemberText, type ZipMember } from "./zip-index";

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
  /** When set, ask the server for only the first N bytes of the object. */
  rangeBytes?: number,
): Promise<Uint8Array> {
  const base: Record<string, string> = {
    accept: "application/zip,application/octet-stream;q=0.8,*/*;q=0.5",
  };
  if (rangeBytes) base["range"] = `bytes=0-${rangeBytes - 1}`;
  const res = await fetch(url, {
    headers: withAuth(base, auth),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.byteLength > limitBytes) throw new Error("archive exceeded the per-archive cap");
  return buf;
}

/** Fetch one inclusive byte range. Used to walk a very large file in pieces. */
async function fetchRange(
  url: string,
  startByte: number,
  endByte: number,
  timeoutMs = FETCH_TIMEOUT_MS * 4,
  auth?: string,
): Promise<Uint8Array> {
  const res = await fetch(url, {
    headers: withAuth(
      { accept: "application/octet-stream;q=0.9,*/*;q=0.5", range: `bytes=${startByte}-${endByte}` },
      auth,
    ),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/* ----------------------------------------------------------- openneuro --- */

interface OpenNeuroNode {
  filename: string;
  id: string;
  directory: boolean;
  size: number | null;
  urls: string[] | null;
}

async function openNeuroTree(
  datasetId: string,
  tag: string,
  tree?: string,
): Promise<OpenNeuroNode[]> {
  const query = `query($id:ID!,$tag:String!,$tree:String){snapshot(datasetId:$id,tag:$tag){files(tree:$tree){filename id directory size urls}}}`;
  const res = await fetch("https://openneuro.org/crn/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables: { id: datasetId, tag, tree: tree ?? null } }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenNeuro HTTP ${res.status}`);
  const json = (await res.json()) as {
    data?: { snapshot?: { files?: OpenNeuroNode[] | null } | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length) throw new Error(json.errors[0]!.message);
  return json.data?.snapshot?.files ?? [];
}

/**
 * Walk a BIDS snapshot to the files this source wants. The tree is shallow
 * (subject → session → modality), so the walk is bounded and each match keeps
 * its full BIDS path as the file name, which is what provenance and
 * de-duplication key on.
 */
async function discoverOpenNeuro(
  source: IntakeSource,
  datasetId: string,
  tag: string,
): Promise<DiscoveredFile[]> {
  const out: DiscoveredFile[] = [];
  const walk = async (tree: string | undefined, prefix: string, depth: number) => {
    if (depth > 4 || out.length >= source.maxFilesPerRun * 8) return;
    const nodes = await openNeuroTree(datasetId, tag, tree);
    for (const node of nodes) {
      const path = prefix ? `${prefix}/${node.filename}` : node.filename;
      if (node.directory) {
        if (/^(sub-|ses-|eeg$)/.test(node.filename)) await walk(node.id, path, depth + 1);
        continue;
      }
      if (!source.filePattern.test(node.filename)) continue;
      const url = node.urls?.[0];
      if (!url) continue;
      out.push({ name: path, url, bytes: node.size ?? null });
    }
  };
  await walk(undefined, "", 0);
  return out;
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

/** Members of an archive that is only ever read by byte range, keyed by URL. */
export type ArchiveIndex = Map<string, { archiveUrl: string; member: ZipMember }>;

/**
 * Read a large archive's member index from its tail alone.
 *
 * A ZIP keeps its directory at the end, so a couple of megabytes is enough to
 * learn where each recording starts. Nothing else is downloaded here.
 */
async function indexArchive(
  source: IntakeSource,
  archive: DiscoveredFile,
  index: ArchiveIndex,
  auth?: string,
): Promise<DiscoveredFile[]> {
  const total = archive.bytes;
  if (!total) throw new Error(`${archive.name} publishes no size, so its index cannot be located.`);
  const tailBytes = Math.min(total, 4_000_000);
  const tailStart = total - tailBytes;
  const tail = await fetchRange(archive.url, tailStart, total - 1, FETCH_TIMEOUT_MS, auth);
  if (tail.byteLength < tailBytes) {
    throw new Error(
      `${archive.name} was served whole instead of by range; refusing to download ${Math.round(total / 1e6)} MB.`,
    );
  }
  const members = readZipIndex(tail, tailStart);
  const out: DiscoveredFile[] = [];
  for (const member of members) {
    if (!source.filePattern.test(member.name)) continue;
    const url = `${archive.url}#${member.name}`;
    index.set(url, { archiveUrl: archive.url, member });
    out.push({ name: member.name, url, bytes: member.uncompressedSize });
  }
  return out;
}

/** Fetch and inflate one archive member with a single byte range. */
async function fetchArchiveMember(
  entry: { archiveUrl: string; member: ZipMember },
  auth?: string,
): Promise<{ text: string; bytes: number }> {
  const { start, end } = zipMemberByteRange(entry.member);
  const bytes = await fetchRange(entry.archiveUrl, start, end, 300_000, auth);
  const text = await zipMemberText(entry.member, bytes);
  return { text, bytes: entry.member.compressedSize };
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
  archiveIndex?: ArchiveIndex,
): Promise<DiscoveredFile[]> {
  const listing = source.listing;
  let files: DiscoveredFile[];
  if (listing.type === "manifest") {
    files = listing.files.map((f) => ({ ...f, bytes: null }));
  } else if (listing.type === "openneuro") {
    files = await discoverOpenNeuro(source, listing.datasetId, listing.tag);
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
    expanded.push(
      ...(source.archiveIndexOnly
        ? archiveIndex
          ? await indexArchive(source, f, archiveIndex, auth)
          : []
        : await expandArchive(source, f, cache, auth)),
    );
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
  events: BidsEvent[] = [],
): { rows: PhysionetImportRow[]; harmonization: HarmonizationRecord | null } {
  if (source.kind === "openneuro-bids-edf") {
    const parsed = parseOpenNeuroRecording(bytes, {
      caseRef: file.caseRef,
      fileName: file.name,
      events,
    });
    const inferredRef = inferReference(parsed.channel);
    const harmonisedEpochs = harmonizeEpochs(parsed.epochs, {
      ...source.montage,
      channel: parsed.channel,
      sampleRateHz: parsed.sampleRate,
      ...(inferredRef !== "unknown" ? { reference: inferredRef } : {}),
    });
    return {
      rows: openNeuroRows(harmonisedEpochs, {
        datasetVersion: source.datasetVersion,
        fileName: file.name,
        channel: parsed.channel,
        labelledIntervals: parsed.labelledIntervals,
        monitorChannel: parsed.monitorChannel,
        monitorMean: parsed.monitorMean,
      }),
      harmonization: harmonisedEpochs[0]?.harmonization ?? null,
    };
  }
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

/** Published BIDS events beside a recording; missing events are not a failure. */
async function eventsFor(file: PlannedFile, cache: Map<string, BidsEvent[]>): Promise<BidsEvent[]> {
  const url = eventsUrlFor(file.url);
  const cached = cache.get(url);
  if (cached) return cached;
  try {
    const { text } = await fetchText(url, 2_000_000);
    const parsed = parseBidsEvents(text);
    cache.set(url, parsed);
    return parsed;
  } catch {
    cache.set(url, []);
    return [];
  }
}


/* --------------------------------------------------- streamed decoding --- */

interface StreamedFileResult {
  rows: PhysionetImportRow[];
  harmonization: HarmonizationRecord | null;
  bytes: number;
  digest: string;
  /** Event-referenced paired readings, ready to store under their own lineage. */
  paired: { lineageKey: string; channel: string; points: EventDepthPoint[] } | null;
  detail: string;
}

/**
 * Decode a whole ds004541 recording in record-aligned ranges, then replay the
 * decimated frontal channel once so the published events can act as a coarse
 * depth reference for the parts of the anaesthetic they actually describe.
 */
async function streamOpenNeuroFile(
  source: IntakeSource,
  file: PlannedFile,
  events: BidsEvent[],
  auth?: string,
): Promise<StreamedFileResult> {
  const headerBytes = await fetchRange(file.url, 0, 1_048_575, FETCH_TIMEOUT_MS, auth);
  const header = parseEdfHeader(headerBytes);
  const assembler = new OpenNeuroStreamAssembler(header, {
    caseRef: file.caseRef,
    fileName: file.name,
  });
  const chunks = assembler.plan(source.streamChunkBytes ?? 24_000_000);
  if (!chunks.length) throw new Error("EDF header declares no data records");

  for (const chunk of chunks) {
    const slab = await fetchRange(file.url, chunk.startByte, chunk.endByte, 300_000, auth);
    if (!slab.byteLength) break;
    assembler.push(slab, chunk);
  }
  const recording = assembler.finish(events);

  const inferredRef = inferReference(recording.channel);
  const harmonisedEpochs = harmonizeEpochs(recording.epochs, {
    ...source.montage,
    channel: recording.channel,
    sampleRateHz: recording.sampleRate,
    ...(inferredRef !== "unknown" ? { reference: inferredRef } : {}),
  });
  const rows = openNeuroRows(harmonisedEpochs, {
    datasetVersion: source.datasetVersion,
    fileName: file.name,
    channel: recording.channel,
    labelledIntervals: recording.labelledIntervals,
  });

  let paired: StreamedFileResult["paired"] = null;
  let pairedNote = "no stable event intervals";
  if (recording.intervals.length && recording.replaySignal.length > recording.replaySampleRate * 8) {
    const replay = replayRawEeg({
      samples: recording.replaySignal,
      sampleRate: recording.replaySampleRate,
    });
    const built = buildEventDepthPoints(replay.frames, recording.intervals, {
      caseRef: file.caseRef,
      channel: recording.channel,
    });
    if (built.points.length) {
      paired = {
        lineageKey: openNeuroDepthLineageKey(recording.channel, recording.replaySampleRate),
        channel: recording.channel,
        points: built.points,
      };
      pairedNote = `${built.points.length} event-referenced readings (${Object.entries(built.states)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")})`;
    }
  }

  // The whole file is never held, so provenance digests the header block and
  // records the decoded span rather than pretending to a whole-file checksum.
  const digest = `stream-header:${await sha256HexBytes(headerBytes.subarray(0, header.headerBytes))}`;

  return {
    rows,
    harmonization: harmonisedEpochs[0]?.harmonization ?? null,
    bytes: recording.bytesDecoded,
    digest,
    paired,
    detail: `${Math.round(recording.durationSeconds / 60)} min decoded in ${recording.chunksDecoded} ranges; ${pairedNote}`,
  };
}

/**
 * Replay one DOSE-I raw recording against its MOAA/S annotations.
 *
 * DOSE-I publishes no bedside depth index, so the reference here is the
 * clinical sedation score mapped onto the 0–100 scale with an explicit spread.
 * Only stable, unclipped stretches survive, and the readings are stored under
 * their own lineage marked as a score reference — they can never be mistaken
 * for a monitor value.
 */
function dose1RawPaired(
  file: PlannedFile,
  text: string,
): { paired: { lineageKey: string; channel: string; points: Dose1DepthPoint[] } | null; detail: string } {
  const channel = "EEG_1";
  const recording = parseDose1RawCsv(text, { channel });
  if (!recording.samples.length || !recording.observations.length) {
    return { paired: null, detail: "no usable EEG samples or MOAA/S annotations" };
  }
  const intervals = moaasIntervals(recording.observations, recording.durationSeconds);
  const replay = replayRawEeg({
    samples: recording.samples,
    sampleRate: recording.sampleRate,
  });
  const built = buildMoaasDepthPoints(
    replay.frames,
    intervals,
    { caseRef: file.caseRef, channel },
    { clipped: clippedSeconds(recording.samples, recording.sampleRate) },
  );
  const scores = Object.entries(built.scores)
    .map(([k, v]) => `MOAA/S ${k}: ${v}`)
    .join(", ");
  const detail = built.points.length
    ? `${Math.round(recording.durationSeconds / 60)} min replayed; ${built.points.length} score-referenced readings (${scores}); ${built.rejected.clipped} dropped for clipping`
    : `${Math.round(recording.durationSeconds / 60)} min replayed; no stable unclipped stretch (${built.rejected.shortInterval} short runs, ${built.rejected.clipped} clipped)`;
  if (!built.points.length) return { paired: null, detail };
  return {
    paired: {
      lineageKey: dose1DepthLineageKey(recording.sampleRate),
      channel,
      points: built.points,
    },
    detail,
  };
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
    // Members of an archive read by byte range rather than downloaded whole.
    const archiveIndex: ArchiveIndex = new Map();
    // Subject seizure summaries, one fetch per subject per run.
    const summaries = new Map<string, ChbSeizure[]>();
    // Published BIDS events per recording, one fetch per file per run.
    const bidsEvents = new Map<string, BidsEvent[]>();
    try {
      discovered = await discoverFiles(
        source,
        gate.eligible ? archived : undefined,
        auth,
        archiveIndex,
      );
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
      let paired: StreamedFileResult["paired"] = null;
      let streamNote = "";
      try {
        let bytes: number;
        let digest: string;
        let parsedFile: { rows: PhysionetImportRow[]; harmonization: HarmonizationRecord | null };
        if (source.binary && source.streamChunkBytes) {
          const streamed = await streamOpenNeuroFile(
            source,
            file,
            await eventsFor(file, bidsEvents),
            auth,
          );
          bytes = streamed.bytes;
          digest = streamed.digest;
          paired = streamed.paired;
          streamNote = streamed.detail;
          parsedFile = { rows: streamed.rows, harmonization: streamed.harmonization };
        } else if (source.binary) {
          // Hour-long recordings are tens of megabytes, so allow a longer download.
          const raw = await fetchBytes(
            file.url,
            source.maxBytesPerFile,
            300_000,
            auth,
            source.rangeBytes,
          );
          bytes = raw.byteLength;
          digest = await sha256HexBytes(raw);
          parsedFile = rowsForBinaryFile(
            source,
            file,
            raw,
            source.kind === "chbmit-edf" ? await summaryFor(file, summaries) : [],
            source.kind === "openneuro-bids-edf" ? await eventsFor(file, bidsEvents) : [],
          );
        } else if (source.kind === "dose1-raw") {
          const entry = archiveIndex.get(file.url);
          if (!entry) throw new Error("The archive index has no entry for this recording.");
          const fetched = await fetchArchiveMember(entry, auth);
          bytes = fetched.bytes;
          digest = await sha256Hex(fetched.text);
          const replayed = dose1RawPaired(file, fetched.text);
          paired = replayed.paired;
          streamNote = replayed.detail;
          // The raw archive contributes score-referenced readings only; its
          // spectra are already held from the published pEEG route.
          parsedFile = { rows: [], harmonization: null };
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
        if (paired?.points.length) {
          const isDose1 = source.kind === "dose1-raw";
          const storedPairs = await importEventDepthCases(
            supabase,
            userId,
            [
              {
                caseRef: file.caseRef,
                lineageKey: paired.lineageKey,
                channel: paired.channel,
                covariates: {
                  ageBand: null,
                  sex: null,
                  regimen: isDose1 ? "propofol-sedation" : "volatile",
                },
                points: paired.points,
              },
            ],
            isDose1
              ? {
                  device: DOSE1_DEPTH_DEVICE_ID,
                  source: DOSE1_DEPTH_SOURCE,
                  sourceSite: "zenodo",
                  referenceKind: DOSE1_DEPTH_REFERENCE_KIND,
                  pointFeatures: (p) => ({ moaas: (p as Dose1DepthPoint).moaas }),
                }
              : undefined,
          );
          outcome.pairedInserted = storedPairs.inserted;
          base.pairedInserted = (base.pairedInserted ?? 0) + storedPairs.inserted;
        }
        if (streamNote) outcome.detail += ` · ${streamNote}`;
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

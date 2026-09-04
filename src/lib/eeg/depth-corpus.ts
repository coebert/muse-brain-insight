/**
 * Depth-corpus intake: a delimited file that carries its own depth score next
 * to the raw EEG it was measured from.
 *
 * The rule that makes this worth having is the same one the figshare and
 * VitalDB imports obey: a depth score on its own cannot train or grade
 * anything, because there is no way to know what this app would have said at
 * the same instant. Only a corpus that publishes the *signal* can be replayed
 * through the app's own estimator, and only then can the two numbers be put
 * side by side honestly.
 *
 * So a file without a raw-signal column is rejected here with that reason
 * stated, rather than filed as if it were trainable.
 *
 * Everything the parser infers rather than reads — the sample rate, the case
 * split, which column is which — is reported back so the operator confirms it
 * before a single row is written.
 */

import { lineageKey, type DataLineage } from "./model-lineage";
import { replayRawEeg } from "./replay";
import type { AnalysisChannel } from "./device-profile";

/** Version stamped on every reading this intake files. */
export const DEPTH_CORPUS_VERSION = "depth-corpus-1.0.0";
/** Source site recorded for hand-uploaded corpora. */
export const DEPTH_CORPUS_SITE = "upload";

/** Column roles the parser recognises, and the header names it accepts. */
export const COLUMN_ALIASES: Record<CorpusRole, string[]> = {
  case: ["case", "case_id", "caseid", "subject", "record", "recording", "patient"],
  time: ["time", "t", "seconds", "sec", "timestamp", "at", "at_seconds"],
  eeg: ["eeg", "signal", "raw", "uv", "µv", "amplitude", "af7", "af8", "fp1", "fp2", "ch1"],
  depth: ["depth", "bis", "score", "index", "depth_score", "sedline", "entropy", "psi"],
  sr: ["sr", "suppression", "suppression_ratio", "bsr"],
  sef: ["sef", "sef95", "spectral_edge"],
  sqi: ["sqi", "quality", "signal_quality"],
};

export type CorpusRole = "case" | "time" | "eeg" | "depth" | "sr" | "sef" | "sqi";

const ROLES: CorpusRole[] = ["case", "time", "eeg", "depth", "sr", "sef", "sqi"];

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s\-.]+/g, "_");

/** Guess each column's role from its header name. */
export function detectColumns(headers: string[]): Partial<Record<CorpusRole, number>> {
  const map: Partial<Record<CorpusRole, number>> = {};
  headers.forEach((raw, i) => {
    const h = norm(raw);
    for (const role of ROLES) {
      if (map[role] != null) continue;
      if (COLUMN_ALIASES[role].some((a) => h === norm(a) || h.startsWith(`${norm(a)}_`))) {
        map[role] = i;
        return;
      }
    }
  });
  return map;
}

export interface CorpusScore {
  at: number;
  value: number;
  sr: number | null;
  sef: number | null;
  sqi: number | null;
}

export interface CorpusCase {
  caseRef: string;
  samples: number[];
  /** Seconds of the first sample, used when the file starts part-way in. */
  startSeconds: number;
  scores: CorpusScore[];
}

export interface CorpusParse {
  headers: string[];
  columns: Partial<Record<CorpusRole, number>>;
  cases: CorpusCase[];
  rows: number;
  /** Rows dropped because a required field was missing or out of range. */
  dropped: number;
  /** Sample rate read off the time column, when the file carries one. */
  derivedSampleRate: number | null;
  /** Anything the operator must know before confirming the import. */
  issues: string[];
}

const DELIMS = [",", "\t", ";"] as const;

function splitLine(line: string, delim: string): string[] {
  // Minimal CSV: quoted fields with embedded delimiters, no embedded newlines.
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === delim) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Pick the delimiter that yields the most columns on the header line. */
export function detectDelimiter(headerLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const d of DELIMS) {
    const n = splitLine(headerLine, d).length;
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  }
  return best;
}

const num = (s: string | undefined): number | null => {
  if (s == null) return null;
  const t = s.trim();
  if (!t || t.toLowerCase() === "na" || t.toLowerCase() === "nan" || t === "-") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
};

/** Read a delimited corpus into per-case sample runs and depth readings. */
export function parseDepthCorpus(
  text: string,
  options: { maxRows?: number; overrides?: Partial<Record<CorpusRole, number>> } = {},
): CorpusParse {
  const maxRows = options.maxRows ?? 2_000_000;
  const lines = text.split(/\r?\n/);
  let head = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim()) {
      head = i;
      break;
    }
  }
  if (head < 0) throw new Error("That file has no rows in it.");

  const delim = detectDelimiter(lines[head]!);
  const headers = splitLine(lines[head]!, delim).map((h) => h.trim());
  const columns = { ...detectColumns(headers), ...(options.overrides ?? {}) };
  const issues: string[] = [];

  if (columns.depth == null) {
    throw new Error(
      "No depth-score column was found. Name it depth, bis, score or index so the file can be graded.",
    );
  }
  if (columns.eeg == null) {
    throw new Error(
      "No raw-signal column was found. A file of depth scores alone cannot be paired: without the EEG behind them there is no way to know what this app would have said at the same moment. Name the signal column eeg, signal or raw, or file the scores as a reference upload instead.",
    );
  }

  const byCase = new Map<string, CorpusCase>();
  let rows = 0;
  let dropped = 0;
  const timeSteps: number[] = [];
  let prevTime: number | null = null;
  let prevCase: string | null = null;

  for (let i = head + 1; i < lines.length && rows < maxRows; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    const cells = splitLine(line, delim);
    rows++;

    const caseRef = (columns.case != null ? cells[columns.case]?.trim() : "") || "case-1";
    let entry = byCase.get(caseRef);
    if (!entry) {
      entry = { caseRef, samples: [], startSeconds: 0, scores: [] };
      byCase.set(caseRef, entry);
    }

    const t = columns.time != null ? num(cells[columns.time]) : null;
    if (t != null) {
      if (prevCase === caseRef && prevTime != null && t > prevTime) timeSteps.push(t - prevTime);
      if (!entry.samples.length) entry.startSeconds = t;
      prevTime = t;
      prevCase = caseRef;
    }

    const sample = num(cells[columns.eeg!]);
    if (sample == null) dropped++;
    else entry.samples.push(sample);

    const depth = num(cells[columns.depth!]);
    if (depth != null) {
      if (depth < 0 || depth > 100) dropped++;
      else
        entry.scores.push({
          at: t ?? entry.samples.length,
          value: depth,
          sr: columns.sr != null ? num(cells[columns.sr]) : null,
          sef: columns.sef != null ? num(cells[columns.sef]) : null,
          sqi: columns.sqi != null ? num(cells[columns.sqi]) : null,
        });
    }
  }

  let derived: number | null = null;
  if (timeSteps.length >= 8) {
    const sorted = [...timeSteps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (median > 0) derived = Math.round(1 / median);
    if (derived != null && (derived < 1 || derived > 20000)) derived = null;
  }
  if (columns.time == null) {
    issues.push("The file has no time column, so timings come from the stated sample rate alone.");
  }
  if (columns.case == null) {
    issues.push("The file has no case column, so every row was treated as one recording.");
  }

  const cases = [...byCase.values()].filter((c) => c.samples.length > 0 && c.scores.length > 0);
  const emptied = byCase.size - cases.length;
  if (emptied > 0) {
    issues.push(`${emptied} recording(s) had signal but no depth score, or the reverse, and were left out.`);
  }
  if (!cases.length) {
    throw new Error("No recording in that file had both a raw signal and a depth score.");
  }

  return { headers, columns, cases, rows, dropped, derivedSampleRate: derived, issues };
}

export interface CorpusPoint {
  atSeconds: number;
  reference: number;
  appIndex: number;
  appSef: number | null;
  appSr: number | null;
  refSr: number | null;
  refSef: number | null;
  sqi: number | null;
  lagSeconds: number;
  externalRef: string;
}

export interface CorpusCaseResult {
  caseRef: string;
  seconds: number;
  points: CorpusPoint[];
  rejected: { unmatched: number; noIndex: number };
}

export interface PairOptions {
  sampleRate: number;
  /** Corpus id, part of every reading's external reference. */
  corpusId: string;
  /** One retained pair per this many seconds of case time. */
  strideSeconds?: number;
  /** How far a score may sit from a replayed second and still pair. */
  toleranceSeconds?: number;
}

/**
 * Replay one case's signal and pair each published depth score with the
 * replayed second nearest it. A score with no replayed second inside the
 * tolerance is dropped and counted, never stretched onto the closest frame.
 */
export function pairCorpusCase(entry: CorpusCase, options: PairOptions): CorpusCaseResult {
  const stride = Math.max(1, options.strideSeconds ?? 5);
  const tolerance = options.toleranceSeconds ?? 2;
  const fs = options.sampleRate;
  const replay = replayRawEeg({ samples: entry.samples, sampleRate: fs });
  const frames = replay.frames;
  const rejected = { unmatched: 0, noIndex: 0 };
  const points: CorpusPoint[] = [];

  // Scores are timed either by the file's own clock or, when there is none, by
  // the sample position they sat on divided by the stated rate.
  const timed = entry.scores
    .map((s) => ({
      ...s,
      at: entry.scores.length && Number.isFinite(s.at) ? s.at : 0,
    }))
    .map((s) => ({ ...s, at: s.at > entry.samples.length ? s.at : s.at }))
    .sort((a, b) => a.at - b.at);

  let taken = -Infinity;
  let j = 0;
  for (const score of timed) {
    const t = score.at;
    if (t - taken < stride) continue;
    while (j + 1 < frames.length && Math.abs(frames[j + 1]!.t - t) <= Math.abs(frames[j]!.t - t)) {
      j++;
    }
    const frame = frames[j];
    if (!frame || Math.abs(frame.t - t) > tolerance) {
      rejected.unmatched++;
      continue;
    }
    if (frame.appIndex == null) {
      rejected.noIndex++;
      continue;
    }
    points.push({
      atSeconds: Number(t.toFixed(2)),
      reference: Number(score.value.toFixed(1)),
      appIndex: Number(frame.appIndex.toFixed(2)),
      appSef: Number(frame.sef95.toFixed(2)),
      appSr: Number(frame.suppressionRatio.toFixed(2)),
      refSr: score.sr,
      refSef: score.sef,
      sqi: score.sqi,
      lagSeconds: Number((frame.t - t).toFixed(2)),
      externalRef: `${options.corpusId}:${entry.caseRef}:${t.toFixed(2)}`,
    });
    taken = t;
  }

  return {
    caseRef: entry.caseRef,
    seconds: entry.samples.length / fs,
    points,
    rejected,
  };
}

/** Convert scores timed by sample position into seconds. */
export function retimeByRate(entry: CorpusCase, sampleRate: number): CorpusCase {
  return {
    ...entry,
    scores: entry.scores.map((s) => ({ ...s, at: s.at / sampleRate })),
  };
}

/** The acquisition lineage an uploaded corpus is filed under. */
export function corpusLineage(
  deviceId: string,
  deviceLabel: string,
  channel: AnalysisChannel,
  sampleRate: number,
): DataLineage {
  return {
    deviceId,
    deviceLabel,
    transport: "ingest",
    channels: [channel],
    sampleRate,
  };
}

export function corpusLineageKey(
  deviceId: string,
  channel: AnalysisChannel,
  sampleRate: number,
): string {
  return lineageKey(corpusLineage(deviceId, deviceId, channel, sampleRate));
}

/** Slug a free-text corpus name into a stable device id. */
export function corpusDeviceId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug ? `upload-${slug}`.slice(0, 48) : "upload-corpus";
}

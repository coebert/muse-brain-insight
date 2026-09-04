/**
 * Pairing worklist — which stored recordings can still close the gap to a
 * fittable lineage.
 *
 * A lineage can only be fitted against readings taken from a commercial
 * monitor at the bedside. Where a recording holds EEG but no monitor values,
 * the gap cannot be closed by any amount of computation: the reference numbers
 * simply were not written down. This module works out how many readings are
 * still missing, spreads that shortfall across the recordings that could
 * supply it, and picks the moments in each recording that are worth pairing.
 *
 * Nothing here invents a monitor value. It only proposes where a real one
 * would do the most good.
 */

import { MIN_POINTS, MIN_SESSIONS } from "./bis-drift";

export interface PairingMoment {
  /** Seconds from the start of the recording. */
  at: number;
  /** App depth index stored for that moment. */
  appIndex: number;
  appSr: number | null;
  appSef: number | null;
  /** Depth state recorded at that moment, for orientation. */
  state: string | null;
}

export interface PairingCandidate {
  sessionId: string;
  caseCode: string | null;
  startedAt: string;
  durationSeconds: number;
  /** Epochs stored for the recording. */
  epochs: number;
  /** Epochs that carry a depth index and so can be paired. */
  indexEpochs: number;
  /** Monitor readings already on file for this recording. */
  paired: number;
  /** How many readings this recording is being asked to supply. */
  suggested: number;
}

export interface PairingWorklist {
  lineageKey: string;
  /** Validated readings on file for the lineage. */
  validated: number;
  /** Cases those readings span. */
  cases: number;
  needPoints: number;
  needCases: number;
  /** Readings still missing before the lineage can be cross-validated. */
  shortfallPoints: number;
  /** Independent cases still missing. */
  shortfallCases: number;
  candidates: PairingCandidate[];
  /** Recordings with EEG but no monitor readings at all. */
  unpairedRecordings: number;
  /** True once the gate is met and the scheduled refit can fit the lineage. */
  ready: boolean;
}

/** Most readings worth asking for from any single recording. */
export const MAX_PER_CASE = 8;
/** Fewest worth asking for, so a recording that is opened is worth opening. */
export const MIN_PER_CASE = 3;

/**
 * Pick evenly spaced moments that carry an index, keeping clear of the first
 * and last 5% of the recording where the headband is being settled or removed.
 */
export function suggestMoments(epochs: PairingMoment[], count: number): PairingMoment[] {
  const usable = epochs
    .filter((e) => Number.isFinite(e.appIndex))
    .sort((a, b) => a.at - b.at);
  if (!usable.length || count <= 0) return [];
  const span = usable[usable.length - 1]!.at - usable[0]!.at;
  const margin = span * 0.05;
  const lo = usable[0]!.at + margin;
  const hi = usable[usable.length - 1]!.at - margin;
  const inner = usable.filter((e) => e.at >= lo && e.at <= hi);
  const pool = inner.length >= count ? inner : usable;
  if (pool.length <= count) return pool;
  const step = (pool.length - 1) / (count - 1 || 1);
  const picked: PairingMoment[] = [];
  for (let i = 0; i < count; i++) picked.push(pool[Math.round(i * step)]!);
  return picked.filter((m, i, arr) => arr.findIndex((o) => o.at === m.at) === i);
}

/** Work out the shortfall and how to spread it across the open recordings. */
export function planPairing(
  lineageKey: string,
  state: { validated: number; cases: number },
  candidates: Omit<PairingCandidate, "suggested">[],
): PairingWorklist {
  const shortfallPoints = Math.max(0, MIN_POINTS - state.validated);
  const shortfallCases = Math.max(0, MIN_SESSIONS - state.cases);

  // Rank by how much usable signal each recording holds: a longer recording
  // with more indexed epochs gives the widest choice of depth states to pair.
  const ranked = [...candidates].sort(
    (a, b) => b.indexEpochs - a.indexEpochs || b.durationSeconds - a.durationSeconds,
  );

  // Spread the shortfall over enough recordings to also close the case gap,
  // rather than loading it all onto the single longest recording.
  const spreadOver = Math.max(
    1,
    Math.min(ranked.length, Math.max(shortfallCases, Math.ceil(shortfallPoints / MAX_PER_CASE))),
  );
  const per = shortfallPoints
    ? Math.min(MAX_PER_CASE, Math.max(MIN_PER_CASE, Math.ceil(shortfallPoints / spreadOver)))
    : 0;

  let left = shortfallPoints;
  const withSuggestions: PairingCandidate[] = ranked.map((c) => {
    if (left <= 0 || c.indexEpochs === 0) return { ...c, suggested: 0 };
    const ask = Math.min(per, left, MAX_PER_CASE);
    left -= ask;
    return { ...c, suggested: ask };
  });

  return {
    lineageKey,
    validated: state.validated,
    cases: state.cases,
    needPoints: MIN_POINTS,
    needCases: MIN_SESSIONS,
    shortfallPoints,
    shortfallCases,
    candidates: withSuggestions,
    unpairedRecordings: candidates.filter((c) => c.paired === 0).length,
    ready: shortfallPoints === 0 && shortfallCases === 0,
  };
}

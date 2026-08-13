/**
 * Version history of COEBIS refits.
 *
 * The pooled fit is recomputed automatically as paired commercial-BIS readings
 * are entered, so the number on the bedside screen can change without anyone
 * watching. This keeps a local ledger of every refit attempt — when it ran,
 * what triggered it, whether a new model version was produced, and how much
 * the displayed COEBIS value actually moved — so a clinician can see whether a
 * change in the number came from the patient or from the model.
 */

import { applyBisAlignment, type BisAlignment } from "@/lib/eeg/depth";

const KEY = "eeg.coebisRefitLog.v1";
const EVENT = "eeg:coebis-refit-log";
const MAX_ENTRIES = 60;

/** OpenIBIS anchors used to measure how far a refit moved the number. */
const PROBE_POINTS = [30, 40, 50, 60, 70] as const;

export interface CoebisRefitEntry {
  id: string;
  /** Epoch milliseconds of the refit. */
  at: number;
  trigger: "auto" | "manual";
  /** True when the refit produced a new model version. */
  changed: boolean;
  versionBefore: number | null;
  versionAfter: number | null;
  provisional: boolean;
  /** Paired readings behind the resulting model. */
  n: number | null;
  /** COEBIS value at OpenIBIS 50 before/after this refit. */
  valueBefore: number | null;
  valueAfter: number | null;
  /** Largest change in COEBIS across the 30–70 range, in index units. */
  maxDelta: number | null;
  maeAfter: number | null;
  biasAfter: number | null;
}

function probe(model: BisAlignment | null, x: number): number {
  return model ? applyBisAlignment(x, model) : x;
}

/** Largest shift the refit makes to the displayed number across the range. */
export function modelShift(
  before: BisAlignment | null,
  after: BisAlignment | null,
): { atFifty: number; max: number } {
  let max = 0;
  for (const x of PROBE_POINTS) {
    max = Math.max(max, Math.abs(probe(after, x) - probe(before, x)));
  }
  return { atFifty: probe(after, 50), max };
}

export function readCoebisRefitLog(): CoebisRefitEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as CoebisRefitEntry[]) : [];
  } catch {
    return [];
  }
}

export function clearCoebisRefitLog() {
  try {
    window.localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* storage unavailable — history is best-effort */
  }
}

/** Appends a refit to the ledger and notifies any open history panel. */
export function recordCoebisRefit(input: {
  trigger: "auto" | "manual";
  before: BisAlignment | null;
  after: BisAlignment | null;
  changed?: boolean;
}): CoebisRefitEntry | null {
  if (typeof window === "undefined") return null;
  const { trigger, before, after } = input;
  const changed =
    input.changed ?? (!!after?.id && after.id !== (before?.id ?? null));
  const shift = modelShift(before, after);

  const entry: CoebisRefitEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    trigger,
    changed,
    versionBefore: before?.version ?? null,
    versionAfter: after?.version ?? null,
    provisional: !!after?.provisional,
    n: after?.n ?? null,
    valueBefore: before || after ? Math.round(probe(before, 50)) : null,
    valueAfter: before || after ? Math.round(shift.atFifty) : null,
    maxDelta: Number.isFinite(shift.max) ? Math.round(shift.max * 10) / 10 : null,
    maeAfter: typeof after?.maeAfter === "number" ? after.maeAfter : null,
    biasAfter: typeof after?.biasAfter === "number" ? after.biasAfter : null,
  };

  try {
    const next = [entry, ...readCoebisRefitLog()].slice(0, MAX_ENTRIES);
    window.localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent(EVENT));
  } catch {
    /* storage unavailable — history is best-effort */
  }
  return entry;
}

/** Subscribes a panel to log changes (including from other tabs). */
export function subscribeCoebisRefitLog(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", fn);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", fn);
  };
}

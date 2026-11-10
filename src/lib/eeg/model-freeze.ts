/**
 * Recording-scoped model freeze.
 *
 * A recording is scored with one set of models from its first second to its
 * last: the COEBIS alignment, the SEF correction, the COEBIS-2 coefficients and
 * the sedation output curve that were active when it started. Refits that
 * finish mid-case are filed as candidates and only take effect for the next
 * recording, so no number on a running case's trend was produced by a model
 * that did not exist when the earlier numbers were.
 *
 * Model loaders call {@link deferWhileFrozen} instead of applying a change
 * directly. While a recording runs, the latest change per key is queued and
 * applied when the recording ends; otherwise it is applied at once.
 */

export interface FrozenModelRef {
  id: string | null;
  version?: number | null;
  fittedAt?: string | null;
  n?: number | null;
  provisional?: boolean | null;
  pinned?: boolean | null;
  family?: string | null;
}

/** What a saved recording was computed with, filed with the case. */
export interface ModelProvenance {
  schema: "model-provenance-1";
  frozenAt: string;
  releasedAt: string | null;
  coebisAlignment: FrozenModelRef | null;
  sefAlignment: FrozenModelRef | null;
  coebisV2: string | null;
  sedationTune: FrozenModelRef | null;
  /** Device amplitude calibration and what it made unavailable. */
  amplitudeCalibrated: boolean;
  withheld: string[];
  /** Changes that arrived during the recording and were held back. */
  deferredChanges: string[];
}

let frozen: ModelProvenance | null = null;
const deferred = new Map<string, () => void>();
const listeners = new Set<(frozen: boolean) => void>();

export function isModelFrozen(): boolean {
  return frozen !== null;
}

export function currentModelProvenance(): ModelProvenance | null {
  return frozen ? { ...frozen, deferredChanges: [...deferred.keys()] } : null;
}

/** Keys of model changes waiting for the next recording. */
export function pendingModelChanges(): string[] {
  return [...deferred.keys()];
}

export function onModelFreezeChange(fn: (frozen: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Start a recording: everything currently in force is held until release. */
export function freezeModels(
  snapshot: Omit<ModelProvenance, "schema" | "frozenAt" | "releasedAt" | "deferredChanges">,
): ModelProvenance {
  if (frozen) return frozen;
  frozen = {
    schema: "model-provenance-1",
    frozenAt: new Date().toISOString(),
    releasedAt: null,
    deferredChanges: [],
    ...snapshot,
  };
  listeners.forEach((fn) => fn(true));
  return frozen;
}

/**
 * End the recording. Returns its final provenance and applies every change
 * that was queued while it ran, so the next recording starts on them.
 */
export function releaseModels(): ModelProvenance | null {
  if (!frozen) return null;
  const final: ModelProvenance = {
    ...frozen,
    releasedAt: new Date().toISOString(),
    deferredChanges: [...deferred.keys()],
  };
  frozen = null;
  const queued = [...deferred.values()];
  deferred.clear();
  for (const apply of queued) {
    try {
      apply();
    } catch {
      // A failed apply leaves the previous model in force for the next case.
    }
  }
  listeners.forEach((fn) => fn(false));
  return final;
}

/**
 * Apply now, or queue for after the recording. The latest change for a key
 * wins. Returns true when the change was deferred.
 */
export function deferWhileFrozen(key: string, apply: () => void): boolean {
  if (!frozen) {
    apply();
    return false;
  }
  deferred.delete(key);
  deferred.set(key, apply);
  return true;
}

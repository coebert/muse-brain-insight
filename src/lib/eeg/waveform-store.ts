/**
 * A tiny external store for the live EEG trace.
 *
 * The waveform refreshes at 5 Hz — far faster than any clinical number on the
 * screen. Holding it in React state re-rendered the whole dashboard five times
 * a second, so it lives here instead and only the strip that draws it
 * subscribes (via `useSyncExternalStore`).
 */
export interface WaveformStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => Float64Array;
  set: (data: Float64Array) => void;
}

const EMPTY = new Float64Array(0);

export function createWaveformStore(): WaveformStore {
  let current: Float64Array = EMPTY;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => current,
    set(data) {
      current = data;
      for (const l of listeners) l();
    },
  };
}

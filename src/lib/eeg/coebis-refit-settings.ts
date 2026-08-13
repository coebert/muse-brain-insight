/**
 * Pacing preferences for the automatic COEBIS refit.
 *
 * Transcribing a run of paired commercial-BIS readings, or filing a case that
 * links a batch of points at once, can otherwise trigger a refit per keystroke
 * burst. Two clinician-tunable controls pace it: a settle delay so a burst
 * files as one batch, and a minimum interval between refits so a long
 * transcription session cannot recompute the pooled fit repeatedly.
 */

import { useCallback, useEffect, useState } from "react";

const KEY = "eeg.coebisRefit.v1";
const EVENT = "eeg:coebis-refit-settings";

/** Settle window options, in milliseconds. */
export const COEBIS_DEBOUNCE_CHOICES = [1000, 2000, 4000, 8000, 15000, 30000] as const;
/** Minimum spacing between automatic refits, in milliseconds (0 = no throttle). */
export const COEBIS_MIN_INTERVAL_CHOICES = [0, 30000, 60000, 120000, 300000, 600000] as const;

export const DEFAULT_COEBIS_REFIT_SETTINGS: CoebisRefitSettings = {
  auto: true,
  debounceMs: 4000,
  minIntervalMs: 60000,
};

export interface CoebisRefitSettings {
  /** Refit automatically as readings are entered. */
  auto: boolean;
  /** Settle time after the last new reading before filing/refitting. */
  debounceMs: number;
  /** Refits are spaced at least this far apart. */
  minIntervalMs: number;
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

export function readCoebisRefitSettings(): CoebisRefitSettings {
  if (typeof window === "undefined") return DEFAULT_COEBIS_REFIT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_COEBIS_REFIT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<CoebisRefitSettings>;
    return {
      auto: parsed.auto !== false,
      debounceMs: clamp(parsed.debounceMs, 500, 120000, DEFAULT_COEBIS_REFIT_SETTINGS.debounceMs),
      minIntervalMs: clamp(
        parsed.minIntervalMs,
        0,
        3600000,
        DEFAULT_COEBIS_REFIT_SETTINGS.minIntervalMs,
      ),
    };
  } catch {
    return DEFAULT_COEBIS_REFIT_SETTINGS;
  }
}

export function writeCoebisRefitSettings(settings: CoebisRefitSettings) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(EVENT, { detail: settings }));
  } catch {
    /* storage unavailable (private mode) — preference is best-effort */
  }
}

/** Human label for a pacing duration. */
export function pacingLabel(ms: number): string {
  if (ms <= 0) return "no limit";
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60000)} min`;
}

/** Live settings, shared across every panel in the tab. */
export function useCoebisRefitSettings() {
  const [settings, setSettings] = useState<CoebisRefitSettings>(DEFAULT_COEBIS_REFIT_SETTINGS);

  useEffect(() => {
    setSettings(readCoebisRefitSettings());
    const sync = () => setSettings(readCoebisRefitSettings());
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const update = useCallback((patch: Partial<CoebisRefitSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      writeCoebisRefitSettings(next);
      return next;
    });
  }, []);

  return { settings, update };
}
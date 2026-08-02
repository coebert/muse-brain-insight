import { useCallback, useEffect, useState } from "react";

import {
  DEFAULT_QUALITY_THRESHOLDS,
  normaliseThresholds,
  type QualityThresholds,
} from "@/lib/eeg/coverage";

const STORAGE_KEY = "cortextrace.quality-thresholds.v1";

/**
 * Clinician-configurable data-quality thresholds, persisted per browser.
 * Reads storage after hydration so SSR and the first client render match.
 */
export function useQualityThresholds() {
  const [thresholds, setThresholds] = useState<QualityThresholds>(DEFAULT_QUALITY_THRESHOLDS);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) setThresholds(normaliseThresholds(JSON.parse(raw) as Partial<QualityThresholds>));
    } catch {
      /* ignore malformed storage */
    }
  }, []);

  const update = useCallback((patch: Partial<QualityThresholds>) => {
    setThresholds((prev) => {
      const next = normaliseThresholds({ ...prev, ...patch });
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });
  }, []);

  const reset = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* storage unavailable */
    }
    setThresholds(DEFAULT_QUALITY_THRESHOLDS);
  }, []);

  return { thresholds, update, reset };
}

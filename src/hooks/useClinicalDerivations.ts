import { useMemo } from "react";

import {
  deriveClinical,
  type ClinicalDerivationInput,
  type ClinicalDerivations,
} from "@/lib/eeg/derivations";

/**
 * Memoised wrapper around {@link deriveClinical} so alarms, DSA markers and
 * the AI panels all read one recomputed clinical picture per epoch.
 */
export function useClinicalDerivations(input: ClinicalDerivationInput): ClinicalDerivations {
  const {
    epochs,
    events,
    markers,
    hemi,
    settings,
    icuMode,
    dataGapSeconds,
    reconnecting,
    reconnectAttempt,
  } = input;
  return useMemo(
    () =>
      deriveClinical({
        epochs,
        events,
        markers,
        hemi,
        settings,
        icuMode,
        dataGapSeconds,
        reconnecting,
        reconnectAttempt: reconnectAttempt ?? null,
      }),
    [
      epochs,
      events,
      markers,
      hemi,
      settings,
      icuMode,
      dataGapSeconds,
      reconnecting,
      reconnectAttempt,
    ],
  );
}

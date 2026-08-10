import { useEffect, useState } from "react";

import {
  getSyncedBisAlignment,
  subscribeBisAlignment,
  syncBisAlignment,
  syncBisAlignmentIfStale,
} from "@/lib/eeg/bis-alignment";
import type { BisAlignment } from "@/lib/eeg/depth";

/** How often a running case checks whether a newer COEBIS model exists. */
const REFRESH_MS = 5 * 60_000;

/**
 * The COEBIS model currently driving the live index. COEBIS keeps being
 * refitted as paired commercial-BIS readings accumulate, so a case that is
 * already running picks up a newer model without a reload: this hook keeps
 * the estimator on the latest active fit and re-renders the tiles that show
 * which version is in use.
 */
export function useCoebisModel(): BisAlignment | null {
  const [model, setModel] = useState<BisAlignment | null>(() => getSyncedBisAlignment());

  useEffect(() => {
    let alive = true;
    const unsubscribe = subscribeBisAlignment((next) => {
      if (alive) setModel(next);
    });

    void syncBisAlignmentIfStale(REFRESH_MS).then((next) => {
      if (alive) setModel(next);
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void syncBisAlignment();
    }, REFRESH_MS);

    // A refit usually finishes while the clinician is on another screen or
    // device, so check again the moment this one comes back into view.
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncBisAlignmentIfStale(60_000);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, []);

  return model;
}

/** Short "learned from N readings" line for the COEBIS tiles. */
export function describeCoebisModel(model: BisAlignment | null): string {
  if (!model) return "Learning — needs paired commercial BIS readings";
  const fitted = new Date(model.fittedAt);
  const when = Number.isNaN(fitted.getTime())
    ? ""
    : ` · fitted ${fitted.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}`;
  return `Model v${model.n} readings${when}`;
}

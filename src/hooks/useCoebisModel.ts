import { activeLineageKey } from "@/lib/eeg/model-lineage";
import { useCallback, useEffect, useState } from "react";

import {
  fetchBisAlignmentHistory,
  getLatestBisAlignment,
  getSyncedBisAlignment,
  isBisAlignmentPinned,
  pinBisAlignment,
  subscribeBisAlignment,
  syncBisAlignment,
  syncBisAlignmentIfStale,
} from "@/lib/eeg/bis-alignment";
import type { BisAlignment } from "@/lib/eeg/depth";
import { getBisDrift } from "@/lib/eeg/bis-drift.functions";

/** How often a running case checks whether a newer COEBIS model exists. */
const REFRESH_MS = 5 * 60_000;

/**
 * With no model stored, nothing on the bedside screens ever asks the server to
 * try fitting one — a clinician could log paired readings for weeks and still
 * see a dash. Ask once per page load when there is no model yet; the server
 * fits only if the paired data supports it.
 */
let fitAttempted = false;
async function fitIfNoModelYet(): Promise<BisAlignment | null> {
  if (fitAttempted || getSyncedBisAlignment()) return null;
  fitAttempted = true;
  try {
    await getBisDrift({ data: { lineage: activeLineageKey() } });
  } catch {
    return null;
  }
  return syncBisAlignment();
}

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
      if (next) return;
      void fitIfNoModelYet().then((fitted) => {
        if (alive && fitted) setModel(fitted);
      });
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

/** Version label for a fit, e.g. `v4`. */
export function coebisVersionLabel(model: BisAlignment | null): string {
  if (!model) return "no model";
  return model.version ? `v${model.version}` : "v?";
}

/** Short "model v4 · N readings" line for the COEBIS tiles. */
export function describeCoebisModel(model: BisAlignment | null): string {
  if (!model) return "Baseline (uncalibrated) — learning from paired commercial BIS readings";
  const fitted = new Date(model.fittedAt);
  const when = Number.isNaN(fitted.getTime())
    ? ""
    : ` · fitted ${fitted.toLocaleDateString(undefined, { day: "2-digit", month: "short" })}`;
  const pinned = model.version && !model.isActive ? " · pinned for comparison" : "";
  const provisional = model.provisional ? " · provisional" : "";
  return `Model ${coebisVersionLabel(model)}${provisional} · ${model.n} readings${when}${pinned}`;
}

/**
 * Every fitted COEBIS version plus the pin controls, so a clinician can hold
 * the display on an older model and compare it against the current one.
 */
export function useCoebisModelVersions() {
  const active = useCoebisModel();
  const [versions, setVersions] = useState<BisAlignment[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    const list = await fetchBisAlignmentHistory();
    setVersions(list);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const select = useCallback(
    (id: string | null) => {
      if (!id) {
        pinBisAlignment(null);
        return;
      }
      const next = versions.find((v) => v.id === id);
      if (!next) return;
      // Pinning the newest fit is the same as running live, so release instead.
      pinBisAlignment(next.id === getLatestBisAlignment()?.id ? null : next);
    },
    [versions],
  );

  return {
    active,
    latest: getLatestBisAlignment(),
    pinned: isBisAlignmentPinned(),
    versions,
    loading,
    select,
    reload,
  };
}

import { useEffect, useState } from "react";

import {
  getSyncedSefAlignment,
  onSefAlignmentChange,
  syncSefAlignment,
  syncSefAlignmentIfStale,
} from "@/lib/eeg/sef-alignment";
import { getSefDrift } from "@/lib/eeg/sef-drift.functions";
import type { SefAlignment } from "@/lib/eeg/sef-drift";

/** How often a running case checks for a newer SEF correction. */
const REFRESH_MS = 5 * 60_000;

/**
 * With no correction stored, nothing would ever ask the server to fit one, so
 * try once per page load. The server only activates a fit when the paired
 * readings support it.
 */
let fitAttempted = false;
async function fitIfNoModelYet(): Promise<SefAlignment | null> {
  if (fitAttempted || getSyncedSefAlignment()) return null;
  fitAttempted = true;
  try {
    await getSefDrift({});
  } catch {
    return null;
  }
  return syncSefAlignment();
}

/**
 * The SEF correction currently in force. Keeps the live analyzer on the latest
 * fitted map so a running case picks up a refit without a reload.
 */
export function useSefAlignment(): SefAlignment | null {
  const [model, setModel] = useState<SefAlignment | null>(() => getSyncedSefAlignment());

  useEffect(() => {
    let alive = true;
    const unsubscribe = onSefAlignmentChange((next) => {
      if (alive) setModel(next);
    });

    void syncSefAlignmentIfStale(REFRESH_MS).then((next) => {
      if (alive) setModel(next);
      if (next) return;
      void fitIfNoModelYet().then((fitted) => {
        if (alive && fitted) setModel(fitted);
      });
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void syncSefAlignment();
    }, REFRESH_MS);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(interval);
    };
  }, []);

  return model;
}
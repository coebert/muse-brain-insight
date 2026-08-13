/**
 * Automatic COEBIS recompute.
 *
 * Paired commercial-BIS values used to reach the pooled fit only when a case
 * was filed, so a COEBIS refit lagged behind the bedside by a whole case. This
 * hook files each newly pairable reading as it is entered during the running
 * case and immediately refits COEBIS (and the SEF alignment) from the pooled
 * data, so the displayed number reflects every reading already logged.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { Epoch } from "@/lib/eeg/analysis";
import { pairBisReadings, type BisReading } from "@/lib/eeg/bis";
import { getBisDrift, recordBisPoints } from "@/lib/eeg/bis-drift.functions";
import { getSefDrift } from "@/lib/eeg/sef-drift.functions";
import { getLatestBisAlignment, syncBisAlignment } from "@/lib/eeg/bis-alignment";
import { syncSefAlignment } from "@/lib/eeg/sef-alignment";

/** Settle time so a burst of transcribed readings files as one batch. */
const DEBOUNCE_MS = 4000;

export interface AutoCoebisRefit {
  /** A live file-and-refit cycle is in flight. */
  running: boolean;
  /** Readings already filed for this case (not re-filed on save). */
  filedIds: string[];
  /** Marks readings as filed without re-sending them (used after a save). */
  markFiled: (ids: string[]) => void;
  /** Clears the ledger when a new case starts. */
  reset: () => void;
}

export function useAutoCoebisRefit(opts: {
  enabled: boolean;
  epochs: Epoch[];
  readings: BisReading[];
  context?: string | null;
  /** Session id once the case has been filed; null while it is running. */
  sessionId?: string | null;
}): AutoCoebisRefit {
  const { enabled, epochs, readings, context, sessionId } = opts;
  const fileBisPoints = useServerFn(recordBisPoints);
  const refreshCoebis = useServerFn(getBisDrift);
  const refreshSef = useServerFn(getSefDrift);

  const [running, setRunning] = useState(false);
  const filedRef = useRef<Set<string>>(new Set());
  const [filedIds, setFiledIds] = useState<string[]>([]);
  const busyRef = useRef(false);

  // Latest inputs, read at fire time so the debounce timer never captures a
  // stale epoch list.
  const stateRef = useRef({ epochs, readings, context, sessionId, enabled });
  stateRef.current = { epochs, readings, context, sessionId, enabled };

  const markFiled = useCallback((ids: string[]) => {
    ids.forEach((id) => filedRef.current.add(id));
    setFiledIds([...filedRef.current]);
  }, []);

  const reset = useCallback(() => {
    filedRef.current = new Set();
    setFiledIds([]);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const pending = readings.filter((r) => !filedRef.current.has(r.id));
    if (!pending.length) return;

    const timer = setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        const s = stateRef.current;
        const unfiled = s.readings.filter((r) => !filedRef.current.has(r.id));
        if (!unfiled.length) return;
        // Only readings that line up with an epoch carrying a depth index can
        // contribute to the fit; the rest stay pending until an epoch lands.
        const byId = new Map(unfiled.map((r) => [r.at, r] as const));
        const points = pairBisReadings(s.epochs, unfiled)
          .filter((p) => p.depthIndex != null)
          .map((p) => ({
            at: p.at,
            bis: p.bis,
            bisSr: p.bisSr,
            bisSef: p.bisSef,
            appIndex: p.depthIndex!,
            appSr: p.appSr,
            // File the raw headband SEF: the displayed value already carries
            // the active correction and would fold back into the next fit.
            appSef: p.sef95Raw ?? p.sef95,
            reliable: p.reliable,
            sqi: p.sqi,
          }));
        if (!points.length) return;

        busyRef.current = true;
        setRunning(true);
        const before = getLatestBisAlignment()?.id ?? null;
        try {
          await fileBisPoints({
            data: {
              sessionId: s.sessionId ?? null,
              context: s.context ?? null,
              device: s.readings.find((r) => r.device)?.device ?? null,
              points,
            },
          });
          markFiled(points.map((p) => byId.get(p.at)?.id).filter((id): id is string => !!id));
          await refreshCoebis({});
          const model = await syncBisAlignment();
          try {
            await refreshSef({});
            await syncSefAlignment();
          } catch {
            // SEF alignment is secondary; a failure must not block COEBIS.
          }
          if (model?.id && model.id !== before) {
            toast.success(
              `COEBIS updated from ${model.n ?? points.length} paired readings${
                model.provisional ? " (provisional)" : ""
              }.`,
            );
          }
        } catch {
          // Silent: the reading stays pending and is filed with the case.
        } finally {
          busyRef.current = false;
          setRunning(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [enabled, readings, epochs, fileBisPoints, refreshCoebis, refreshSef, markFiled]);

  return { running, filedIds, markFiled, reset };
}

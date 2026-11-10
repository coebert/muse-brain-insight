/**
 * Automatic COEBIS candidate filing.
 *
 * Each newly pairable commercial-BIS reading is filed as it is entered during
 * the running case, and a candidate refit is requested from the pooled data.
 * The candidate is NEVER put in force mid-recording: the models in use are
 * frozen for the whole recording (see model-freeze.ts), so a refit that lands
 * now takes effect from the next recording. Every number on the running
 * case's trend therefore comes from one model version.
 */

import { activeLineageKey } from "@/lib/eeg/model-lineage";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import type { Epoch } from "@/lib/eeg/analysis";
import { pairBisReadings, type BisReading } from "@/lib/eeg/bis";
import { getBisDrift, recordBisPoints } from "@/lib/eeg/bis-drift.functions";
import { getSefDrift } from "@/lib/eeg/sef-drift.functions";
import {
  getLatestBisAlignment,
  getPendingBisAlignment,
  syncBisAlignment,
} from "@/lib/eeg/bis-alignment";
import { syncSefAlignment } from "@/lib/eeg/sef-alignment";
import { useCoebisRefitSettings } from "@/lib/eeg/coebis-refit-settings";
import { recordCoebisRefit } from "@/lib/eeg/coebis-refit-log";

export interface AutoCoebisRefit {
  /** A live file-and-refit cycle is in flight. */
  running: boolean;
  /** Readings waiting for the settle/throttle window to elapse. */
  pendingCount: number;
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
  const { settings } = useCoebisRefitSettings();
  const fileBisPoints = useServerFn(recordBisPoints);
  const refreshCoebis = useServerFn(getBisDrift);
  const refreshSef = useServerFn(getSefDrift);

  const [running, setRunning] = useState(false);
  const filedRef = useRef<Set<string>>(new Set());
  const [filedIds, setFiledIds] = useState<string[]>([]);
  const busyRef = useRef(false);
  const lastRunRef = useRef(0);

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
    if (!enabled || !settings.auto) return;
    const pending = readings.filter((r) => !filedRef.current.has(r.id));
    if (!pending.length) return;

    // Two pacing strategies share the same two numbers:
    //  - debounce: settle the burst, then respect the minimum spacing;
    //  - throttle: ignore the settle delay and fire on a fixed cadence, so a
    //    continuous stream of readings cannot keep postponing the refit.
    const sinceLast = Date.now() - lastRunRef.current;
    const throttleWait = Math.max(0, settings.minIntervalMs - sinceLast);
    const wait =
      settings.mode === "throttle"
        ? throttleWait
        : Math.max(settings.debounceMs, throttleWait);

    const timer = setTimeout(() => {
      void (async () => {
        if (busyRef.current) return;
        if (Date.now() - lastRunRef.current < settings.minIntervalMs) return;
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
            depthConfidence: p.depthConfidence,
            stability: p.stability ?? null,
            lagSeconds: p.lagSeconds ?? null,
          }));
        if (!points.length) return;

        busyRef.current = true;
        lastRunRef.current = Date.now();
        setRunning(true);
        const beforeModel = getLatestBisAlignment();
        const before = beforeModel?.id ?? null;
        try {
          await fileBisPoints({
            data: {
              sessionId: s.sessionId ?? null,
              context: s.context ?? null,
              device: s.readings.find((r) => r.device)?.device ?? null,
              points,
              lineage: activeLineageKey(),
            },
          });
          markFiled(points.map((p) => byId.get(p.at)?.id).filter((id): id is string => !!id));
          await refreshCoebis({ data: { lineage: activeLineageKey() } });
          // Frozen while recording: this fetches the candidate but holds it.
          await syncBisAlignment();
          const candidate = getPendingBisAlignment() ?? getLatestBisAlignment();
          recordCoebisRefit({
            trigger: "auto",
            before: beforeModel,
            after: candidate,
            changed: !!candidate?.id && candidate.id !== before,
          });
          try {
            await refreshSef({});
            await syncSefAlignment();
          } catch {
            // SEF alignment is secondary; a failure must not block COEBIS.
          }
          if (candidate?.id && candidate.id !== before) {
            toast.info(
              `New COEBIS candidate from ${candidate.n ?? points.length} paired readings${
                candidate.provisional ? " (provisional)" : ""
              } — it will be used from the next recording. This case stays on the model it started with.`,
            );
          }
        } catch {
          // Silent: the reading stays pending and is filed with the case.
        } finally {
          busyRef.current = false;
          lastRunRef.current = Date.now();
          setRunning(false);
        }
      })();
    }, wait);

    return () => clearTimeout(timer);
  }, [
    enabled,
    readings,
    epochs,
    fileBisPoints,
    refreshCoebis,
    refreshSef,
    markFiled,
    settings.auto,
    settings.mode,
    settings.debounceMs,
    settings.minIntervalMs,
  ]);

  const pendingCount = readings.filter((r) => !filedIds.includes(r.id)).length;

  return { running, pendingCount, filedIds, markFiled, reset };
}
